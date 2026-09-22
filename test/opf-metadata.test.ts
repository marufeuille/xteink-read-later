import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readEpubPackageMetadata } from '../src/epub/opf-metadata'

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

function epub(files: Record<string, string | Uint8Array>): Uint8Array {
  const zipped: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  }
  for (const [name, value] of Object.entries(files)) {
    zipped[name] = typeof value === 'string' ? strToU8(value) : value
  }
  return zipSync(zipped)
}

describe('readEpubPackageMetadata', () => {
  it('reads the first dc:title and dc:creator without the chapter text', () => {
    const bytes = epub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': `<?xml version="1.0"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>   </dc:title>
    <dc:title>Cats &amp; Dogs <span>Today</span></dc:title>
    <dc:title>Subtitle</dc:title>
    <dc:creator><![CDATA[A. Writer]]></dc:creator>
  </metadata>
</package>`,
      'OEBPS/chapter.xhtml': 'CHAPTER_BODY_SHOULD_STAY_IN_THE_FILE',
    })
    expect(readEpubPackageMetadata(bytes)).toEqual({
      title: 'Cats & Dogs Today',
      creator: 'A. Writer',
    })
  })

  it('ignores unsafe rootfile paths and missing packages', () => {
    const escaped = epub({
      'META-INF/container.xml':
        '<container><rootfiles><rootfile full-path="../secret.txt" media-type="application/oebps-package+xml"/></rootfiles></container>',
      '../secret.txt': '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Secret</dc:title></package>',
    })
    expect(readEpubPackageMetadata(escaped)).toEqual({ title: null, creator: null })
    expect(readEpubPackageMetadata(new Uint8Array([1, 2, 3, 4]))).toEqual({ title: null, creator: null })
    expect(readEpubPackageMetadata(epub({ 'META-INF/container.xml': '<container/>' }))).toEqual({
      title: null,
      creator: null,
    })
  })

  it('reads an uncompressed OPF', () => {
    const bytes = zipSync({
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': [strToU8(CONTAINER), { level: 0 }],
      'OEBPS/content.opf': [
        strToU8(
          '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Stored</dc:title></metadata></package>',
        ),
        { level: 0 },
      ],
    })
    expect(readEpubPackageMetadata(bytes).title).toBe('Stored')
    expect(readEpubPackageMetadata(bytes).creator).toBeNull()
  })
})
