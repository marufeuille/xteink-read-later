const SHA = /^[0-9a-f]{40}$/
const STEP = /^[a-z0-9-]{1,40}$/
const KIND = /^[a-z][a-z0-9_]{0,31}$/
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const JOB = /^job_[a-f0-9]{32}$/
const RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/

export type SmokeFailureFields = {
  readonly githubSha: string
  readonly workerVersion: string
  readonly failedStep: string
  readonly jobId: string | null
  readonly lastStage: string | null
  readonly errorKind: string | null
  readonly runUrl: string
}

function field(value: string | null | undefined, pattern: RegExp, fallback: string): string {
  if (value === null || value === undefined || !pattern.test(value)) {
    return fallback
  }
  return value
}

export function sanitizeGithubSha(value: string | undefined): string {
  return field(value?.toLowerCase(), SHA, 'unknown')
}

export function sanitizeWorkerVersion(value: string | undefined): string {
  return field(value?.toLowerCase(), VERSION, 'unknown')
}

export function sanitizeRunUrl(value: string | undefined): string {
  return field(value, RUN_URL, '-')
}

export function sanitizeStep(value: string | null | undefined): string {
  return field(value, STEP, 'unknown')
}

export function sanitizeKind(value: string | null | undefined): string {
  return field(value, KIND, '-')
}

/** One line. Ops routes on the `[deploy-smoke]` prefix. Only allowlisted fields are interpolated. */
export function buildSmokeSlackMessage(input: SmokeFailureFields): string {
  const sha = sanitizeGithubSha(input.githubSha)
  const version = sanitizeWorkerVersion(input.workerVersion)
  const step = sanitizeStep(input.failedStep)
  const jobId = field(input.jobId, JOB, '-')
  const stage = sanitizeKind(input.lastStage)
  const errorKind = sanitizeKind(input.errorKind)
  const runUrl = sanitizeRunUrl(input.runUrl)
  return `[deploy-smoke] github.sha=${sha} workerVersion=${version} failedStep=${step} jobId=${jobId} lastStage=${stage} errorKind=${errorKind} runUrl=${runUrl}`
}
