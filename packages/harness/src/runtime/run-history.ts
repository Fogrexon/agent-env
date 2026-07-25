/**
 * File-backed run history: progress JSONL, result, final text, and a
 * per-run workspace directory. Callers inject `baseDir` (packages never
 * read process.env or hardcode agent ids).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  AgentProgressEvent,
  AgentProgressSink,
  AgentRunResult,
  ModelRef,
  RunRecord,
} from '@agent-env/shared';
import { agentProgressEventSchema } from '@agent-env/shared';

export type RunHistoryStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunHistoryMode = 'agent' | 'runspec';

export interface RunHistoryMeta {
  runId: string;
  agentId: string;
  runMode: RunHistoryMode;
  status: RunHistoryStatus;
  message?: string;
  model?: ModelRef;
  startedAt: string;
  finishedAt?: string;
  dir: string;
  workspaceDir: string;
  error?: string;
}

export interface RunHistoryListItem {
  runId: string;
  agentId: string;
  runMode: RunHistoryMode;
  status: RunHistoryStatus;
  message?: string;
  startedAt: string;
  finishedAt?: string;
  dir: string;
  error?: string;
  finalTextPreview?: string;
}

export interface RunHistoryReadResult {
  meta: RunHistoryMeta;
  events: AgentProgressEvent[];
  result?: unknown;
  finalText?: string;
}

export interface OpenRunHistoryInput {
  runId: string;
  agentId: string;
  runMode: RunHistoryMode;
  message?: string;
  model?: ModelRef;
}

export interface CreateRunHistoryStoreOptions {
  /** Absolute directory that holds `<agentId>/<stamp>-<runId8>/` children. */
  baseDir: string;
}

const PREVIEW_MAX = 120;

function previewText(text: string, max = PREVIEW_MAX): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

/** Token-stream chunks — useful live, wasteful on disk (full text each tick). */
function isStreamingPartial(event: AgentProgressEvent): boolean {
  return event.kind === 'agent.event' && Boolean(event.agentEvent?.partial);
}

/**
 * Drop redundant `message` when it duplicates `agentEvent.text`.
 * Live sinks still receive the full event; only the JSONL line is compacted.
 */
function compactProgressForDisk(event: AgentProgressEvent): AgentProgressEvent {
  if (
    event.message !== undefined &&
    event.agentEvent?.text !== undefined &&
    event.message === event.agentEvent.text
  ) {
    const { message: _message, ...rest } = event;
    return rest;
  }
  return event;
}

function stampForDir(date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'run';
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRunHistoryMeta(value: unknown): value is RunHistoryMeta {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o['runId'] === 'string' &&
    typeof o['agentId'] === 'string' &&
    typeof o['runMode'] === 'string' &&
    typeof o['status'] === 'string' &&
    typeof o['startedAt'] === 'string' &&
    typeof o['dir'] === 'string' &&
    typeof o['workspaceDir'] === 'string'
  );
}

/** Combine multiple progress sinks into one (errors in one sink do not stop others). */
export function composeProgressSinks(
  ...sinks: Array<AgentProgressSink | undefined>
): AgentProgressSink {
  const active = sinks.filter((s): s is AgentProgressSink => Boolean(s));
  return (event) => {
    for (const sink of active) {
      try {
        sink(event);
      } catch {
        // isolate sink failures
      }
    }
  };
}

export interface RunHistoryWriter {
  readonly dir: string;
  readonly workspaceDir: string;
  readonly runId: string;
  readonly progressSink: AgentProgressSink;
  writeMeta(patch: Partial<RunHistoryMeta>): void;
  writeResult(result: AgentRunResult): void;
  writeRunRecord(
    record: RunRecord,
    events: readonly unknown[],
    finalText?: string,
  ): void;
}

export interface RunHistoryStore {
  readonly baseDir: string;
  open(input: OpenRunHistoryInput): RunHistoryWriter;
  listRuns(): RunHistoryListItem[];
  readRun(runId: string): RunHistoryReadResult | undefined;
  findRunDir(runId: string): string | undefined;
}

