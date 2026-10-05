const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GIT_SHA = /^[0-9a-f]{40}$/i
/** Whole annotation. `wrangler deploy --message` stores this on the deployment. */
export const DEPLOY_SHA_MESSAGE = /^deploy-sha=([0-9a-f]{40})$/i

export type WorkerDeploymentIdentity = {
  readonly versionId: string
  readonly sourceSha: string
}

const UNKNOWN_IDENTITY: WorkerDeploymentIdentity = { versionId: 'unknown', sourceSha: 'unknown' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function versionFromDeployment(deployment: unknown): string | null {
  if (!isRecord(deployment) || !Array.isArray(deployment.versions)) {
    return null
  }
  const versions = deployment.versions.filter(isRecord)
  const chosen = versions.find((item) => item.percentage === 100) ?? versions[0]
  const id = chosen?.version_id
  return typeof id === 'string' && VERSION_ID.test(id) ? id : null
}

function chosenVersion(deployment: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(deployment.versions)) {
    return null
  }
  const versions = deployment.versions.filter(isRecord)
  return versions.find((item) => item.percentage === 100) ?? versions[0] ?? null
}

/** SHA stamped by `deploy-sha=<40 hex>`, or `workers/commit_sha` when that is the whole value. */
export function sourceShaFromAnnotations(annotations: unknown): string | null {
  if (!isRecord(annotations)) {
    return null
  }
  const message = annotations['workers/message']
  if (typeof message === 'string') {
    const match = DEPLOY_SHA_MESSAGE.exec(message.trim())
    const sha = match?.[1]
    if (sha !== undefined && !/^0+$/.test(sha)) {
      return sha.toLowerCase()
    }
  }
  const commit = annotations['workers/commit_sha']
  if (typeof commit !== 'string') {
    return null
  }
  const trimmed = commit.trim()
  if (!GIT_SHA.test(trimmed) || /^0+$/.test(trimmed)) {
    return null
  }
  return trimmed.toLowerCase()
}

function sourceShaFromDeployment(deployment: Record<string, unknown>): string | null {
  const fromDeployment = sourceShaFromAnnotations(deployment.annotations)
  if (fromDeployment !== null) {
    return fromDeployment
  }
  const version = chosenVersion(deployment)
  if (version === null) {
    return null
  }
  return sourceShaFromAnnotations(version.annotations)
}

function firstDeployment(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    return null
  }
  const latest = payload.result.latest
  if (versionFromDeployment(latest) !== null && isRecord(latest)) {
    return latest
  }
  const deployments = payload.result.deployments
  if (!Array.isArray(deployments)) {
    return null
  }
  for (const deployment of deployments) {
    if (versionFromDeployment(deployment) !== null && isRecord(deployment)) {
      return deployment
    }
  }
  return null
}

/**
 * Version id and the git SHA that produced it.
 * The SHA comes only from that deployment's message or commit annotation.
 * Anything else, including email and free-text messages, becomes `unknown`.
 */
export function parseWorkerDeploymentIdentity(payload: unknown): WorkerDeploymentIdentity {
  const deployment = firstDeployment(payload)
  if (deployment === null) {
    return UNKNOWN_IDENTITY
  }
  const versionId = versionFromDeployment(deployment)
  if (versionId === null) {
    return UNKNOWN_IDENTITY
  }
  return {
    versionId,
    sourceSha: sourceShaFromDeployment(deployment) ?? 'unknown',
  }
}

/** Cloudflare deployments API body. Returns a version id, or `unknown`. Never returns other fields. */
export function parseWorkerDeploymentVersion(payload: unknown): string {
  return parseWorkerDeploymentIdentity(payload).versionId
}

/** One Worker version resource. Returns the stamped SHA, or `unknown`. */
export function parseWorkerVersionSourceSha(payload: unknown): string {
  if (!isRecord(payload)) {
    return 'unknown'
  }
  const body = isRecord(payload.result) ? payload.result : payload
  return sourceShaFromAnnotations(body.annotations) ?? 'unknown'
}
