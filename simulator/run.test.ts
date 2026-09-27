import { describe, expect, it } from 'vitest'
import { EMPTY_BAND_RATIO } from './image-band'
import { runSimulatorImageCheck } from './run-simulator'

describe('CrossPoint simulator_x3 image bands', () => {
  it('draws short HTML, Grok Bot 101, and the digest QR with native JPEGDEC', async () => {
    const checked = await runSimulatorImageCheck()
    const keep = checked.find((page) => page.id === 'keep-image')
    const drop = checked.find((page) => page.id === 'drop-image')
    const grok = checked.find((page) => page.id === 'grok-bot-101')
    const qr = checked.find((page) => page.id === 'digest-qr')
    expect(keep?.expect).toBe('image')
    expect(keep?.band?.height).toBeGreaterThanOrEqual(24)
    expect(keep?.inkRatio).toBeGreaterThan(EMPTY_BAND_RATIO)
    expect(drop?.expect).toBe('empty')
    expect(drop?.inkRatio).toBeLessThan(EMPTY_BAND_RATIO)
    expect(grok?.expect).toBe('image')
    expect(grok?.band?.height).toBeGreaterThanOrEqual(24)
    expect(grok?.inkRatio).toBeGreaterThan(EMPTY_BAND_RATIO)
    expect(qr?.expect).toBe('image')
    expect(qr?.band?.height).toBeGreaterThanOrEqual(24)
    expect(qr?.inkRatio).toBeGreaterThan(EMPTY_BAND_RATIO)
  })
})
