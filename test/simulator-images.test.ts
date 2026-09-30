import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { isX3BaselineJpeg } from '../src/epub/x3-image'
import { buildSimulatorEpubs, loadSimulatorPages } from '../simulator/build-epubs'
import {
  CROSSPOINT_FIRMWARE_SHA,
  IMAGE_PAGE_DRAW_MS,
  inputScalesFor,
  openBookPlan,
  pageDrawMs,
  pinnedFirmwareGitSteps,
} from '../simulator/run-simulator'
import { checkImageBands } from '../simulator/check-bands'
import { decodeBmp, encodeBmp, findImageBand, type RgbImage } from '../simulator/image-band'
import { simulatorInputsDir } from '../simulator/paths'

function fill(width: number, height: number, paint: (x: number, y: number) => readonly [number, number, number]): RgbImage {
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y)
      const index = (y * width + x) * 3
      rgb[index] = r
      rgb[index + 1] = g
      rgb[index + 2] = b
    }
  }
  return { width, height, rgb }
}

function bitfieldsBmp(): Uint8Array {
  const width = 2
  const height = 1
  const header = 14 + 108
  const bytes = new Uint8Array(header + width * 4)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, header, true)
  view.setUint32(14, 108, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 32, true)
  view.setUint32(30, 3, true)
  view.setUint32(54, 0x00ff0000, true)
  view.setUint32(58, 0x0000ff00, true)
  view.setUint32(62, 0x000000ff, true)
  view.setUint32(66, 0xff000000, true)
  // Bottom-up row: black, then white. Memory order is B, G, R, A.
  bytes[header] = 0
  bytes[header + 1] = 0
  bytes[header + 2] = 0
  bytes[header + 3] = 0xff
  bytes[header + 4] = 0xff
  bytes[header + 5] = 0xff
  bytes[header + 6] = 0xff
  bytes[header + 7] = 0xff
  return bytes
}

describe('simulator image band', () => {
  it('round-trips a 24-bit BMP and reads a 32-bit screenshot pixel', () => {
    const image = fill(5, 4, (x, y) => [x * 10, y * 20, 7])
    expect(decodeBmp(encodeBmp(image))).toEqual(image)
    const decoded = decodeBmp(bitfieldsBmp())
    expect(Array.from(decoded.rgb.slice(0, 3))).toEqual([0, 0, 0])
    expect(Array.from(decoded.rgb.slice(3, 6))).toEqual([255, 255, 255])
  })

  it('treats a solid gray rectangle as an image band and ignores single ink rows', () => {
    const keep = fill(200, 120, (x, y) => (x >= 20 && x < 140 && y >= 40 && y < 90 ? [96, 96, 96] : [255, 255, 255]))
    const drop = fill(200, 120, () => [255, 255, 255])
    const stripes = fill(200, 80, (x, y) => (y % 2 === 0 && x < 100 ? [0, 0, 0] : [255, 255, 255]))
    expect(findImageBand(stripes)).toBeNull()
    const checked = checkImageBands([
      { id: 'keep', expect: 'image', bmp: keep },
      { id: 'drop', expect: 'empty', bandFrom: 'keep', bmp: drop },
    ])
    expect(checked[0]?.band?.height).toBeGreaterThanOrEqual(24)
    expect(checked[1]?.inkRatio).toBe(0)
    expect(() =>
      checkImageBands([
        { id: 'keep', expect: 'image', bmp: keep },
        { id: 'drop', expect: 'empty', bandFrom: 'keep', bmp: keep },
      ]),
    ).toThrow(/not empty/)
    const white = fill(80, 40, () => [255, 255, 255])
    expect(() => checkImageBands([{ id: 'keep-image', expect: 'image', bmp: white }])).toThrow(
      'keep-image: image band is still white (page ink 0.000)',
    )
  })
})

describe('pinned CrossPoint firmware', () => {
  it('fetches the pinned sha and its submodules', () => {
    const steps = pinnedFirmwareGitSteps('/tmp/crosspoint-reader').map((args) => args.join(' '))
    expect(steps).toEqual([
      'init /tmp/crosspoint-reader',
      '-C /tmp/crosspoint-reader remote add origin https://github.com/crosspoint-reader/crosspoint-reader.git',
      `-C /tmp/crosspoint-reader fetch --depth 1 origin ${CROSSPOINT_FIRMWARE_SHA}`,
      '-C /tmp/crosspoint-reader checkout --detach FETCH_HEAD',
      '-C /tmp/crosspoint-reader submodule update --init --recursive',
    ])
  })
})

