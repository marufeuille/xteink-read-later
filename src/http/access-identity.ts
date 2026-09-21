import type { Context } from 'hono'
import type { AppEnv } from '../types'

export type AccessIdentity = {
  readonly email: string
}

export type GetAccessIdentity = (c: Context<AppEnv>) => Promise<AccessIdentity | null>

export async function defaultGetAccessIdentity(c: Context<AppEnv>): Promise<AccessIdentity | null> {
  try {
    const email = (await (c.executionCtx as ExecutionContext).access?.getIdentity())?.email?.trim() ?? ''
    return email.length === 0 ? null : { email }
  } catch {
    return null
  }
}
