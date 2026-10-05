import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { buildSmokeSlackMessage, sanitizeKind } from './message.ts'
import {
  classifySmokeForRollback,
  fetchLiveWorkerVersion,
  formatGithubOutput,
  readDeployDiff,
  runDeployRollback,
  runWranglerRollback,
  smokeResultOutputs,
  type DeployDiff,
  type RollbackContext,
} from './rollback.ts'
import {
  cleanupSmokeArticle,
  notificationForState,
  parseSmokeState,
  postSmokeSlack,
  runDeploySmoke,
  type SmokeSettings,
  type SmokeStateFile,
} from './run.ts'
import { publishUnsetSkip } from './unset.ts'

function envValue(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined ? undefined : value
}

function settingsFromEnv(): SmokeSettings {
  const clipToken = envValue('SMOKE_CLIP_TOKEN')
  const opdsUsername = envValue('SMOKE_OPDS_USERNAME')
  const opdsPassword = envValue('SMOKE_OPDS_PASSWORD')
  const slackWebhookUrl = envValue('SMOKE_SLACK_WEBHOOK_URL')
  const articleUrl = envValue('SMOKE_ARTICLE_URL')
  const origin = envValue('SMOKE_ORIGIN')
  const githubSha = envValue('GITHUB_SHA')
  const workerVersion = envValue('WORKER_VERSION')
  const runUrl = envValue('SMOKE_RUN_URL')
  return {
    ...(clipToken === undefined ? {} : { clipToken }),
    ...(opdsUsername === undefined ? {} : { opdsUsername }),
    ...(opdsPassword === undefined ? {} : { opdsPassword }),
    ...(slackWebhookUrl === undefined ? {} : { slackWebhookUrl }),
    ...(articleUrl === undefined ? {} : { articleUrl }),
    ...(origin === undefined ? {} : { origin }),
    ...(githubSha === undefined ? {} : { githubSha }),
    ...(workerVersion === undefined ? {} : { workerVersion }),
    ...(runUrl === undefined ? {} : { runUrl }),
  }
}

function statePath(): string {
  return process.env.SMOKE_STATE_PATH ?? 'smoke-state.json'
}

