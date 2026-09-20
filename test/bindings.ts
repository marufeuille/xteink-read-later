export const TEST_CLIP_TOKEN = 'clip-test-token'
export const TEST_OPDS_USERNAME = 'xteink'
export const TEST_OPDS_PASSWORD = 'opds-secret'

export const TEST_BINDINGS = {
  OPENAI_API_KEY: 'sk-test',
  OPENROUTER_API_KEY: '',
  CLIP_TOKEN: TEST_CLIP_TOKEN,
  OPDS_USERNAME: TEST_OPDS_USERNAME,
  OPDS_PASSWORD: TEST_OPDS_PASSWORD,
} as Cloudflare.Env

export function bearerAuthorization(token = TEST_CLIP_TOKEN): string {
  return `Bearer ${token}`
}

export function basicAuthorization(
  username = TEST_OPDS_USERNAME,
  password = TEST_OPDS_PASSWORD,
): string {
  return `Basic ${btoa(`${username}:${password}`)}`
}
