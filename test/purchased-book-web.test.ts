import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { createMemoryStore } from '../src/store/memory'
import { articleIdFromBytes } from '../src/types'
import {
  accessIdentity,
  basicAuthorization,
  bearerAuthorization,
  TEST_BINDINGS,
  TEST_CLIP_TOKEN,
} from './bindings'

const CHAPTER = 'CHAPTER_BODY_SHOULD_NOT_APPEAR'

function purchasedEpub(input: { title?: string; creator?: string } = {}): Uint8Array {
  const title = input.title === undefined ? '' : `<dc:title>${input.title}</dc:title>`
  const creator = input.creator === undefined ? '' : `<dc:creator>${input.creator}</dc:creator>`
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata>${title}${creator}</metadata></package>`,
    ),
    'OEBPS/chapter.xhtml': strToU8(CHAPTER),
  })
}

function appWith() {
  const store = createMemoryStore()
  const app = createApp({ store, ...accessIdentity() })
  return { app, store }
}

function csrfFrom(html: string): string {
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]
  if (csrf === undefined) {
    throw new Error('csrf missing')
  }
  return csrf
}

async function page(app: ReturnType<typeof createApp>, env: Cloudflare.Env): Promise<string> {
  const response = await app.request('/books', { headers: { accept: 'text/html' } }, env)
  expect(response.status).toBe(200)
  return response.text()
}

describe('purchased book web', () => {
  it('uses dc:title and dc:creator, keeps the file bytes, and lists the ebook shelf', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
    try {
      const { app } = appWith()
      const html = await page(app, TEST_BINDINGS)
      expect(html).toContain('OPDS の ebook 棚に出ます')
      expect(html).toContain('載せる')
      expect(html).not.toContain(TEST_CLIP_TOKEN)
      const bytes = purchasedEpub({ title: 'Cats &amp; Dogs', creator: 'Package Author' })
      const form = new FormData()
      form.set('csrf', csrfFrom(html))
      form.set('epub', new Blob([bytes]), 'book.epub')
      const response = await app.request(
        '/books',
        { method: 'POST', headers: { accept: 'text/html' }, body: form },
        TEST_BINDINGS,
      )
      expect(response.status).toBe(200)
      const result = await response.text()
      expect(result).toContain('OPDS の ebook 棚に出ます')
      expect(result).toContain('Cats &amp; Dogs')
      expect(result).toContain('Package Author')
      expect(result).not.toContain(CHAPTER)
      expect(result).not.toContain(TEST_CLIP_TOKEN)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(logs.join('\n')).not.toContain(TEST_CLIP_TOKEN)
      expect(logs.join('\n')).not.toContain(CHAPTER)

      const id = await articleIdFromBytes(bytes)
      const meta = await app.request(
        `/articles/${id}`,
        { headers: { authorization: basicAuthorization() } },
        TEST_BINDINGS,
      )
      expect(meta.status).toBe(200)
      const body = (await meta.json()) as {
        title: string
        author: string | null
        translated: boolean
        createdAt: string
        canonicalUrl: string
        classification: { status: string }
      }
      expect(body.title).toBe('Cats & Dogs')
      expect(body.author).toBe('Package Author')
      expect(body.translated).toBe(false)
      expect(body.classification.status).toBe('skipped')
      expect(body.canonicalUrl).toContain('purchased.invalid')

      const download = await app.request(
        `/opds/download/${id}.epub`,
        { headers: { authorization: basicAuthorization() } },
        TEST_BINDINGS,
      )
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)

      const shelf = await app.request(
        'https://read.example/opds/ebook',
        { headers: { authorization: basicAuthorization() } },
        TEST_BINDINGS,
      )
      const dateHref = /href="(https:\/\/read\.example\/opds\/ebook\/\d{4}-\d{2}-\d{2})"/.exec(await shelf.text())?.[1]
      const day = await app.request(dateHref ?? '', { headers: { authorization: basicAuthorization() } }, TEST_BINDINGS)
      expect(await day.text()).toContain('Cats &amp; Dogs')

      const again = new FormData()
      again.set('csrf', csrfFrom(html))
      again.set('title', 'Second title')
      again.set('epub', new Blob([bytes]), 'book.epub')
      const overwritten = await app.request(
        '/books/',
        { method: 'POST', headers: { accept: 'text/html' }, body: again },
        TEST_BINDINGS,
      )
      expect(overwritten.status).toBe(200)
      expect(await overwritten.text()).toContain('Second title')
      const second = (await (
        await app.request(`/articles/${id}`, { headers: { authorization: basicAuthorization() } }, TEST_BINDINGS)
      ).json()) as { title: string; createdAt: string; author: string | null }
      expect(second.title).toBe('Second title')
      expect(second.author).toBe('Package Author')
      expect(second.createdAt).toBe(body.createdAt)
    } finally {
      fetchSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('prefers a typed author and allows an empty author when the package has none', async () => {
    const { app } = appWith()
    const html = await page(app, TEST_BINDINGS)
    const bytes = purchasedEpub({ title: 'Only title', creator: 'Package Author' })
    const form = new FormData()
    form.set('csrf', csrfFrom(html))
    form.set('author', 'Typed Author')
    form.set('epub', new Blob([bytes]), 'book.epub')
    const typed = await app.request(
      '/books',
      { method: 'POST', headers: { accept: 'text/html' }, body: form },
      TEST_BINDINGS,
    )
    expect(typed.status).toBe(200)
    expect(await typed.text()).toContain('Typed Author')

    const noAuthor = new FormData()
    noAuthor.set('csrf', csrfFrom(html))
    noAuthor.set('title', 'Manual title')
    noAuthor.set('epub', new Blob([purchasedEpub()]), 'bare.epub')
    const bare = await app.request(
      '/books',
      { method: 'POST', headers: { accept: 'text/html' }, body: noAuthor },
      TEST_BINDINGS,
    )
    expect(bare.status).toBe(200)
    const bareHtml = await bare.text()
    expect(bareHtml).toContain('Manual title')
    expect(bareHtml).not.toContain('著者:')
  })

  it('rejects a package without dc:title, a bad CSRF token, and a non-zip file', async () => {
    const { app, store } = appWith()
    const html = await page(app, TEST_BINDINGS)
    const missing = new FormData()
    missing.set('csrf', csrfFrom(html))
    missing.set('epub', new Blob([purchasedEpub()]), 'book.epub')
    const rejected = await app.request(
      '/books',
      { method: 'POST', headers: { accept: 'text/html' }, body: missing },
      TEST_BINDINGS,
    )
    expect(rejected.status).toBe(400)
    expect(rejected.headers.get('content-type')).toContain('text/html')
    expect(await rejected.text()).not.toContain(TEST_CLIP_TOKEN)
    expect(await store.listMeta()).toEqual([])

    const forged = new FormData()
    forged.set('csrf', 'not-the-token')
    forged.set('title', 'Nope')
    forged.set('epub', new Blob([purchasedEpub({ title: 'Nope' })]), 'book.epub')
    const csrf = await app.request(
      '/books',
      { method: 'POST', headers: { accept: 'text/html' }, body: forged },
      TEST_BINDINGS,
    )
    expect(csrf.status).toBe(403)
    expect(await store.listMeta()).toEqual([])

    const text = new FormData()
    text.set('csrf', csrfFrom(html))
    text.set('epub', new Blob(['hello']), 'notes.txt')
    const notZip = await app.request(
      '/books',
      { method: 'POST', headers: { accept: 'text/html' }, body: text },
      TEST_BINDINGS,
    )
    expect(notZip.status).toBe(400)
    expect(await notZip.text()).not.toContain('hello')
  })

  it('asks for Google on the HTML page and keeps Bearer JSON for curl', async () => {
    const open = createApp({ store: createMemoryStore() })
    const html = await open.request('/books', { headers: { accept: 'text/html' } }, TEST_BINDINGS)
    expect(html.status).toBe(401)
    expect(await html.text()).toContain('Google アカウントで入る')

    const curl = await open.request('/books', { method: 'POST' }, TEST_BINDINGS)
    expect(curl.status).toBe(401)
    expect(curl.headers.get('www-authenticate')).toBe('Bearer')

    const { app } = appWith()
    const form = new FormData()
    form.set('title', 'Bearer title')
    form.set('epub', new Blob([purchasedEpub({ title: 'Ignored' })]), 'book.epub')
    const api = await app.request(
      '/books',
      { method: 'POST', headers: { authorization: bearerAuthorization() }, body: form },
      TEST_BINDINGS,
    )
    expect(api.status).toBe(200)
    expect(((await api.json()) as { title: string; author: string | null }).title).toBe('Bearer title')
  })
})
