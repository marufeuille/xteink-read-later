import { ApiCheck, AssertionBuilder } from 'checkly/constructs'

const ORIGIN = 'https://xteink-read-later.marufeuille.workers.dev'

/**
 * Access 壁あり: /books → 302 + Location に cloudflareaccess.com。
 * followRedirects は必ず false（追うと壁を検証できない）。
 */
new ApiCheck('xteink-books-access-wall', {
  name: 'xteink-books-access-wall',
  tags: ['xteink', 'access', 'books'],
  maxResponseTime: 10000,
  degradedResponseTime: 5000,
  request: {
    method: 'GET',
    url: `${ORIGIN}/books`,
    followRedirects: false,
    skipSSL: false,
    assertions: [
      AssertionBuilder.statusCode().equals(302),
      AssertionBuilder.headers('Location').contains('cloudflareaccess.com'),
    ],
  },
})

/**
 * Access 壁なし: /digest/send → Worker 404。
 * 「request should fail」は使わない。status equals 404 で正常とする。
 */
new ApiCheck('xteink-digest-send-no-access', {
  name: 'xteink-digest-send-no-access',
  tags: ['xteink', 'access', 'digest'],
  maxResponseTime: 10000,
  degradedResponseTime: 5000,
  request: {
    method: 'GET',
    url: `${ORIGIN}/digest/send`,
    followRedirects: false,
    skipSSL: false,
    assertions: [AssertionBuilder.statusCode().equals(404)],
  },
})