function writeState(path: string, state: SmokeStateFile): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(state)}\n`)
  renameSync(tmp, path)
}

function readState(path: string): SmokeStateFile | null {
  try {
    return parseSmokeState(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return null
  }
}

async function sendSlack(message: string): Promise<number> {
  const webhook = envValue('SMOKE_SLACK_WEBHOOK_URL')
  if (webhook === undefined || webhook.trim().length === 0) {
    console.log('未設定: SMOKE_SLACK_WEBHOOK_URL')
    return 0
  }
  try {
    await postSmokeSlack(webhook, message, fetch)
  } catch {
    console.error('slack notify failed')
    return 1
  }
  return 0
}

async function run(): Promise<number> {
  const path = statePath()
  const result = await runDeploySmoke({
    settings: settingsFromEnv(),
    log: (line) => {
      console.log(line)
    },
    onProgress: (state) => {
      writeState(path, state)
    },
  })
  writeState(path, result.state)
  if (result.kind === 'skipped') {
    return publishUnsetSkip({
      missing: result.missing,
      smokeRequired: envValue('SMOKE_REQUIRED'),
      summaryPath: envValue('GITHUB_STEP_SUMMARY'),
    })
  }
  return result.kind === 'failed' ? 1 : 0
}

async function cleanup(): Promise<number> {
  const path = statePath()
  const state = readState(path)
  const result = await cleanupSmokeArticle({
    state,
    settings: settingsFromEnv(),
    log: (line) => {
      console.log(line)
    },
  })
  if (result.ok || state === null) {
    return result.ok ? 0 : 1
  }
  writeState(path, { ...state, cleanupErrorKind: result.errorKind })
  return 1
}

async function notify(): Promise<number> {
  const state = readState(statePath())
  const githubSha = envValue('GITHUB_SHA')
  const workerVersion = envValue('WORKER_VERSION')
  const runUrl = envValue('SMOKE_RUN_URL')
  const fields = notificationForState(state, {
    ...(githubSha === undefined ? {} : { githubSha }),
    ...(workerVersion === undefined ? {} : { workerVersion }),
    ...(runUrl === undefined ? {} : { runUrl }),
  })
  if (fields === null) {
    return 0
  }
  return sendSlack(buildSmokeSlackMessage(fields))
}

function exportOutputs(): number {
  const outputs = smokeResultOutputs(readState(statePath()))
  const lines = [
    formatGithubOutput('outcome', outputs.outcome),
    formatGithubOutput('failedStep', outputs.failedStep),
    formatGithubOutput('errorKind', outputs.errorKind),
    formatGithubOutput('cleanupErrorKind', outputs.cleanupErrorKind),
  ].join('')
  const file = envValue('GITHUB_OUTPUT')
  if (file === undefined || file.trim().length === 0) {
    process.stdout.write(lines)
    return 0
  }
  appendFileSync(file, lines)
  return 0
}

function rollbackContext(): RollbackContext {
  return {
    jobResult: envValue('SMOKE_JOB_RESULT') ?? '',
    outcome: envValue('SMOKE_OUTCOME') ?? '',
    failedStep: envValue('SMOKE_FAILED_STEP') ?? '',
    errorKind: envValue('SMOKE_ERROR_KIND') ?? '',
    cleanupErrorKind: envValue('SMOKE_CLEANUP_ERROR_KIND') ?? '',
    previousWorkerVersion: envValue('PREVIOUS_WORKER_VERSION') ?? '',
    workerVersion: envValue('WORKER_VERSION') ?? '',
    githubSha: envValue('GITHUB_SHA') ?? '',
    runUrl: envValue('SMOKE_RUN_URL') ?? '',
    runId: envValue('GITHUB_RUN_ID') ?? '',
  }
}

function knownDiff(): DeployDiff {
  return { paths: [], wranglerBefore: null, wranglerAfter: null, diffKnown: true }
}

async function verifyAfterRollback(): Promise<'passed' | 'failed' | 'skipped'> {
  const path = statePath()
  const previous = envValue('PREVIOUS_WORKER_VERSION')
  const settings = {
    ...settingsFromEnv(),
    ...(previous === undefined ? {} : { workerVersion: previous }),
  }
  const result = await runDeploySmoke({
    settings,
    log: (line) => {
      console.log(line)
    },
    onProgress: (state) => {
      writeState(path, state)
    },
  })
  writeState(path, result.state)
  const cleaned = await cleanupSmokeArticle({
    state: result.state,
    settings,
    log: (line) => {
      console.log(line)
    },
  })
  if (!cleaned.ok) {
    console.log(`cleanup errorKind=${sanitizeKind(cleaned.errorKind)}`)
    writeState(path, { ...result.state, cleanupErrorKind: cleaned.errorKind })
  }
  if (result.kind === 'passed') {
    return 'passed'
  }
  if (result.kind === 'skipped') {
    return 'skipped'
  }
  return 'failed'
}

async function rollback(): Promise<number> {
  const context = rollbackContext()
  const early = classifySmokeForRollback(context)
  const diff =
    early.kind === 'candidate'
      ? readDeployDiff(envValue('PREVIOUS_WORKER_SHA') ?? '', envValue('GITHUB_SHA') ?? '')
      : knownDiff()
  const accountId = envValue('CLOUDFLARE_ACCOUNT_ID') ?? ''
  const apiToken = envValue('CLOUDFLARE_API_TOKEN') ?? ''
  const live =
    early.kind === 'candidate'
      ? await fetchLiveWorkerVersion({ accountId, apiToken, fetchImpl: fetch })
      : 'unknown'
  const summaryFile = envValue('GITHUB_STEP_SUMMARY')
  const decided = await runDeployRollback({
    context,
    diff,
    liveWorkerVersion: live,
    rollback: async (versionId, message) => runWranglerRollback(versionId, message),
    verify: verifyAfterRollback,
    notify: async (message) => {
      await sendSlack(message)
    },
    summarize: (message) => {
      if (summaryFile === undefined || summaryFile.trim().length === 0) {
        return
      }
      appendFileSync(summaryFile, `### deploy-rollback\n\n${message}\n`)
    },
    log: (line) => {
      console.log(line)
    },
  })
  return decided.exitCode
}

const command = process.argv[2]
const exitCode = await (command === 'cleanup'
  ? cleanup()
  : command === 'notify'
    ? notify()
    : command === 'export-outputs'
      ? exportOutputs()
      : command === 'rollback'
        ? rollback()
        : run())
process.exit(exitCode)
