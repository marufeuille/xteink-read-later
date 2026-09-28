import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'
import { decode } from 'jpeg-js'
import { describe, expect, it, vi } from 'vitest'
import { buildEpub } from '../src/epub/build-epub'
import { embedX3Images, isX3BaselineJpeg } from '../src/epub/x3-image'
import { X3_IMAGE_MAX_HEIGHT, X3_IMAGE_MAX_WIDTH, X3_IMAGE_QUALITY } from '../src/images/x3-token'
import { parseHttpUrl, type TranslatedArticle } from '../src/types'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function jpeg(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixtures, name)))
}

function article(contentHtml: string): TranslatedArticle {
  const url = parseHttpUrl('https://example.com/post')
  if (url === null) {
    throw new Error('fixture url')
  }
  return {
    title: '記事',
    author: null,
    publishedAt: null,
    sourceUrl: url,
    canonicalUrl: url,
    contentHtml,
    language: 'ja',
    translated: false,
  }
}

describe('isX3BaselineJpeg', () => {
  it('accepts a small baseline JPEG and rejects progressive or wide files', () => {
    expect(isX3BaselineJpeg(jpeg('x3-baseline.jpg'))).toBe(true)
    expect(isX3BaselineJpeg(jpeg('x3-progressive.jpg'))).toBe(false)
    expect(isX3BaselineJpeg(jpeg('x3-wide.jpg'))).toBe(false)
  })
})

describe('embedX3Images', () => {
  const block = '<p>本文</p><p><img src="https://cdn.example.com/photo.jpg" alt=""/></p>'

  it('embeds a baseline JPEG and asks Cloudflare to resize it for the X3', async () => {
    const bytes = jpeg('x3-baseline.jpg')
    const fetchImage = vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    const embedded = await embedX3Images(block, fetchImage)
    expect(embedded.html).toBe('<p>本文</p><p><img src="images/fig-1.jpg" alt=""/></p>')
    expect(embedded.images).toEqual([{ id: 'fig-1', href: 'images/fig-1.jpg', bytes }])
    expect(fetchImage).toHaveBeenCalledWith(
      'https://cdn.example.com/photo.jpg',
      expect.objectContaining({
        cf: {
          image: {
            width: X3_IMAGE_MAX_WIDTH,
            height: X3_IMAGE_MAX_HEIGHT,
            fit: 'scale-down',
            format: 'baseline-jpeg',
            quality: X3_IMAGE_QUALITY,
          },
        },
      }),
    )

    const files = unzipSync(
      await buildEpub(article(embedded.html), { images: embedded.images }),
    )
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())
    expect(chapter).toContain('<img src="images/fig-1.jpg" alt=""/>')
    expect(chapter).not.toContain('digest-qr')
    expect(chapter).not.toContain('cdn.example.com')
    expect(opf).toContain('media-type="image/jpeg"')
    expect(files['OEBPS/images/fig-1.jpg']).toEqual(bytes)
  })

  it('re-encodes a progressive JPEG and an oversized JPEG, and still drops a private host', async () => {
    const progressive = jpeg('x3-progressive.jpg')
    const fetchImage = vi.fn(async (url: string) => {
      if (url.endsWith('progressive.jpg')) {
        return new Response(progressive, { status: 200 })
      }
      if (url.endsWith('wide.jpg')) {
        return new Response(jpeg('x3-wide.jpg'), { status: 200 })
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 })
    })
    const html =
      '<p><img src="https://cdn.example.com/progressive.jpg" alt=""/></p>' +
      '<p><img src="https://cdn.example.com/wide.jpg" alt=""/></p>' +
      '<p><img src="https://cdn.example.com/pixel.png" alt=""/></p>' +
      '<p><img src="http://127.0.0.1/secret.jpg" alt=""/></p>' +
      '<p>本文は残る</p>'
    const embedded = await embedX3Images(html, fetchImage)
    expect(embedded.html).toBe(
      '<p><img src="images/fig-1.jpg" alt=""/></p><p><img src="images/fig-2.jpg" alt=""/></p><p>本文は残る</p>',
    )
    expect(embedded.images).toHaveLength(2)
    const progressiveOut = embedded.images[0]?.bytes ?? new Uint8Array()
    const wideOut = embedded.images[1]?.bytes ?? new Uint8Array()
    expect(isX3BaselineJpeg(progressiveOut)).toBe(true)
    expect(progressiveOut).not.toEqual(progressive)
    expect(decode(progressiveOut, { useTArray: true }).width).toBe(120)
    expect(decode(progressiveOut, { useTArray: true }).height).toBe(80)
    expect(isX3BaselineJpeg(wideOut)).toBe(true)
    const wide = decode(wideOut, { useTArray: true })
    expect(wide.width).toBe(448)
    expect(wide.height).toBe(56)
    expect(fetchImage).not.toHaveBeenCalledWith('http://127.0.0.1/secret.jpg', expect.anything())
    expect(fetchImage).toHaveBeenCalledTimes(3)
  })

  it('fetches the original JPEG when Cloudflare image resizing fails', async () => {
    const progressive = jpeg('x3-progressive.jpg')
    const url = 'https://media.x.ai/cdn-cgi/image/f=auto/v1/website/photo.jpg'
    const fetchImage = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.cf !== undefined) {
        return new Response('resize failed', { status: 400 })
      }
      return new Response(progressive, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    })
    const embedded = await embedX3Images(`<p><img src="${url}" alt=""/></p>`, fetchImage)
    expect(embedded.images).toHaveLength(1)
    expect(isX3BaselineJpeg(embedded.images[0]?.bytes ?? new Uint8Array())).toBe(true)
    expect(fetchImage).toHaveBeenCalledTimes(2)
    expect(fetchImage).toHaveBeenNthCalledWith(2, url, expect.not.objectContaining({ cf: expect.anything() }))
  })

  it('keeps the digest QR class on JPEG images', async () => {
    const files = unzipSync(
      await buildEpub(article('<p><img src="images/qr-cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg" alt="全文を送る"/></p>'), {
        images: [
          {
            id: 'qr-cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            href: 'images/qr-cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg',
            bytes: jpeg('x3-baseline.jpg'),
          },
        ],
      }),
    )
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('class="digest-qr"')
    expect(strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())).toContain('media-type="image/jpeg"')
  })
})
