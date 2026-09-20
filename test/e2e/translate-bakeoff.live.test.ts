import { describe, expect, it } from 'vitest'
import { runTranslateBakeoff } from '../../src/translate/bakeoff-run'

const live = process.env.TRANSLATE_BAKEOFF === '1'

describe.skipIf(!live)('translate bakeoff live', () => {
  it(
    'runs gpt-4o-mini, gpt-4.1-mini, and plamo-3.0-prime on the pinned corpus',
    async () => {
      const results = await runTranslateBakeoff()
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
      expect(results).toHaveLength(12)
    },
    180_000,
  )
})
