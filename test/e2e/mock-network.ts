import { vi } from 'vitest'
import { OPENAI_CHAT_URL } from '../../src/translate/constants'

export type PageFixture = {
  readonly html: string | Uint8Array
  readonly status?: number
  readonly contentType?: string
  readonly headers?: Record<string, string>
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.href
  }
  return input.url
}

export function openaiMessageResponse(title: string, content: string): Response {
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({ title, content }),
        },
      },
    ],
  })
}

export function installNetworkMock(options: {
  readonly pages: Record<string, PageFixture>
  readonly openai?: (request: Request) => Response | Promise<Response>
}): { readonly fetchedUrls: string[] } {
  const fetchedUrls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      fetchedUrls.push(url)
      const request = input instanceof Request ? input : new Request(input, init)

      if (url === OPENAI_CHAT_URL) {
        if (options.openai === undefined) {
          throw new Error(`unexpected OpenAI fetch: ${url}`)
        }
        return options.openai(request)
      }

      const page = options.pages[url]
      if (page === undefined) {
        throw new Error(`unexpected network fetch: ${url}`)
      }
      return new Response(page.html, {
        status: page.status ?? 200,
        headers: {
          'content-type': page.contentType ?? 'text/html; charset=utf-8',
          ...page.headers,
        },
      })
    }),
  )
  return { fetchedUrls }
}
