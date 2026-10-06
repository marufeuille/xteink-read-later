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
  readonly cleanupErrorKind?: string | null
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

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9]*$/

/** Ops routes on these prefixes. Anything else is rejected before Slack sees it. */
export function isDeployNotification(message: string): boolean {
  return message.startsWith('[deploy-smoke]') || message.startsWith('[deploy-rollback]')
}

/**
 * One line of `key=value` tokens. Values are already sanitized.
 * A value with a space or newline is rejected here so it cannot reach Slack.
 */
export function joinNotificationLine(
  prefix: '[deploy-smoke]' | '[deploy-rollback]',
  fields: readonly (readonly [string, string])[],
): string {
  const parts = fields.map(([key, value]) => {
    if (!FIELD_KEY.test(key) || value.length === 0 || /[\s]/.test(value)) {
      throw new Error('notification field rejected')
    }
    return `${key}=${value}`
  })
  return `${prefix} ${parts.join(' ')}`
}

/**
 * One line. Ops routes on the `[deploy-smoke]` prefix.
 * Key order: sha, workerVersion, failedStep, errorKind, lastStage, jobId, runUrl,
 * then cleanupErrorKind only when the caller recorded both failures.
 * Missing lastStage, jobId, and errorKind are `-`. Only allowlisted fields are interpolated.
 */
export function buildSmokeSlackMessage(input: SmokeFailureFields): string {
  const fields: Array<readonly [string, string]> = [
    ['sha', sanitizeGithubSha(input.githubSha)],
    ['workerVersion', sanitizeWorkerVersion(input.workerVersion)],
    ['failedStep', sanitizeStep(input.failedStep)],
    ['errorKind', sanitizeKind(input.errorKind)],
    ['lastStage', sanitizeKind(input.lastStage)],
    ['jobId', field(input.jobId, JOB, '-')],
    ['runUrl', sanitizeRunUrl(input.runUrl)],
  ]
  if (input.cleanupErrorKind !== undefined && input.cleanupErrorKind !== null) {
    fields.push(['cleanupErrorKind', sanitizeKind(input.cleanupErrorKind)])
  }
  return joinNotificationLine('[deploy-smoke]', fields)
}
