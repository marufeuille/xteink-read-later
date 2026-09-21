import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { MAX_PURCHASED_EPUB_BYTES } from '../src/http/purchased-book'
import { createMemoryStore } from '../src/store/memory'
import { articleIdFromBytes } from '../src/types'
import {
  basicAuthorization,
  bearerAuthorization,
  TEST_BINDINGS,
  TEST_CLIP_TOKEN,
} from './bindings'

const BINDINGS = TEST_BINDINGS

function zipEpub(): Uint8Array {
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>',
    ),
  })
}

function appWithStore(store = createMemoryStore()) {
  return { app: createApp({ store }), store }
}

async function upload(
  app: ReturnType<typeof createApp>,
  fields: { title?: string; author?: string; epub?: Blob; path?: string },
): Promise<Response> {
  const form = new FormData()
  if (fields.title !== undefined) {
    form.set('title', fields.title)
  }
  if (fields.author !== undefined) {
    form.set('author', fields.author)
  }
  if (fields.epub !== undefined) {
    form.set('epub', fields.epub, 'book.epub')
  }
  return app.request(
    fields.path ?? '/books',
    {
      method: 'POST',
      headers: { authorization: bearerAuthorization() },
      body: form,
    },
    BINDINGS,
  )
}

describe('POST /books', () => {
  it('rejects missing CLIP_TOKEN', async () => {
    const { app } = appWithStore()
    const form = new FormData()
    form.set('title', 'Dummy title')
    form.set('epub', new Blob([zipEpub()]), 'book.epub')
    const response = await app.request(
      '/books',
      { method: 'POST', body: form },
      BINDINGS,
    )
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(TEST_CLIP_TOKEN)
  })

  it('stores the EPUB, lists it in OPDS, and does not fetch or translate', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const { app } = appWithStore()
      const bytes = zipEpub()
      const response = await upload(app, {
        title: 'Dummy purchased title',
        author: 'Dummy author',
        epub: new Blob([bytes]),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        id: string
        title: string
        translated: boolean
        status: string
        canonicalUrl: string
      }
      expect(body.status).toBe('ready')
      expect(body.translated).toBe(false)
      expect(body.title).toBe('Dummy purchased title')
      expect(body.id).toBe(await articleIdFromBytes(bytes))
      expect(body.canonicalUrl).toContain('purchased.invalid')
      expect(fetchSpy).not.toHaveBeenCalled()

      const catalog = await app.request(
        'https://read.example.com/opds',
        { headers: { authorization: basicAuthorization() } },
        BINDINGS,
      )
      expect(catalog.status).toBe(200)
      const xml = await catalog.text()
      expect(xml).toContain('https://read.example.com/opds/ebook')
      expect(xml).not.toContain('Dummy purchased title')
      const shelf = await app.request(
        'https://read.example.com/opds/ebook',
        { headers: { authorization: basicAuthorization() } },
        BINDINGS,
      )
      const dateHref = /href="(https:\/\/read\.example\.com\/opds\/ebook\/\d{4}-\d{2}-\d{2})"/.exec(
        await shelf.text(),
      )?.[1]
      expect(dateHref).toBeDefined()
      const day = await app.request(dateHref ?? '', { headers: { authorization: basicAuthorization() } }, BINDINGS)
      const dayXml = await day.text()
      expect(dayXml).toContain('Dummy purchased title')
      expect(dayXml).toContain(`opds/download/${body.id}.epub`)

      const metaRes = await app.request(
        `https://read.example.com/articles/${body.id}`,
        { headers: { authorization: basicAuthorization() } },
        BINDINGS,
      )
      expect(metaRes.status).toBe(200)
      expect(
        ((await metaRes.json()) as { classification: { status: string; topic: string } }).classification,
      ).toMatchObject({ status: 'skipped', topic: 'uncategorized' })

      const download = await app.request(
        `https://read.example.com/opds/download/${body.id}.epub`,
        { headers: { authorization: basicAuthorization() } },
        BINDINGS,
      )
      expect(download.status).toBe(200)
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('accepts a trailing slash and overwrites the same EPUB bytes', async () => {
    const { app } = appWithStore()
    const bytes = zipEpub()
    const first = await upload(app, {
      title: 'First title',
      epub: new Blob([bytes]),
      path: '/books/',
    })
    const second = await upload(app, {
      title: 'Second title',
      epub: new Blob([bytes]),
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstBody = (await first.json()) as { id: string }
    const secondBody = (await second.json()) as { id: string; title: string }
    expect(secondBody.id).toBe(firstBody.id)
    expect(secondBody.title).toBe('Second title')
  })

  it('returns 400 for a missing title or a non-zip upload', async () => {
    const { app } = appWithStore()
    const missingTitle = await upload(app, { epub: new Blob([zipEpub()]) })
    expect(missingTitle.status).toBe(400)
    expect(((await missingTitle.json()) as { error: { code: string } }).error.code).toBe('invalid_epub')

    const notZip = await upload(app, {
      title: 'Dummy title',
      epub: new Blob([new Uint8Array([1, 2, 3, 4])]),
    })
    expect(notZip.status).toBe(400)
    expect(((await notZip.json()) as { error: { code: string } }).error.code).toBe('invalid_epub')
  })

  it('returns 413 when the EPUB exceeds the size cap', async () => {
    const { app } = appWithStore()
    const huge = new Uint8Array(MAX_PURCHASED_EPUB_BYTES + 1)
    huge[0] = 0x50
    huge[1] = 0x4b
    huge[2] = 0x03
    huge[3] = 0x04
    const response = await upload(app, { title: 'Dummy title', epub: new Blob([huge]) })
    expect(response.status).toBe(413)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('payload_too_large')
  })
})
