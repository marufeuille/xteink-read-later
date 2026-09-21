export const OPENAI_MODEL = 'gpt-5.6-luna'
export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'
export const OPENAI_MAX_INPUT_CHARS = 80_000
export const OPENAI_MAX_COMPLETION_TOKENS = 16_000
export const OPENAI_REASONING_EFFORT = 'none'
export const TRANSLATE_TIMEOUT_MS = 60_000

export const TRANSLATE_SYSTEM_PROMPT = `You convert web articles into Japanese Markdown for later EPUB conversion.

The user message is JSON. "content" is compact Markdown (headings, paragraphs, lists, links, fenced code). It is not raw page HTML and not an EPUB.

Rules:
- If the source is not Japanese, translate the full article into natural Japanese Markdown.
- If the source is already Japanese, do not translate; only tidy wording without changing meaning.
- Preserve heading hierarchy, paragraphs, lists, block quotes, links, and fenced code blocks.
- Keep code, CLI commands, API names, and proper nouns in the original spelling.
- Technical terms may include the English original in parentheses on first use only.
- Do not summarize, omit sections, or add ads/CTAs/navigation.
- Return a JSON object with keys "title" and "content" only.
- "content" must be Markdown, not HTML, and not an EPUB/XHTML document.
- Do not wrap the JSON object in markdown fences.`
