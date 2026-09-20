import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatBakeoffSummary, writeBakeoffArtifacts } from '../../src/translate/bakeoff-report'
import { BAKEOFF_RUN_COUNT, runTranslateBakeoff } from '../../src/translate/bakeoff-run'

const live = process.env.TRANSLATE_BAKEOFF === '1'
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe.skipIf(!live)('translate bakeoff live', () => {
  it(
    'runs gpt-4o-mini, gpt-4.1-mini, gpt-5.6-luna, and plamo-3.0-prime on the pinned corpus',
    async () => {
      const results = await runTranslateBakeoff()
      const dir = writeBakeoffArtifacts(repoRoot, results)
      process.stdout.write(`${formatBakeoffSummary(results)}\nartifacts: ${dir}\n`)
      expect(results).toHaveLength(BAKEOFF_RUN_COUNT)
    },
    300_000,
  )
})
