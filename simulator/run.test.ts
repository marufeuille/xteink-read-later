import { describe, expect, it } from 'vitest'
import { EMPTY_BAND_RATIO } from './image-band'
import { runSimulatorImageCheck } from './run-simulator'

describe('CrossPoint simulator_x3 image bands', () => {
  it('opens the short HTML epubs with native JPEGDEC', async () => {
    const checked = await runSimulatorImageCheck()
    const keep = checked.find((page) => page.id === 'keep-image')
    const drop = checked.find((page) => page.id === 'drop-image')
    expect(keep?.expect).toBe('image')
    expect(keep?.band?.height).toBeGreaterThanOrEqual(24)
    expect(keep?.inkRatio).toBeGreaterThan(EMPTY_BAND_RATIO)
    expect(drop?.expect).toBe('empty')
    expect(drop?.inkRatio).toBeLessThan(EMPTY_BAND_RATIO)
  }, 600_000)
})
