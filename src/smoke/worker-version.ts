const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

/** Cloudflare deployments API body. Returns a version id, or `unknown`. Never returns other fields. */
export function parseWorkerDeploymentVersion(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    return 'unknown'
  }
  const latest = versionFromDeployment(payload.result.latest)
  if (latest !== null) {
    return latest
  }
  const deployments = payload.result.deployments
  if (!Array.isArray(deployments)) {
    return 'unknown'
  }
  for (const deployment of deployments) {
    const version = versionFromDeployment(deployment)
    if (version !== null) {
      return version
    }
  }
  return 'unknown'
}
