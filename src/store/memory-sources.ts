import type { FeedSource, FeedSourceStore, HttpUrl } from '../types'

export function createMemoryFeedSourceStore(): FeedSourceStore {
  const sources = new Map<string, FeedSource>()

  return {
    async getById(id) {
      return sources.get(id) ?? null
    },
    async getByFeedUrl(feedUrl: HttpUrl) {
      for (const source of sources.values()) {
        if (source.feedUrl === feedUrl) {
          return source
        }
      }
      return null
    },
    async put(source) {
      sources.set(source.id, source)
    },
    async list() {
      return [...sources.values()].sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt < right.createdAt ? 1 : -1
        }
        return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
      })
    },
    async listEnabled() {
      const listed = await this.list()
      return listed.filter((source) => source.enabled)
    },
  }
}
