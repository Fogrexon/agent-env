import {
  boundedObservationSchema,
  type ArtifactHandle,
  type BoundedObservation,
  type ObservationSource,
  type ObservationStatus,
} from '@agent-env/shared';

const DEFAULT_MAX_CHARS = 8_000;
const TRUNCATION_MARKER = '\n…[truncated]';

export interface ShapeObservationOptions {
  status: ObservationStatus;
  content: string | unknown;
  source: ObservationSource;
  maxChars?: number;
  /** When truncated, attach a handle to the full payload (caller-managed). */
  handle?: ArtifactHandle;
  toolName?: string;
  observedAt?: string;
}

function stringifyContent(content: string | unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content ?? null, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * Bound an observation for working context.
 * Oversized bodies are truncated; callers should persist the original and
 * pass `handle` so the full payload remains recoverable.
 */
export function shapeObservation(
  options: ShapeObservationOptions,
): BoundedObservation {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const raw = stringifyContent(options.content);
  const truncated = raw.length > maxChars;
  const content = truncated
    ? raw.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) +
      TRUNCATION_MARKER
    : raw;

  return boundedObservationSchema.parse({
    status: options.status,
    content,
    source: options.source,
    truncated,
    ...(options.handle ? { handle: options.handle } : {}),
    ...(options.toolName ? { toolName: options.toolName } : {}),
    ...(options.observedAt
      ? { observedAt: options.observedAt }
      : { observedAt: new Date().toISOString() }),
  });
}

/** Format a bounded observation as a structured context block. */
export function formatObservationBlock(obs: BoundedObservation): string {
  const header = [
    `status=${obs.status}`,
    `source=${obs.source}`,
    obs.toolName ? `tool=${obs.toolName}` : undefined,
    obs.truncated ? 'truncated=true' : undefined,
    obs.handle ? `handle=${obs.handle.uri}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return `<observation ${header}>\n${obs.content}\n</observation>`;
}
