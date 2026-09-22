import type { DigestPublishedItem, DigestStore } from '../types'

export function createMemoryDigestStore(): DigestStore {
  const byDate = new Map<string, DigestPublishedItem[]>()

  return {
    async listPublishedCanonicalUrlsExcept(date) {
      const urls = new Set<string>()
      for (const [issueDate, items] of byDate) {
        if (issueDate !== date) {
          for (const item of items) {
            urls.add(item.canonicalUrl)
          }
        }
      }
      return urls
    },
    async replacePublishedItems(date, items) {
      byDate.set(date, [...items])
    },
  }
}
