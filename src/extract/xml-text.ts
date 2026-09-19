const XML_ILLEGAL_C0 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g
const IMG_ALT_MAX = 200

export function stripXmlIllegalChars(value: string): string {
  return value.replace(XML_ILLEGAL_C0, '')
}

export function imgAltText(alt: string): string {
  const collapsed = alt.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= IMG_ALT_MAX) {
    return collapsed
  }
  return collapsed.slice(0, IMG_ALT_MAX)
}
