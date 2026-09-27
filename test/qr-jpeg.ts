import { decode } from 'jpeg-js'
import { isX3BaselineJpeg } from '../src/epub/x3-image'

export type QrJpegView = {
  readonly width: number
  readonly height: number
  readonly border: readonly [number, number, number]
  readonly darkest: number
}

/** Baseline JPEG with a white border and at least one dark module. */
export function readQrJpeg(bytes: Uint8Array): QrJpegView {
  if (!isX3BaselineJpeg(bytes)) {
    throw new Error('QR is not an X3 baseline JPEG')
  }
  const image = decode(bytes, { useTArray: true, formatAsRGBA: true })
  let darkest = 255
  for (let index = 0; index < image.data.length; index += 4) {
    const pixel = image.data[index] ?? 255
    if (pixel < darkest) {
      darkest = pixel
    }
  }
  return {
    width: image.width,
    height: image.height,
    border: [image.data[0] ?? 0, image.data[1] ?? 0, image.data[2] ?? 0],
    darkest,
  }
}
