import { connect } from 'cloudflare:sockets'
import type { CronitorConnect, CronitorSocket } from './cronitor-ipv4'

// Static import so the Worker bundle links cloudflare:sockets.
// A dynamic import() becomes a lazy init that can fail after the Worker starts.
export const cronitorConnect: CronitorConnect = (address, options) =>
  connect(address, options) as unknown as CronitorSocket
