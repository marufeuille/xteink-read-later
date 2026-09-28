import { readFileSync } from 'node:fs'
import {
  decodeBmp,
  EMPTY_BAND_RATIO,
  findImageBand,
  inkRatio,
  type ImageBand,
  type RgbImage,
} from './image-band'
import type { SimulatorExpect } from './build-epubs'

export type ShotPage = {
  readonly id: string
  readonly expect: SimulatorExpect
  readonly bandFrom?: string
  readonly bmp: RgbImage
}

export type CheckedPage = {
  readonly id: string
  readonly expect: SimulatorExpect
  readonly band: ImageBand | null
  readonly inkRatio: number
}

function sameSize(left: RgbImage, right: RgbImage): boolean {
  return left.width === right.width && left.height === right.height
}

function whiteImageError(id: string, image: RgbImage): Error {
  const pageInk = inkRatio(image, { x: 0, y: 0, width: image.width, height: image.height })
  return new Error(`${id}: image band is still white (page ink ${pageInk.toFixed(3)})`)
}

/** Image pages must show a non-white band. Empty pages must leave that band white. */
export function checkImageBands(pages: readonly ShotPage[]): readonly CheckedPage[] {
  const byId = new Map(pages.map((page) => [page.id, page]))
  const checked: CheckedPage[] = []
  for (const page of pages) {
    if (page.expect === 'image') {
      const band = findImageBand(page.bmp)
      if (band === null) {
        throw whiteImageError(page.id, page.bmp)
      }
      const ratio = inkRatio(page.bmp, band)
      if (ratio < EMPTY_BAND_RATIO) {
        throw new Error(`${page.id}: image band ink ratio ${ratio.toFixed(3)} is empty`)
      }
      checked.push({ id: page.id, expect: page.expect, band, inkRatio: ratio })
      continue
    }

    const sourceId = page.bandFrom
    const source = sourceId === undefined ? undefined : byId.get(sourceId)
    if (source === undefined || source.expect !== 'image') {
      throw new Error(`${page.id}: bandFrom ${sourceId ?? ''} is not an image page`)
    }
    const band = findImageBand(source.bmp)
    if (band === null) {
      throw whiteImageError(source.id, source.bmp)
    }
    if (!sameSize(page.bmp, source.bmp)) {
      throw new Error(
        `${page.id}: screenshot ${page.bmp.width}x${page.bmp.height} does not match ${source.id} ${source.bmp.width}x${source.bmp.height}`,
      )
    }
    const ratio = inkRatio(page.bmp, band)
    if (ratio >= EMPTY_BAND_RATIO) {
      throw new Error(`${page.id}: discarded image band is not empty (ink ratio ${ratio.toFixed(3)})`)
    }
    if (findImageBand(page.bmp) !== null) {
      throw new Error(`${page.id}: discarded page still has an image band`)
    }
    checked.push({ id: page.id, expect: page.expect, band, inkRatio: ratio })
  }
  return checked
}

export function checkScreenshotFiles(
  pages: readonly {
    readonly id: string
    readonly expect: SimulatorExpect
    readonly bandFrom?: string
    readonly path: string
  }[],
): readonly CheckedPage[] {
  return checkImageBands(
    pages.map((page) => {
      const shot = {
        id: page.id,
        expect: page.expect,
        bmp: decodeBmp(new Uint8Array(readFileSync(page.path))),
        ...(page.bandFrom === undefined ? {} : { bandFrom: page.bandFrom }),
      }
      return shot
    }),
  )
}
