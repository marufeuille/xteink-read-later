import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, '.github/scripts/access-terraform.sh')
const workflow = readFileSync(join(root, '.github/workflows/access-terraform.yml'), 'utf8')
const temps: string[] = []

const addresses = [
  'cloudflare_zero_trust_access_policy.family',
  'cloudflare_zero_trust_access_application.xteink_read_later',
  'cloudflare_zero_trust_access_policy.digest_send_bypass',
  'cloudflare_zero_trust_access_application.digest_send',
]

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'access-tf-'))
  temps.push(dir)
  return dir
}

function run(args: string[], env: Record<string, string> = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, LANG: 'C.UTF-8' }
  for (const name of [
    'CLOUDFLARE_API_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'GITHUB_SHA',
    'GITHUB_SERVER_URL',
    'GITHUB_REPOSITORY',
    'GITHUB_RUN_ID',
  ]) {
    delete childEnv[name]
  }
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...childEnv, ...env },
  })
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('access terraform guard', () => {
  it('accepts in-place updates and creates of other resources', () => {
    const dir = tempDir()
    const plan = join(dir, 'plan.txt')
    writeFileSync(
      plan,
      [
        '  # cloudflare_zero_trust_access_application.xteink_read_later will be updated in-place',
        '  # cloudflare_zero_trust_access_policy.extra will be created',
        'No changes. Your infrastructure matches the configuration.',
      ].join('\n'),
    )
    const result = run(['plan-guard', plan])
    expect(result.status, result.stderr).toBe(0)
  })

  it.each([
    'will be created',
    'will be destroyed',
    'must be replaced',
  ])('rejects an imported resource that %s', (verb) => {
    const dir = tempDir()
    const plan = join(dir, 'plan.txt')
    writeFileSync(plan, `  # cloudflare_zero_trust_access_policy.family ${verb}\n`)
    const result = run(['plan-guard', plan])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('cloudflare_zero_trust_access_policy.family')
    expect(result.stderr).not.toContain('supersecretvalue')
  })

  it('accepts a state list that contains the four imported addresses', () => {
    const dir = tempDir()
    const list = join(dir, 'state.txt')
    writeFileSync(list, `${addresses.join('\n')}\ncloudflare_workers_script.extra\n`)
    expect(run(['state-guard', list]).status).toBe(0)
  })

  it('rejects a state list that is missing an imported address', () => {
    const dir = tempDir()
    const list = join(dir, 'state.txt')
    writeFileSync(list, addresses.slice(0, 3).join('\n'))
    const result = run(['state-guard', list])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('cloudflare_zero_trust_access_application.digest_send')
  })

  it('fails closed when the plan file is missing', () => {
    const result = run(['plan-guard', join(tempDir(), 'missing.txt')])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('file not found')
  })
})

