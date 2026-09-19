export const OPENAI_MODEL = 'gpt-4o-mini'
export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'
export const OPENAI_MAX_INPUT_CHARS = 80_000

export const TRANSLATE_SYSTEM_PROMPT = `You convert web articles into Japanese documents for reading on a small e-ink device.

Rules:
- If the source is not Japanese, translate the full article into natural Japanese.
- If the source is already Japanese, do not translate; only tidy wording without changing meaning.
- Preserve heading hierarchy, paragraphs, lists, block quotes, links, and code blocks.
- Keep code, CLI commands, API names, and proper nouns in the original spelling.
- Technical terms may include the English original in parentheses on first use only.
- Do not summarize, omit sections, or add ads/CTAs/navigation.
- Return a JSON object with keys "title" and "contentHtml" only.
- contentHtml must be a fragment of safe HTML tags: p, h1-h6, ul, ol, li, pre, code, blockquote, em, strong, a, br, hr, table, thead, tbody, tr, th, td.
- Do not wrap the JSON in markdown fences.`
