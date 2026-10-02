// Node unit tests cannot load the Workers runtime module.
// The production bundle keeps the real `cloudflare:sockets` import.
export function connect(): never {
  throw new Error('cloudflare-sockets-stub')
}
