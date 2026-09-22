export function clipWebBookmarklet(workerOrigin: string): string {
  const url = new URL(workerOrigin)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('bookmarklet origin must be http(s)')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('bookmarklet origin must not include credentials')
  }
  const prefix = `${url.origin}/clip/web?url=`
  return `javascript:(function(){location.href=${JSON.stringify(prefix)}+encodeURIComponent(location.href)})()`
}
