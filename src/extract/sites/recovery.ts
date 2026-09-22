import { logSiteRecovery } from '../../log'
import type { FetchFailedError, FetchedPage, FetchPage, HttpUrl } from '../../types'
import { err, ok } from '../../types'

export type SiteRecoveryResult =
  | { readonly outcome: 'recovered'; readonly page: FetchedPage }
  | { readonly outcome: 'unavailable'; readonly reason: string }
  | { readonly outcome: 'pass' }

// One entry per site that can supply the article when a normal HTML fetch fails.
// Append a recovery here only through `withSiteRecoveries`'s list; `matches`
// decides whether it runs.
export type SiteFetchRecovery = {
  readonly id: string
  matches(url: HttpUrl): boolean
  recover(url: HttpUrl, failure: FetchFailedError): Promise<SiteRecoveryResult>
}

export function looksLikeBotWall(html: string): boolean {
  const sample = html.slice(0, 8000).toLowerCase()
  return (
    sample.includes('cf-error-details') ||
    sample.includes('challenge-platform') ||
    sample.includes('cf-browser-verification') ||
    (sample.includes('attention required') && sample.includes('you have been blocked'))
  )
}

export function withSiteRecoveries(
  fetchHtml: FetchPage,
  recoveries: readonly SiteFetchRecovery[],
): FetchPage {
  return async (url) => {
    const recovery = recoveries.find((item) => item.matches(url))
    const page = await fetchHtml(url)
    if (recovery === undefined) {
      return page
    }
    if (page.ok && !looksLikeBotWall(page.value.html)) {
      return page
    }

    let failure: FetchFailedError
    if (page.ok) {
      failure = { kind: 'fetch_failed', url, reason: 'Blocked by a bot check' }
    } else if (page.error.kind === 'fetch_failed') {
      failure = page.error
    } else {
      return page
    }
    const recovered = await recovery.recover(url, failure)
    logSiteRecovery({ site: recovery.id, outcome: recovered.outcome, url })
    if (recovered.outcome === 'recovered') {
      return ok(recovered.page)
    }
    if (recovered.outcome === 'unavailable') {
      return err({
        kind: 'fetch_failed',
        url,
        reason: recovered.reason,
        terminal: true,
      })
    }
    return page.ok ? err(failure) : page
  }
}
