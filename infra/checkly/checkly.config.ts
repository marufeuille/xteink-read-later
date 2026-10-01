import { defineConfig } from 'checkly'
import { Frequency } from 'checkly/constructs'

/**
 * Access 外形監視プロジェクト（Hobby）。
 * Deploy: CHECKLY_API_KEY + CHECKLY_ACCOUNT_ID を環境に置き、このディレクトリで `npm i && npx checkly deploy`。
 * 秘密はリポジトリに置かない。GitHub Actions secret 化は後続。
 */
export default defineConfig({
  projectName: 'xteink-read-later-access',
  logicalId: 'xteink-read-later-access',
  repoUrl: 'https://github.com/marufeuille/xteink-read-later',
  checks: {
    activated: true,
    muted: false,
    frequency: Frequency.EVERY_5M,
    // Hobby: 最大 6 locations、check あたり最大 3
    locations: ['us-east-1', 'eu-west-1', 'ap-northeast-1'],
    tags: ['xteink', 'access', 'mar-151'],
    checkMatch: '**/__checks__/**/*.check.ts',
    runtimeId: '2025.04',
  },
  cli: {
    runLocation: 'ap-northeast-1',
  },
})
