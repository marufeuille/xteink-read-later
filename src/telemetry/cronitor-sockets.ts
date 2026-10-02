import { connect } from 'cloudflare:sockets'
import type { CronitorConnect, CronitorSocket } from './cronitor-ipv4'

// Static import so the Worker bundle links cloudflare:sockets.
// A variable import() is left unresolved and the ping falls back to fetch.
export const cronitorConnect: CronitorConnect = (address, options) =>
  connect(address, options) as unknown as CronitorSocket
