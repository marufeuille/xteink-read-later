/** Platform retries after the first delivery. Attempt 4 is the last one we are invoked for. */
export const DIGEST_QUEUE_MAX_RETRIES = 3

/**
 * A single summary waits on fetch (20s) plus the model (60s).
 * The watchdog treats a run as stuck only after that window, with margin.
 */
export const DIGEST_STEP_STALE_MS = 150_000

export const DIGEST_WATCHDOG_DELAY_SECONDS = 150

export function shouldRetryDigestAttempt(attempts: number): boolean {
  return Number.isInteger(attempts) && attempts >= 1 && attempts <= DIGEST_QUEUE_MAX_RETRIES
}

/** The last delivery must not repeat work that can exceed the CPU limit. */
export function isFinalDigestAttempt(attempts: number): boolean {
  return !shouldRetryDigestAttempt(attempts)
}
