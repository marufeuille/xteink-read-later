const XML_ILLEGAL_C0 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g
const IMG_ALT_MAX = 200

export function stripXmlIllegalChars(value: string): string {
  return value.replace(XML_ILLEGAL_C0, '')
}

export function stripPageCliWarnings(value: string): string {
  return value
    .split('\n')
    .flatMap((line) => {
      const stripped = line.replace(/WARN-BAR-BAND-WIDTH-TOO-NARROW|WARN-TABLE-COLUMNS-OVERFLOW/g, '')
      if (stripped === line) {
        return [line]
      }
      return stripped.trim().length === 0 ? [] : [stripped.replace(/[ \t]+$/g, '')]
    })
    .join('\n')
}

export function imgAltText(alt: string): string {
  const collapsed = alt.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= IMG_ALT_MAX) {
    return collapsed
  }
  return collapsed.slice(0, IMG_ALT_MAX)
}
