import { encode } from 'jpeg-js'
import { encode as encodeQr } from 'uqr'
import { X3_IMAGE_MAX_HEIGHT, X3_IMAGE_MAX_WIDTH } from '../images/x3-token'

declare module 'jpeg-js' {
  export function encode(
    image: { readonly data: Uint8Array; readonly width: number; readonly height: number },
    quality?: number,
  ): { readonly data: Uint8Array; readonly width: number; readonly height: number }

  export function decode(
    jpegData: Uint8Array,
    options?: { readonly useTArray?: boolean; readonly formatAsRGBA?: boolean },
  ): { readonly data: Uint8Array; readonly width: number; readonly height: number }
}

/** Stay sharp enough to scan, and inside the box CrossPoint will still draw. */
const MODULE_SCALE = 6
const QR_JPEG_QUALITY = 95

function fittedScale(modules: number): number {
  const maxScale = Math.min(
    Math.floor(X3_IMAGE_MAX_WIDTH / modules),
    Math.floor(X3_IMAGE_MAX_HEIGHT / modules),
  )
  if (maxScale < 2) {
    throw new Error(`QR is too large for an X3 image (${modules} modules)`)
  }
  return Math.min(MODULE_SCALE, maxScale)
}

/**
 * Baseline JPEG inside the X3 box.
 * The device still shows the digest PNG as the alt text "[Image: 全文を送る]".
 * Article figures already draw through JPEGDEC, so the QR uses that path.
 * The same text always yields the same bytes.
 */
export function qrJpeg(text: string): Uint8Array {
  const qr = encodeQr(text, { ecc: 'M', border: 4 })
  const scale = fittedScale(qr.size)
  const size = qr.size * scale
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const modules = qr.data[Math.floor(y / scale)]
    const row = y * size * 4
    for (let x = 0; x < size; x += 1) {
      const value = modules?.[Math.floor(x / scale)] === true ? 0 : 255
      const pixel = row + x * 4
      rgba[pixel] = value
      rgba[pixel + 1] = value
      rgba[pixel + 2] = value
      rgba[pixel + 3] = 255
    }
  }
  const encoded = encode({ data: rgba, width: size, height: size }, QR_JPEG_QUALITY)
  return new Uint8Array(encoded.data)
}
