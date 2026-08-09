const FENCE_RE = /^```([^\n`]*)\n?([\s\S]*?)\n?```\s*$/;
const TOOL_SUMMARY_MAX = 120;

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Pretty-print tool payloads; unwrap JSON strings when stored as strings. */
export function formatJsonDisplay(value: unknown): string {
  if (typeof value === 'string') {
    const pretty = tryPrettyJsonString(value);
    return pretty ?? value;
  }
  return formatJson(value);
}

function findBalancedJsonSpan(
  text: string,
  startIdx: number,
): { start: number; end: number } | null {
  const opener = text[startIdx];
  if (opener !== '{' && opener !== '[') return null;
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return { start: startIdx, end: i + 1 };
    }
  }
  return null;
}

function unwrapMarkdownFence(
  text: string,
): { lang?: string; body: string } | null {
  const match = text.trim().match(FENCE_RE);
  if (!match) return null;
  const lang = match[1]?.trim();
  return {
    ...(lang ? { lang } : {}),
    body: match[2]!.trim(),
  };
}

function tryParseJson(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function prettyJsonValue(value: unknown): string | null {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === 'string') {
    const inner = value.trim();
    if (
      (inner.startsWith('{') && inner.endsWith('}')) ||
      (inner.startsWith('[') && inner.endsWith(']'))
    ) {
      const reparsed = tryParseJson(inner);
      if (reparsed !== null) return JSON.stringify(reparsed, null, 2);
    }
    return null;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return null;
}

function tryPrettyJsonString(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const direct = tryParseJson(trimmed);
  if (direct !== null) {
    return prettyJsonValue(direct);
  }
  return null;
}

function jsonCodeBlock(body: string, lang = 'json'): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function tryFormatNdjson(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const parsed: unknown[] = [];
  for (const line of lines) {
    if (!line.startsWith('{') && !line.startsWith('[')) return null;
    const value = tryParseJson(line);
    if (value === null) return null;
    parsed.push(value);
  }

  const body = parsed.map((row) => JSON.stringify(row, null, 2)).join('\n\n');
  return jsonCodeBlock(body);
}

interface EmbeddedJson {
  prefix: string;
  json: string;
  suffix: string;
}

function tryExtractEmbeddedJson(text: string): EmbeddedJson | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;

    const span = findBalancedJsonSpan(text, i);
    if (!span) continue;

    const jsonSlice = text.slice(span.start, span.end);
    const pretty = tryPrettyJsonString(jsonSlice);
    if (!pretty) continue;

    const prefix = text.slice(0, span.start).trimEnd();
    const suffix = text.slice(span.end).trimStart();
    if (!prefix && !suffix) {
      return { prefix: '', json: pretty, suffix: '' };
    }

    const compactTotal = text.replace(/\s/g, '').length;
    const compactJson = pretty.replace(/\s/g, '').length;
    const jsonRatio = compactJson / Math.max(compactTotal, 1);
    if (jsonRatio >= 0.35 || prefix.length < 160) {
      return { prefix, json: pretty, suffix };
    }
  }
  return null;
}

/**
 * Render assistant text as markdown; detect lone / embedded / fenced / NDJSON JSON
 * and wrap in a pretty-printed ```json fence for MarkdownView.
 */
export function assistantMarkdownContent(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (!trimmed) return text;

  const fenced = unwrapMarkdownFence(trimmed);
  if (fenced) {
    const pretty = tryPrettyJsonString(fenced.body);
    if (pretty) {
      const lang =
        fenced.lang && fenced.lang.toLowerCase() !== 'json'
          ? fenced.lang
          : 'json';
      return jsonCodeBlock(pretty, lang);
    }
    return trimmed;
  }

  const pure = tryPrettyJsonString(trimmed);
  if (pure) return jsonCodeBlock(pure);

  const ndjson = tryFormatNdjson(trimmed);
  if (ndjson) return ndjson;

  const embedded = tryExtractEmbeddedJson(trimmed);
  if (embedded) {
    const block = jsonCodeBlock(embedded.json);
    const parts: string[] = [];
    if (embedded.prefix) parts.push(embedded.prefix);
    parts.push(block);
    if (embedded.suffix) parts.push(embedded.suffix);
    return parts.join('\n\n');
  }

  return text;
}

/** While streaming, use monospace when the partial body looks like JSON. */
export function looksLikeStreamingJson(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  if (t.startsWith('```')) return true;
  return t.startsWith('{') || t.startsWith('[');
}

/** One-line tool summary; hide JSON blobs and truncate long prose. */
export function toolSummaryMessage(
  message: string | undefined,
): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  if (tryPrettyJsonString(trimmed)) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return undefined;
  if (trimmed.length <= TOOL_SUMMARY_MAX) return trimmed;
  return `${trimmed.slice(0, TOOL_SUMMARY_MAX - 1)}…`;
}
