import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { createMemoryStore } from '../../src/store/memory'
import { accessIdentity, basicAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from '../bindings'
import { installNetworkMock } from './mock-network'

const CHAPTER = 'LIVE_CHAPTER_TEXT'

function epub(): Uint8Array {
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(
      '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Shelf title</dc:title></metadata></package>',
    ),
    'OEBPS/chapter.xhtml': strToU8(CHAPTER),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('purchased book web e2e', () => {
  it('uploads from the browser form onto the ebook shelf', async () => {
    const network = installNetworkMock({ pages: {} })
    const store = createMemoryStore()
    const app = createApp({ store, ...accessIdentity() })
    const opened = await app.request(
      'https://read.example/books',
      { headers: { accept: 'text/html' } },
      TEST_BINDINGS,
    )
    expect(opened.status).toBe(200)
    const html = await opened.text()
    expect(html).toContain('type="file"')
    expect(html).not.toContain(TEST_CLIP_TOKEN)
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''
    const bytes = epub()
    const form = new FormData()
    form.set('csrf', csrf)
    form.set('epub', new Blob([bytes]), 'bought.epub')
    const posted = await app.request(
      'https://read.example/books',
      { method: 'POST', headers: { accept: 'text/html' }, body: form },
      TEST_BINDINGS,
    )
    expect(posted.status).toBe(200)
    const done = await posted.text()
    expect(done).toContain('OPDS の ebook 棚に出ます')
    expect(done).toContain('Shelf title')
    expect(done).not.toContain(CHAPTER)
    expect(network.fetchedUrls).toEqual([])

    const shelf = await app.request(
      'https://read.example/opds/ebook',
      { headers: { authorization: basicAuthorization() } },
      TEST_BINDINGS,
    )
    const dateHref = /href="(https:\/\/read\.example\/opds\/ebook\/\d{4}-\d{2}-\d{2})"/.exec(await shelf.text())?.[1]
    const day = await app.request(dateHref ?? '', { headers: { authorization: basicAuthorization() } }, TEST_BINDINGS)
    const dayXml = await day.text()
    expect(dayXml).toContain('Shelf title')
    const id = /opds\/download\/(art_[a-f0-9]{32})\.epub/.exec(dayXml)?.[1]
    const download = await app.request(
      `https://read.example/opds/download/${id}.epub`,
      { headers: { authorization: basicAuthorization() } },
      TEST_BINDINGS,
    )
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
    expect(network.fetchedUrls).toEqual([])
  })
})