describe('access terraform comment and redaction', () => {
  it('does not print credential values and keeps command text literal', () => {
    const dir = tempDir()
    const plan = join(dir, 'plan.txt')
    const secret = 'supersecretvalue'
    writeFileSync(
      plan,
      [
        `token ${secret} leaked`,
        'AWS_SECRET_ACCESS_KEY=anothersecretvalue',
        'Authorization: Bearer rawtokenvalue',
        'note ``` not a fence',
        '$(echo injected)',
      ].join('\n'),
    )
    const result = run(['comment', plan], {
      CLOUDFLARE_API_TOKEN: secret,
      GITHUB_SHA: 'abc123',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('<!-- access-terraform-plan -->')
    expect(result.stdout).toContain('Commit `abc123`')
    expect(result.stdout).toContain('[REDACTED]')
    expect(result.stdout).toContain('$(echo injected)')
    expect(result.stdout).not.toContain(secret)
    expect(result.stdout).not.toContain('anothersecretvalue')
    expect(result.stdout).not.toContain('rawtokenvalue')
    expect(result.stdout.match(/```/g)).toHaveLength(2)
    expect(result.stderr).not.toContain(secret)
  })

  it('truncates a huge plan and still explains the import gap', () => {
    const dir = tempDir()
    const plan = join(dir, 'plan.txt')
    writeFileSync(plan, 'x'.repeat(60_000))
    const result = run(['comment', plan])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.length).toBeLessThan(60_000)
    expect(result.stdout).toContain('切った')
    expect(result.stdout).toContain('マージしない')
  })

  it('comments when the plan file was not captured', () => {
    const result = run(['comment', join(tempDir(), 'missing.txt')])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('plan output was not captured')
  })

  it('reports missing credential names without printing values that are set', () => {
    const result = run(['require-env', 'CLOUDFLARE_API_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], {
      CLOUDFLARE_API_TOKEN: 'supersecretvalue',
      AWS_SECRET_ACCESS_KEY: 'presentsecret',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AWS_ACCESS_KEY_ID')
    expect(result.stderr).toContain('ACCESS_CLOUDFLARE_API_TOKEN')
    expect(result.stderr).not.toContain('supersecretvalue')
    expect(result.stderr).not.toContain('presentsecret')
    expect(result.stdout).toBe('')
  })

  it('accepts non-empty credentials without printing them', () => {
    const result = run(['require-env', 'CLOUDFLARE_API_TOKEN'], {
      CLOUDFLARE_API_TOKEN: 'supersecretvalue',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('supersecretvalue')
  })
})

describe('access terraform workflow', () => {
  const apply = workflow.split('\n  apply:')[1] ?? ''
  const plan = workflow.split('\n  plan:')[1]?.split('\n  apply:')[0] ?? ''

  it('plans on pull requests and applies only on main', () => {
    const onAt = workflow.indexOf('\non:')
    const jobsAt = workflow.indexOf('\njobs:')
    const triggers = workflow.slice(onAt, jobsAt)
    expect(workflow).toContain('hashicorp/setup-terraform@v4')
    expect(workflow).toContain("terraform_version: '1.14.9'")
    expect(workflow).toContain('working-directory: infra/access')
    expect(workflow).toContain('infra/access/**')
    expect(workflow).toContain('.github/workflows/access-terraform.yml')
    expect(workflow).toContain('.github/scripts/access-terraform.sh')
    expect(workflow).toContain('ACCESS_CLOUDFLARE_API_TOKEN')
    expect(workflow).toContain('ACCESS_TF_STATE_ACCESS_KEY_ID')
    expect(workflow).toContain('ACCESS_TF_STATE_SECRET_ACCESS_KEY')
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.ACCESS_CLOUDFLARE_API_TOKEN }}')
    expect(workflow).not.toContain('secrets.CLOUDFLARE_API_TOKEN')
    expect(triggers).toContain('\n  pull_request:\n')
    expect(triggers).not.toContain('pull_request_target')
    expect(triggers).not.toContain('workflow_dispatch')
    expect(workflow).not.toMatch(/terraform [^\n]*-migrate-state/)
    expect(workflow).not.toMatch(/TF_LOG\s*=/)
    expect(workflow).not.toMatch(/^\s*environment:/m)
    expect(plan).toContain("github.event_name == 'pull_request'")
    expect(plan).toContain('head.repo.fork == false')
    expect(plan).toContain('terraform plan -input=false -no-color -out=tfplan')
    expect(plan).toContain('access-terraform-plan')
    expect(apply).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'")
    expect(apply).toContain('terraform apply -input=false -auto-approve tfplan')
    expect(apply).not.toContain('pull_request')
  })

  it('keeps the Workers deploy token on the deploy workflow', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('secrets.CLOUDFLARE_API_TOKEN')
    expect(ci).not.toContain('ACCESS_CLOUDFLARE_API_TOKEN')
  })
})

describe('access terraform docs', () => {
  const files = [
    'README.md',
    'docs/access-as-code.md',
    'infra/access/README.md',
    'infra/access/main.tf',
    'infra/access/versions.tf',
  ].map((path) => readFileSync(join(root, path), 'utf8'))
  const docs = files.join('\n')
  const banned = [
    'リモート backend は置かない',
    'CI では apply しない',
    'GitHub Actions で apply しない',
    'CI はこのディレクトリを実行しない',
    'CI では `terraform plan` も `terraform apply` もしない',
    '定期 plan を GitHub Actions に載せる変更は',
    'CI に Cloudflare の認証情報は置かない',
    'apply は手元だけ',
    'CI では適用しない',
  ]

  it('replaces the old local-only policy', () => {
    for (const phrase of banned) expect(docs).not.toContain(phrase)
    expect(docs).toContain('xteink-read-later-tfstate')
    expect(docs).toContain('access/terraform.tfstate')
    expect(docs).toContain('ee3ee1637004c64111483d968da0f5b1.r2.cloudflarestorage.com')
    expect(docs).toContain('ACCESS_CLOUDFLARE_API_TOKEN')
    expect(docs).toContain('ACCESS_TF_STATE_ACCESS_KEY_ID')
    expect(docs).toContain('ACCESS_TF_STATE_SECRET_ACCESS_KEY')
    expect(docs).toContain('terraform init -migrate-state')
    expect(docs).toContain('skip_credentials_validation')
    expect(docs).toContain('use_lockfile')
  })
})
