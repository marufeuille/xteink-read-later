import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseFeed } from '../src/feeds/parse'
import { parseHttpUrl, type HttpUrl } from '../src/types'

const fixtures = dirname(fileURLToPath(import.meta.url))

function xml(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

describe('parseFeed', () => {
  it('parses a Zenn RSS topic feed', () => {
    const parsed = parseFeed(xml('zenn-topic-feed.xml'), mustUrl('https://zenn.dev/topics/cloudflare/feed'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.value.format).toBe('rss')
    expect(parsed.value.title).toContain('cloudflare')
    expect(parsed.value.items).toHaveLength(2)
    expect(parsed.value.items[0]?.url).toBe('https://zenn.dev/example/articles/feed-collect')
    expect(parsed.value.items[0]?.publishedAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('parses a Mercari Engineering Atom feed', () => {
    const parsed = parseFeed(
      xml('mercari-engineering-feed.xml'),
      mustUrl('https://engineering.mercari.com/blog/feed.xml'),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.value.format).toBe('atom')
    expect(parsed.value.title).toBe('Mercari Engineering Blog')
    expect(parsed.value.siteUrl).toBe('https://engineering.mercari.com/blog/')
    expect(parsed.value.items[0]?.url).toBe('https://engineering.mercari.com/blog/entry/2026-09-01-hello/')
  })

  it('rejects HTML that is not a feed', () => {
    const parsed = parseFeed(xml('invalid-feed.xml'), mustUrl('https://example.com/not-feed'))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) {
      return
    }
    expect(parsed.error.kind).toBe('invalid_feed')
  })

  it('resolves relative item links and CDATA titles', () => {
    const parsed = parseFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel>
        <title><![CDATA[Example]]></title>
        <item><title><![CDATA[Hello &amp; more]]></title><link>/posts/a</link></item>
      </channel></rss>`,
      mustUrl('https://blog.example.com/feed.xml'),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.value.items[0]?.url).toBe('https://blog.example.com/posts/a')
    expect(parsed.value.items[0]?.title).toBe('Hello & more')
  })
})
