import {
  FEED_COLLECTION_STALE_MS,
  MAX_FEED_TOPIC_TAG_LENGTH,
  MAX_FEED_TOPIC_TAGS,
  type FeedSource,
} from '../types'

export function isActiveFeedCollection(source: FeedSource, nowMs: number): boolean {
  if (source.collectionStatus !== 'queued' && source.collectionStatus !== 'running') {
    return false
  }
  const updatedMs = Date.parse(source.updatedAt)
  return Number.isFinite(updatedMs) && nowMs - updatedMs < FEED_COLLECTION_STALE_MS
}

export function parseTopicTagsInput(raw: unknown): readonly string[] {
  const values =
    typeof raw === 'string'
      ? raw.split(/[,、]/)
      : Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string')
        : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const tag = value.trim().slice(0, MAX_FEED_TOPIC_TAG_LENGTH)
    if (tag.length === 0 || seen.has(tag)) {
      continue
    }
    seen.add(tag)
    out.push(tag)
    if (out.length >= MAX_FEED_TOPIC_TAGS) {
      break
    }
  }
  return out
}

export function parseEnabledInput(raw: unknown, fallback: boolean): boolean {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') {
    return true
  }
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') {
    return false
  }
  return fallback
}
