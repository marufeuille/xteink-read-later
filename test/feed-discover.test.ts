import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverFeedUrl } from '../src/feeds/discover'
import { parseHttpUrl, type HttpUrl } from '../src/types'

const fixtures = dirname(fileURLToPath(import.meta.url))

function html(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

describe('discoverFeedUrl', () => {
  it('uses rel=alternate RSS or Atom links', () => {
    const found = discoverFeedUrl(html('site-with-feed.html'), mustUrl('https://blog.example.com/'))
    expect(found).toBe('https://blog.example.com/blog/feed.xml')
  })

  it('returns null when the site has no feed link', () => {
    expect(discoverFeedUrl(html('site-without-feed.html'), mustUrl('https://example.com/'))).toBeNull()
  })

  it('prefers atom/rss types over generic xml', () => {
    const found = discoverFeedUrl(
      `<html><head>
        <link rel="alternate" type="application/xml" href="/all.xml" />
        <link rel="alternate" type="application/atom+xml" href="/atom.xml" />
      </head></html>`,
      mustUrl('https://news.example.com/'),
    )
    expect(found).toBe('https://news.example.com/atom.xml')
  })
})