describe('simulator short HTML inputs', () => {
  it('clips baseline and re-encoded progressive JPEGs, and drops a PNG', async () => {
    const pages = loadSimulatorPages()
    expect(pages.map((page) => [page.id, page.kind, page.expect, page.bandFrom, page.turns])).toEqual([
      ['keep-image', 'clip', 'image', undefined, 1],
      ['drop-image', 'clip', 'empty', 'keep-image', 1],
      ['grok-bot-101', 'clip', 'image', undefined, 0],
      ['digest-qr', 'digest', 'image', undefined, 2],
    ])
    expect(openBookPlan(1)).toEqual({
      script: '2000:ENTER;4000:ENTER;6000:ENTER;9000:DOWN;14000:QUIT',
      fileBrowserShotMs: 3000,
      booksShotMs: 5000,
      openingShotMs: 7500,
      pageShotMs: 12000,
      quitMs: 14000,
    })
    expect(openBookPlan(1, 2)).toEqual({
      script: '4000:ENTER;8000:ENTER;12000:ENTER;18000:DOWN;28000:QUIT',
      fileBrowserShotMs: 6000,
      booksShotMs: 10000,
      openingShotMs: 15000,
      pageShotMs: 24000,
      quitMs: 28000,
    })
    expect(inputScalesFor('image')).toEqual([1, 2])
    expect(inputScalesFor('empty')).toEqual([1])
    expect(pageDrawMs('image', 1)).toBe(IMAGE_PAGE_DRAW_MS)
    expect(pageDrawMs('image', 2)).toBe(IMAGE_PAGE_DRAW_MS * 2)
    expect(pageDrawMs('empty', 1)).toBe(3_000)
    expect(openBookPlan(1, 1, pageDrawMs('image', 1))).toEqual({
      script: '2000:ENTER;4000:ENTER;6000:ENTER;9000:DOWN;17000:QUIT',
      fileBrowserShotMs: 3000,
      booksShotMs: 5000,
      openingShotMs: 7500,
      pageShotMs: 15000,
      quitMs: 17000,
    })
    expect(openBookPlan(1, 2, pageDrawMs('image', 2))).toEqual({
      script: '4000:ENTER;8000:ENTER;12000:ENTER;18000:DOWN;34000:QUIT',
      fileBrowserShotMs: 6000,
      booksShotMs: 10000,
      openingShotMs: 15000,
      pageShotMs: 30000,
      quitMs: 34000,
    })
    expect(() => openBookPlan(1, 0)).toThrow(/scale/)
    expect(() => openBookPlan(1, 1, 0)).toThrow(/drawMs/)
    expect(() => pageDrawMs('image', 0)).toThrow(/scale/)
    const keepHtml = readFileSync(join(simulatorInputsDir(), 'keep-image.html'), 'utf8')
    const dropHtml = readFileSync(join(simulatorInputsDir(), 'drop-image.html'), 'utf8')
    const visible = (html: string): string => html.replace(/<img\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    expect(visible(keepHtml)).toBe(visible(dropHtml))

    const built = await buildSimulatorEpubs()
    const keep = unzipSync(built[0]?.epub ?? new Uint8Array())
    const drop = unzipSync(built[1]?.epub ?? new Uint8Array())
    const keepChapter = strFromU8(keep['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    const dropChapter = strFromU8(drop['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    const jpeg = keep['OEBPS/images/fig-1.jpg'] ?? new Uint8Array()
    expect(keepChapter).toContain('<img src="images/fig-1.jpg" alt=""/>')
    expect(isX3BaselineJpeg(jpeg)).toBe(true)
    expect(jpeg).toEqual(new Uint8Array(readFileSync(join(simulatorInputsDir(), 'images/keep.jpg'))))
    expect(dropChapter).not.toContain('<img')
    expect(drop['OEBPS/images/fig-1.jpg']).toBeUndefined()
    expect(dropChapter).toContain('画像の帯だけが違う')
    expect(keepChapter).toContain('画像の帯だけが違う')

    const grok = built.find((item) => item.page.id === 'grok-bot-101')
    const digest = built.find((item) => item.page.id === 'digest-qr')
    const grokFiles = unzipSync(grok?.epub ?? new Uint8Array())
    const digestFiles = unzipSync(digest?.epub ?? new Uint8Array())
    const grokChapter = strFromU8(grokFiles['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    const digestChapter = strFromU8(digestFiles['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    const grokSource = new Uint8Array(readFileSync(join(simulatorInputsDir(), 'images/grok-1.jpg')))
    const grokJpeg = grokFiles['OEBPS/images/fig-1.jpg'] ?? new Uint8Array()
    const grokNames = Object.keys(grokFiles).filter((name) => name.endsWith('.jpg'))
    expect(grokChapter).toContain('<img src="images/fig-1.jpg" alt=""/>')
    expect(isX3BaselineJpeg(grokSource)).toBe(false)
    expect(isX3BaselineJpeg(grokJpeg)).toBe(true)
    expect(grokJpeg).not.toEqual(grokSource)
    expect(grokJpeg.byteLength).toBeGreaterThan(1000)
    expect(grokNames).toHaveLength(11)
    for (const name of grokNames) {
      expect(isX3BaselineJpeg(grokFiles[name] ?? new Uint8Array())).toBe(true)
    }
    expect(digestChapter).toContain('class="digest-qr"')
    expect(digestChapter).not.toContain('[Image:')
    const digestNames = Object.keys(digestFiles).filter((name) => name.endsWith('.jpg'))
    expect(digestNames).toEqual(['OEBPS/images/qr-cand_0000000000000000000000000000000a.jpg'])
    expect(isX3BaselineJpeg(digestFiles[digestNames[0] ?? ''] ?? new Uint8Array())).toBe(true)
  })

  it('loads a page added next to the short HTML without a new code path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-pages-'))
    cpSync(simulatorInputsDir(), dir, { recursive: true })
    const html = readFileSync(join(dir, 'keep-image.html'), 'utf8').replaceAll('keep.jpg', 'later.jpg')
    writeFileSync(join(dir, 'later.html'), html)
    cpSync(join(dir, 'images/keep.jpg'), join(dir, 'images/later.jpg'))
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      pages: Record<string, unknown>[]
    }
    manifest.pages.push({
      id: 'later-page',
      html: 'later.html',
      url: 'https://example.com/simulator/later',
      image: 'images/later.jpg',
      imageUrl: 'https://cdn.example.com/simulator/later.jpg',
      expect: 'image',
    })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    expect(loadSimulatorPages(dir).map((page) => page.id)).toEqual([
      'keep-image',
      'drop-image',
      'grok-bot-101',
      'digest-qr',
      'later-page',
    ])

    const empty = manifest.pages[1]
    if (empty !== undefined) {
      delete empty.bandFrom
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    expect(() => loadSimulatorPages(dir)).toThrow(/bandFrom/)
  })
})
