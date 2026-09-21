import type { GetAccessIdentity } from '../src/http/access-identity'

export const TEST_CLIP_TOKEN = 'clip-test-token'
export const TEST_OPDS_USERNAME = 'xteink'
export const TEST_OPDS_PASSWORD = 'opds-secret'
export const TEST_ACCESS_EMAIL = 'admin@example.com'

export const TEST_BINDINGS = {
  OPENAI_API_KEY: 'sk-test',
  OPENROUTER_API_KEY: '',
  CLIP_TOKEN: TEST_CLIP_TOKEN,
  OPDS_USERNAME: TEST_OPDS_USERNAME,
  OPDS_PASSWORD: TEST_OPDS_PASSWORD,
} as Cloudflare.Env

export function accessIdentity(email = TEST_ACCESS_EMAIL): {
  readonly getAccessIdentity: GetAccessIdentity
} {
  return {
    getAccessIdentity: async () => ({ email }),
  }
}

export function bearerAuthorization(token = TEST_CLIP_TOKEN): string {
  return `Bearer ${token}`
}

export function basicAuthorization(
  username = TEST_OPDS_USERNAME,
  password = TEST_OPDS_PASSWORD,
): string {
  return `Basic ${btoa(`${username}:${password}`)}`
}