function createWriter(
  storeBaseDir: string,
  input: OpenRunHistoryInput,
): RunHistoryWriter {
  const startedAt = new Date().toISOString();
  const stamp = stampForDir();
  const shortId = safeSegment(input.runId.slice(0, 8));
  const agentSeg = safeSegment(input.agentId);
  const dir = resolve(storeBaseDir, agentSeg, `${stamp}-${shortId}`);
  const workspaceDir = join(dir, 'workspace');
  const metaPath = join(dir, 'run.json');
  const progressPath = join(dir, 'progress.jsonl');
  const resultPath = join(dir, 'result.json');
  const finalPath = join(dir, 'final.md');

  mkdirSync(workspaceDir, { recursive: true });

  let meta: RunHistoryMeta = {
    runId: input.runId,
    agentId: input.agentId,
    runMode: input.runMode,
    status: 'running',
    startedAt,
    dir,
    workspaceDir,
    ...(input.message ? { message: input.message } : {}),
    ...(input.model ? { model: input.model } : {}),
  };
  writeJson(metaPath, meta);
  // Touch empty progress file so readers know the run started.
  writeFileSync(progressPath, '', 'utf8');

  const persistMeta = (patch: Partial<RunHistoryMeta>): void => {
    meta = { ...meta, ...patch, dir, workspaceDir, runId: input.runId };
    writeJson(metaPath, meta);
  };

  const writeFinal = (text: string | undefined): void => {
    if (text === undefined) return;
    writeFileSync(finalPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  };

  const finishFromAgentResult = (result: AgentRunResult): void => {
    writeJson(resultPath, result);
    writeFinal(result.finalText);
    const status: RunHistoryStatus =
      result.status === 'finished' ? 'completed' : 'failed';
    persistMeta({
      status,
      finishedAt: result.finishedAt,
      ...(result.error ? { error: result.error } : {}),
    });
  };

  const finishFromRunRecord = (
    record: RunRecord,
    events: readonly unknown[],
    finalText?: string,
  ): void => {
    const text = finalText ?? record.finalText;
    writeJson(resultPath, { record, events, agentFinalText: text });
    writeFinal(text);
    const status: RunHistoryStatus =
      record.state === 'SUCCEEDED'
        ? 'completed'
        : record.state === 'CANCELLED'
          ? 'cancelled'
          : 'failed';
    persistMeta({
      status,
      finishedAt: record.finishedAt ?? new Date().toISOString(),
      ...(record.error ? { error: record.error } : {}),
    });
  };

  const progressSink: AgentProgressSink = (event) => {
    // Live SSE keeps every token chunk; disk only needs milestones.
    // Streaming partials rewrite the full cumulative text each time and
    // balloon progress.jsonl (hundreds of MB per long run).
    if (isStreamingPartial(event)) return;
    appendFileSync(
      progressPath,
      `${JSON.stringify(compactProgressForDisk(event))}\n`,
      'utf8',
    );
  };

  return {
    dir,
    workspaceDir,
    runId: input.runId,
    progressSink,
    writeMeta: persistMeta,
    writeResult: finishFromAgentResult,
    writeRunRecord: finishFromRunRecord,
  };
}

function loadProgressEvents(dir: string): AgentProgressEvent[] {
  const path = join(dir, 'progress.jsonl');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return [];
  const events: AgentProgressEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = agentProgressEventSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // skip corrupt lines
    }
  }
  return events;
}

/**
 * Create a file-backed run history store under `baseDir`.
 * Layout: `<baseDir>/<agentId>/<yyyymmdd-HHMMSS>-<runId8>/`
 */
export function createRunHistoryStore(
  options: CreateRunHistoryStoreOptions,
): RunHistoryStore {
  const baseDir = resolve(options.baseDir);
  mkdirSync(baseDir, { recursive: true });

  const findRunDir = (runId: string): string | undefined => {
    if (!existsSync(baseDir)) return undefined;
    for (const agentId of readdirSync(baseDir, { withFileTypes: true })) {
      if (!agentId.isDirectory()) continue;
      const agentDir = join(baseDir, agentId.name);
      for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(agentDir, entry.name);
        const meta = readJsonFile(join(dir, 'run.json'));
        if (isRunHistoryMeta(meta) && meta.runId === runId) {
          return dir;
        }
      }
    }
    return undefined;
  };

  return {
    baseDir,
    open: (input) => createWriter(baseDir, input),
    findRunDir,
    listRuns: () => {
      const items: RunHistoryListItem[] = [];
      if (!existsSync(baseDir)) return items;
      for (const agentId of readdirSync(baseDir, { withFileTypes: true })) {
        if (!agentId.isDirectory()) continue;
        const agentDir = join(baseDir, agentId.name);
        for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const dir = join(agentDir, entry.name);
          const metaRaw = readJsonFile(join(dir, 'run.json'));
          if (!isRunHistoryMeta(metaRaw)) continue;
          const finalRaw = existsSync(join(dir, 'final.md'))
            ? readFileSync(join(dir, 'final.md'), 'utf8')
            : undefined;
          items.push({
            runId: metaRaw.runId,
            agentId: metaRaw.agentId,
            runMode: metaRaw.runMode,
            status: metaRaw.status,
            startedAt: metaRaw.startedAt,
            dir,
            ...(metaRaw.message ? { message: metaRaw.message } : {}),
            ...(metaRaw.finishedAt ? { finishedAt: metaRaw.finishedAt } : {}),
            ...(metaRaw.error ? { error: metaRaw.error } : {}),
            ...(finalRaw
              ? { finalTextPreview: previewText(finalRaw) }
              : {}),
          });
        }
      }
      return items.sort(
        (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
      );
    },
    readRun: (runId) => {
      const dir = findRunDir(runId);
      if (!dir) return undefined;
      const metaRaw = readJsonFile(join(dir, 'run.json'));
      if (!isRunHistoryMeta(metaRaw)) return undefined;
      const finalRaw = existsSync(join(dir, 'final.md'))
        ? readFileSync(join(dir, 'final.md'), 'utf8')
        : undefined;
      return {
        meta: { ...metaRaw, dir, workspaceDir: join(dir, 'workspace') },
        events: loadProgressEvents(dir),
        result: readJsonFile(join(dir, 'result.json')),
        ...(finalRaw !== undefined ? { finalText: finalRaw } : {}),
      };
    },
  };
}

/** Well-known state key for the per-run workspace absolute path. */
export const RUN_WORKSPACE_STATE_KEY = 'runWorkspaceDir';
