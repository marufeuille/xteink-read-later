import { describe, expect, it } from 'vitest'
import { parseClipShareText } from '../src/http/clip-request'

describe('parseClipShareText', () => {
  it('reads JSON url and falls back to text', () => {
    expect(parseClipShareText('application/json', '{"url":"https://example.com/a"}')).toBe(
      'https://example.com/a',
    )
    expect(
      parseClipShareText('application/json; charset=utf-8', '{"text":"https://example.com/a"}'),
    ).toBe('https://example.com/a')
    expect(parseClipShareText('application/json', '{"href":"https://example.com/a"}')).toBeNull()
    expect(parseClipShareText('application/json', '{')).toBeNull()
  })

  it('reads text/plain share bodies', () => {
    expect(parseClipShareText('text/plain', '  https://example.com/a  ')).toBe('https://example.com/a')
    expect(parseClipShareText('text/plain', '   ')).toBeNull()
  })

  it('reads form-urlencoded url, text, or link', () => {
    expect(
      parseClipShareText('application/x-www-form-urlencoded', 'url=https%3A%2F%2Fexample.com%2Fa'),
    ).toBe('https://example.com/a')
    expect(
      parseClipShareText('application/x-www-form-urlencoded', 'text=https%3A%2F%2Fexample.com%2Fa'),
    ).toBe('https://example.com/a')
    expect(parseClipShareText('application/x-www-form-urlencoded', 'title=Hello')).toBeNull()
  })
})
