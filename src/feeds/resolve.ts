import { assertFetchableCandidateUrl } from '../candidates/fetch-policy'
import type { FetchFeed, FetchPage, HttpUrl, InvalidFeedError, InvalidUrlError, Result } from '../types'
import { err, ok, parseHttpUrl } from '../types'
import { discoverFeedUrl } from './discover'
import { looksLikeFeed, parseFeed } from './parse'

export type ResolvedSourceUrls = {
  readonly siteUrl: HttpUrl
  readonly feedUrl: HttpUrl
}

export type ResolveSourceUrlsDeps = {
  readonly fetchPage: FetchPage
  readonly fetchFeed: FetchFeed
}

function asHttpUrl(raw: string): Result<HttpUrl, InvalidUrlError> {
  const parsed = parseHttpUrl(raw.trim())
  if (parsed === null) {
    return err({ kind: 'invalid_url', url: raw })
  }
  return assertFetchableCandidateUrl(parsed)
}

async function feedFromUrl(
  url: HttpUrl,
  fetchFeed: FetchFeed,
): Promise<Result<{ feedUrl: HttpUrl; siteUrl: HttpUrl }, InvalidFeedError | InvalidUrlError | import('../types').FetchError>> {
  const fetched = await fetchFeed(url)
  if (!fetched.ok) {
    return fetched
  }
  const parsed = parseFeed(fetched.value.xml, fetched.value.finalUrl)
  if (!parsed.ok) {
    return parsed
  }
  return ok({
    feedUrl: fetched.value.finalUrl,
    siteUrl: parsed.value.siteUrl ?? fetched.value.finalUrl,
  })
}

export async function resolveSourceUrls(
  input: { readonly siteUrl: string; readonly feedUrl: string },
  deps: ResolveSourceUrlsDeps,
): Promise<Result<ResolvedSourceUrls, InvalidFeedError | InvalidUrlError | import('../types').FetchError>> {
  const site = asHttpUrl(input.siteUrl)
  if (!site.ok) {
    return site
  }
  const feedRaw = input.feedUrl.trim()
  if (feedRaw.length > 0) {
    const feed = asHttpUrl(feedRaw)
    if (!feed.ok) {
      return feed
    }
    return ok({ siteUrl: site.value, feedUrl: feed.value })
  }

  const asFeed = await feedFromUrl(site.value, deps.fetchFeed)
  if (asFeed.ok) {
    return ok({ siteUrl: asFeed.value.siteUrl, feedUrl: asFeed.value.feedUrl })
  }

  const page = await deps.fetchPage(site.value)
  if (!page.ok) {
    if (asFeed.ok === false && asFeed.error.kind === 'invalid_feed') {
      return err({
        kind: 'invalid_feed',
        reason: 'サイトからフィードを見つけられませんでした。フィード URL を入力してください',
        url: site.value,
      })
    }
    return page
  }
  if (looksLikeFeed(page.value.html)) {
    const parsed = parseFeed(page.value.html, page.value.finalUrl)
    if (parsed.ok) {
      return ok({
        siteUrl: parsed.value.siteUrl ?? page.value.finalUrl,
        feedUrl: page.value.finalUrl,
      })
    }
  }
  const discovered = discoverFeedUrl(page.value.html, page.value.finalUrl)
  if (discovered === null) {
    return err({
      kind: 'invalid_feed',
      reason: 'サイトからフィードを見つけられませんでした。フィード URL を入力してください',
      url: site.value,
    })
  }
  return ok({ siteUrl: page.value.finalUrl, feedUrl: discovered })
}
