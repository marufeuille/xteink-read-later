import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { createMemoryStore } from '../../src/store/memory'
import {
  asClipJobId,
  asClipRunId,
  parseHttpUrl,
  type ClipFailedJob,
} from '../../src/types'
import { accessIdentity, TEST_BINDINGS, TEST_CLIP_TOKEN } from '../bindings'
import { createFakeQueue } from '../fake-queue'

const ARTICLE_URL = 'https://example.com/articles/recent-clip?ref=tab'
const SECRET_MESSAGE = `do not show ${TEST_CLIP_TOKEN}`

function url(value: string) {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

describe('recent clips page', () => {
  it('lets the reader open the list after a clip and see a failure without the article', async () => {
    const store = createMemoryStore()
    const queue = createFakeQueue()
    const app = createApp({ store, queue, ...accessIdentity() })
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env

    const opened = await app.request(
      `https://read.example/clip/web?url=${encodeURIComponent(ARTICLE_URL)}`,
      {},
      env,
    )
    expect(opened.status).toBe(200)
    const confirm = await opened.text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(confirm)?.[1] ?? ''
    const accepted = await app.request(
      'https://read.example/clip/web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, url: ARTICLE_URL }).toString(),
      },
      env,
    )
    expect(accepted.status).toBe(202)
    const acceptedHtml = await accepted.text()
    expect(acceptedHtml).toContain('href="/clip/recent"')
    const queuedId = /jobId: (job_[a-f0-9]{32})/.exec(acceptedHtml)?.[1]
    expect(queuedId).toMatch(/^job_/)

    const recent = await app.request('https://read.example/clip/recent', {}, env)
    expect(recent.status).toBe(200)
    const queuedHtml = await recent.text()
    expect(queuedHtml).toContain(queuedId ?? '')
    expect(queuedHtml).toContain('status: queued')
    expect(queuedHtml).toContain('stage: queue')
    expect(queuedHtml).not.toContain('再クリップ')
    expect(queuedHtml).not.toContain(ARTICLE_URL)
    expect(queuedHtml).not.toContain(TEST_CLIP_TOKEN)
    expect(queue.size).toBe(1)

    const failedId = asClipJobId('job_ffffffffffffffffffffffffffffffff')
    const failed: ClipFailedJob = {
      jobId: failedId,
      runId: asClipRunId('run_ffffffffffffffffffffffffffffffff'),
      sourceUrl: url(`https://hidden.example/${TEST_CLIP_TOKEN}`),
      status: 'failed',
      articleId: null,
      error: { code: 'translate_failed', message: SECRET_MESSAGE },
      attempt: 2,
      stages: [{ stage: 'translate', durationMs: 20, attempt: 2, errorKind: 'translate_failed' }],
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    }
    await store.putJob(failed)

    const again = await app.request('https://read.example/clip/recent/', {}, env)
    expect(again.status).toBe(200)
    const html = await again.text()
    const failedAt = html.indexOf(`jobId: ${failedId}`)
    expect(failedAt).toBeGreaterThan(-1)
    const failedBlock = html.slice(html.lastIndexOf('<article', failedAt), html.indexOf('</article>', failedAt))
    expect(html).toContain('失敗が 1 件あります')
    expect(failedBlock).toContain('class="clip-failed"')
    expect(failedBlock).toContain('role="alert"')
    expect(failedBlock).toContain('status: failed')
    expect(failedBlock).toContain('stage: translate')
    expect(failedBlock).toContain('error.code: translate_failed')
    expect(failedBlock).toContain('再クリップは Shortcuts で同じ記事を送り直す。jobId は上に表示。')
    expect(failedBlock.indexOf(`jobId: ${failedId}`)).toBeLessThan(failedBlock.indexOf('class="reclip"'))
    expect(failedBlock).not.toMatch(/https?:\/\//)
    const queuedAt = html.indexOf(`jobId: ${queuedId ?? ''}`)
    const queuedBlock = html.slice(html.lastIndexOf('<article', queuedAt), html.indexOf('</article>', queuedAt))
    expect(queuedBlock).not.toContain('再クリップ')
    expect(html).toContain(queuedId ?? '')
    expect(html).not.toContain(ARTICLE_URL)
    expect(html).not.toContain('hidden.example')
    expect(html).not.toContain(SECRET_MESSAGE)
    expect(html).not.toContain(TEST_CLIP_TOKEN)
    expect(html).not.toContain('errorKind')
  })
})
