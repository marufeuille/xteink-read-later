import type { ArticleId, ArticleStore, ArticleWrite, DailyPublishResult } from '../types'
import { isDailyCanonicalUrl } from './identity'

async function removeDailyDigests(store: ArticleStore, exceptId?: ArticleId): Promise<readonly ArticleId[]> {
  const removedIds: ArticleId[] = []
  for (const item of await store.listMeta()) {
    if (item.id === exceptId || !isDailyCanonicalUrl(item.canonicalUrl)) {
      continue
    }
    if (await store.delete(item.id)) {
      removedIds.push(item.id)
    }
  }
  return removedIds
}

export async function unpublishDailyDigests(store: ArticleStore): Promise<readonly ArticleId[]> {
  return removeDailyDigests(store)
}

export async function publishLatestDaily(
  store: ArticleStore,
  write: ArticleWrite,
): Promise<DailyPublishResult> {
  if (!isDailyCanonicalUrl(write.canonicalUrl)) {
    throw new TypeError(`Not a daily digest canonical URL: ${write.canonicalUrl}`)
  }
  const meta = await store.put(write)
  return { meta, removedIds: await removeDailyDigests(store, meta.id) }
}
