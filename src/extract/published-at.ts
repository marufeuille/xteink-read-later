const DEVELOPERS_IO_HOST = 'dev.classmethod.jp'

export const DEVELOPERS_IO_CANONICAL_LIKE_PATTERNS = [
  'https://dev.classmethod.jp/%',
  'http://dev.classmethod.jp/%',
] as const

const NEXT_PUSH =
  /<script>\s*(?:self\.__next_f\.push|\(self\.__next_f=self\.__next_f\|\|\[\]\)\.push)\(([\s\S]*?)\)\s*<\/script>/g

const ARTICLE_SCHEMA_TYPES = new Set(['Article', 'NewsArticle', 'BlogPosting', 'TechArticle'])

export function isDevelopersIoCandidateUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname === DEVELOPERS_IO_HOST
  } catch {
    return false
  }
}

function nextFlightPayload(html: string): string {
  let payload = ''
  const pushes = new RegExp(NEXT_PUSH.source, 'g')
  for (const match of html.matchAll(pushes)) {
    const raw = match[1]
    if (raw === undefined) {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        continue
      }
      for (const part of parsed) {
        if (typeof part === 'string') {
          payload += part
        }
      }
    } catch {
      // Ignore a malformed flight chunk. A missing date stays unknown.
    }
  }
  return payload
}

function nearestSchemaType(before: string): string | null {
  const schemaType = /@type(?:\\*")\s*:\s*(?:\\*")([^"\\]+)/g
  let last: string | null = null
  for (const match of before.matchAll(schemaType)) {
    const value = match[1]
    if (value !== undefined && value.length > 0) {
      last = value
    }
  }
  return last
}

function articleDatePublished(source: string): string | null {
  const published = /datePublished(?:\\*")\s*:\s*(?:\\*")([^"\\]+)/g
  for (const match of source.matchAll(published)) {
    const value = match[1]
    if (value === undefined || value.trim() === '') {
      continue
    }
    const index = match.index ?? 0
    const before = source.slice(0, index)
    if (!ARTICLE_SCHEMA_TYPES.has(nearestSchemaType(before) ?? '')) {
      continue
    }
    const nearby = before.slice(Math.max(0, before.length - 1500))
    if (!nearby.includes('schema.org') && !nearby.includes('ld+json')) {
      continue
    }
    return value.trim()
  }
  return null
}

export function developersIoDatePublished(html: string): string | null {
  const payload = nextFlightPayload(html)
  if (payload.length > 0) {
    const fromFlight = articleDatePublished(payload)
    if (fromFlight !== null) {
      return fromFlight
    }
  }
  return articleDatePublished(html)
}

export function publishedDateFallback(input: {
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly html: string
  readonly timeDatetime: string | null
}): string | null {
  if (isDevelopersIoCandidateUrl(input.requestedUrl) || isDevelopersIoCandidateUrl(input.finalUrl)) {
    return developersIoDatePublished(input.html)
  }
  return input.timeDatetime
}
