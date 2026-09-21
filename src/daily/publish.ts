import type { ArticleId, ArticleStore, ArticleWrite, DailyPublishResult } from '../types'
import { isDailyCanonicalUrl } from './identity'

export async function publishLatestDaily(
  store: ArticleStore,
  write: ArticleWrite,
): Promise<DailyPublishResult> {
  if (!isDailyCanonicalUrl(write.canonicalUrl)) {
    throw new TypeError(`Not a daily digest canonical URL: ${write.canonicalUrl}`)
  }
  const meta = await store.put(write)
  const removedIds: ArticleId[] = []
  for (const item of await store.listMeta()) {
    if (item.id === meta.id || !isDailyCanonicalUrl(item.canonicalUrl)) {
      continue
    }
    if (await store.delete(item.id)) {
      removedIds.push(item.id)
    }
  }
  return { meta, removedIds }
}
