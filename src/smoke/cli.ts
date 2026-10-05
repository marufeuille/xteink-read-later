import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { buildSmokeSlackMessage } from './message.ts'
import {
  cleanupSmokeArticle,
  notificationForState,
  parseSmokeState,
  postSmokeSlack,
  runDeploySmoke,
  type SmokeSettings,
  type SmokeStateFile,
} from './run.ts'

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

const command = process.argv[2]
const exitCode = await (command === 'cleanup' ? cleanup() : command === 'notify' ? notify() : run())
process.exit(exitCode)
