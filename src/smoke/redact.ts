export function redactSmokeText(
  text: string,
  hidden: readonly string[],
  allowUrls: readonly string[] = [],
): string {
  const secrets = [...hidden].filter((item) => item.length >= 6).sort((left, right) => right.length - left.length)
  let out = text
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join('[redacted]')
    }
  }
  return out.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
    const trimmed = url.replace(/[),.;]+$/g, '')
    const suffix = url.slice(trimmed.length)
    if (allowUrls.includes(trimmed) || allowUrls.includes(url)) {
      return url
    }
    return `[redacted-url]${suffix}`
  })
}
