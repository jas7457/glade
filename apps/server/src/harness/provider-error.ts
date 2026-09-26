/**
 * Turn raw provider error strings into something a person can read.
 *
 * Providers (via their SDKs) report failures as text like
 *   `400 {"type":"error","error":{"type":"invalid_request_error","message":"…"},"request_id":"…"}`
 * (Anthropic) or `429 {"error":{"message":"…","type":"…","code":"…"}}` (OpenAI / Google), sometimes
 * with prefix text ("Error: …"). `readableError` pulls out the human message and keeps the raw
 * text as details. Pure and harness-agnostic, so any adapter can use it.
 */

export interface ReadableError {
  /** Human-readable message, e.g. "Image exceeds 10 MB maximum (10.8 MB > 10 MB)". */
  message: string;
  /** The raw error text, only when it differs from `message`. */
  details?: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Find the first `{…}` / `[…]` in the text that parses as JSON. */
function findJson(text: string): unknown {
  let starts = 0;
  for (let i = 0; i < text.length && starts < 3; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    starts++;
    const close = ch === "{" ? "}" : "]";
    // Try the longest candidate first (the JSON body usually runs to the end).
    for (let end = text.lastIndexOf(close); end > i; end = text.lastIndexOf(close, end - 1)) {
      try {
        return JSON.parse(text.slice(i, end + 1));
      } catch {
        // keep shrinking
      }
    }
  }
  return undefined;
}

/** Pull a message out of the common error body shapes. */
function messageFromBody(body: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (Array.isArray(body)) return body.length ? messageFromBody(body[0], depth + 1) : undefined;
  if (typeof body === "string") {
    const nested = findJson(body);
    return nested !== undefined ? messageFromBody(nested, depth + 1) : body.trim() || undefined;
  }
  if (!isObject(body)) return undefined;
  // { error: { message } } (Anthropic, OpenAI, Google) or { error: "text" }
  if (body.error !== undefined) {
    const inner = messageFromBody(body.error, depth + 1);
    if (inner) return inner;
  }
  if (typeof body.message === "string" && body.message.trim()) {
    const nested = findJson(body.message);
    return (nested !== undefined && messageFromBody(nested, depth + 1)) || body.message.trim();
  }
  if (typeof body.detail === "string" && body.detail.trim()) return body.detail.trim();
  return undefined;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number(mb.toFixed(mb >= 10 ? 1 : 2))} MB`;
}

/** Light cleanup of the extracted message. */
function polish(message: string): string {
  let text = message.trim();
  // Anthropic prefixes validation errors with the request field path:
  // "messages.0.content.1.image.source.base64: image exceeds …".
  text = text.replace(/^[A-Za-z_]\w*(?:\.\w+|\[\d+\])+:\s+/, "");
  // "11324160 bytes > 10485760 bytes" → "10.8 MB > 10 MB"
  text = text.replace(/:\s*(\d{6,}) bytes\s*>\s*(\d{6,}) bytes/, (_, a: string, b: string) => ` (${formatBytes(Number(a))} > ${formatBytes(Number(b))})`);
  text = text.replace(/\b(\d{6,}) bytes\b/g, (_, a: string) => formatBytes(Number(a)));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function readableError(raw: string): ReadableError {
  const text = raw.trim();
  if (!text) return { message: raw };
  const body = findJson(text);
  const extracted = body !== undefined ? messageFromBody(body) : undefined;
  const message = polish(extracted ?? text);
  // Don't repeat the raw text as "details" when all we did was capitalize it.
  return message.toLowerCase() === text.toLowerCase() ? { message } : { message, details: text };
}
