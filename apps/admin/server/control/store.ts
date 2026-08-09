/**
 * Durable control-plane store (queue / schedules / webhooks / audit).
 * Uses node:sqlite — same approach as harness KnowledgeStore.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

type DatabaseSync = import('node:sqlite').DatabaseSync;

const requireSqlite = createRequire(import.meta.url);

export type JobTrigger = 'manual' | 'schedule' | 'webhook';

export type JobStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ControlJob {
  jobId: string;
  runId: string;
  agentId: string;
  status: JobStatus;
  trigger: JobTrigger;
  priority: number;
  valuesJson: string;
  modelJson: string | null;
  messagePreview: string | null;
  scheduleId: string | null;
  webhookTokenId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ControlSchedule {
  id: string;
  agentId: string;
  cron: string;
  valuesJson: string;
  modelJson: string | null;
  enabled: number;
  nextRunAt: string | null;
  lastJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ControlWebhookToken {
  id: string;
  name: string;
  agentId: string;
  valuesJson: string;
  modelJson: string | null;
  tokenHash: string;
  tokenPrefix: string;
  enabled: number;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  detailJson: string;
  createdAt: string;
}

/** Lean turn stored in control DB for chat resume. */
export interface ChatSessionTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  runId?: string;
  error?: string;
}

export interface ChatSession {
  id: string;
  agentId: string;
  title: string;
  turns: ChatSessionTurn[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionSummary {
  id: string;
  agentId: string;
  title: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ControlStore {
  dbPath: string;
  enqueue(input: {
    agentId: string;
    values: Record<string, unknown>;
    /** Legacy column; new rows should pass null. */
    model?: unknown | null;
    trigger: JobTrigger;
    priority?: number;
    messagePreview?: string;
    scheduleId?: string;
    webhookTokenId?: string;
    runId?: string;
  }): ControlJob;
  getJob(jobId: string): ControlJob | undefined;
  getJobByRunId(runId: string): ControlJob | undefined;
  listJobs(opts?: {
    status?: JobStatus | JobStatus[];
    agentId?: string;
    limit?: number;
  }): ControlJob[];
  claimNext(limit: number): ControlJob[];
  markRunning(jobId: string): void;
  markTerminal(
    jobId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error?: string,
  ): void;
  cancelJob(jobId: string): ControlJob | undefined;
  reconcileOrphans(): number;
  queueDepth(): number;
  countByStatus(status: JobStatus): number;
  countByTrigger(sinceIso?: string): Record<JobTrigger, number>;
  recentFailureRate(limit?: number): { total: number; failed: number; rate: number };

  listSchedules(): ControlSchedule[];
  getSchedule(id: string): ControlSchedule | undefined;
  createSchedule(input: {
    agentId: string;
    cron: string;
    values: Record<string, unknown>;
    /** Legacy column; new rows should omit / pass null. */
    model?: unknown | null;
    enabled?: boolean;
    nextRunAt?: string | null;
  }): ControlSchedule;
  updateSchedule(
    id: string,
    patch: Partial<{
      cron: string;
      values: Record<string, unknown>;
      model: unknown | null;
      enabled: boolean;
      nextRunAt: string | null;
      lastJobId: string | null;
    }>,
  ): ControlSchedule | undefined;
  deleteSchedule(id: string): boolean;
  dueSchedules(nowIso: string): ControlSchedule[];

  listWebhookTokens(): Omit<ControlWebhookToken, 'tokenHash'>[];
  createWebhookToken(input: {
    name: string;
    agentId: string;
    values: Record<string, unknown>;
    /** Legacy column; new rows should omit / pass null. */
    model?: unknown | null;
    rawToken?: string;
  }): { token: ControlWebhookToken; rawToken: string };
  findWebhookByRawToken(rawToken: string): ControlWebhookToken | undefined;
  touchWebhook(id: string): void;
  setWebhookEnabled(id: string, enabled: boolean): boolean;
  deleteWebhookToken(id: string): boolean;

  listChatSessions(opts: {
    agentId: string;
    limit?: number;
  }): ChatSessionSummary[];
  getChatSession(id: string): ChatSession | undefined;
  upsertChatSession(input: {
    id?: string;
    agentId: string;
    title: string;
    turns: ChatSessionTurn[];
  }): ChatSession;
  deleteChatSession(id: string): boolean;

  audit(action: string, detail?: Record<string, unknown>): void;
  listAudit(limit?: number): AuditEntry[];

  close(): void;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToJob(row: Record<string, unknown>): ControlJob {
  return {
    jobId: String(row['job_id']),
    runId: String(row['run_id']),
    agentId: String(row['agent_id']),
    status: row['status'] as JobStatus,
    trigger: row['trigger'] as JobTrigger,
    priority: Number(row['priority'] ?? 0),
    valuesJson: String(row['values_json'] ?? '{}'),
    modelJson: (row['model_json'] as string | null) ?? null,
    messagePreview: (row['message_preview'] as string | null) ?? null,
    scheduleId: (row['schedule_id'] as string | null) ?? null,
    webhookTokenId: (row['webhook_token_id'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    claimedAt: (row['claimed_at'] as string | null) ?? null,
    startedAt: (row['started_at'] as string | null) ?? null,
    finishedAt: (row['finished_at'] as string | null) ?? null,
  };
}

function rowToSchedule(row: Record<string, unknown>): ControlSchedule {
  return {
    id: String(row['id']),
    agentId: String(row['agent_id']),
    cron: String(row['cron']),
    valuesJson: String(row['values_json'] ?? '{}'),
    modelJson: (row['model_json'] as string | null) ?? null,
    enabled: Number(row['enabled'] ?? 1),
    nextRunAt: (row['next_run_at'] as string | null) ?? null,
    lastJobId: (row['last_job_id'] as string | null) ?? null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function rowToWebhook(row: Record<string, unknown>): ControlWebhookToken {
  return {
    id: String(row['id']),
    name: String(row['name']),
    agentId: String(row['agent_id']),
    valuesJson: String(row['values_json'] ?? '{}'),
    modelJson: (row['model_json'] as string | null) ?? null,
    tokenHash: String(row['token_hash']),
    tokenPrefix: String(row['token_prefix']),
    enabled: Number(row['enabled'] ?? 1),
    createdAt: String(row['created_at']),
    lastUsedAt: (row['last_used_at'] as string | null) ?? null,
  };
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      values_json TEXT NOT NULL,
      model_json TEXT,
      message_preview TEXT,
      schedule_id TEXT,
      webhook_token_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_priority
      ON jobs(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      cron TEXT NOT NULL,
      values_json TEXT NOT NULL,
      model_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_job_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      values_json TEXT NOT NULL,
      model_json TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      turns_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent
      ON chat_sessions(agent_id, updated_at DESC);
  `);
}

export function createControlStore(repoRoot: string): ControlStore {
  const { DatabaseSync } = requireSqlite(
    'node:sqlite',
  ) as typeof import('node:sqlite');
  const dbPath = resolve(repoRoot, '.runs/control/control.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);

  const store: ControlStore = {
    dbPath,

    enqueue(input) {
      const ts = nowIso();
      const jobId = randomUUID();
      const runId = input.runId ?? randomUUID();
      db.prepare(
        `INSERT INTO jobs (
          job_id, run_id, agent_id, status, trigger, priority,
          values_json, model_json, message_preview,
          schedule_id, webhook_token_id, error,
          created_at, updated_at, claimed_at, started_at, finished_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`,
      ).run(
        jobId,
        runId,
        input.agentId,
        input.trigger,
        input.priority ?? 0,
        JSON.stringify(input.values ?? {}),
        input.model != null ? JSON.stringify(input.model) : null,
        input.messagePreview ?? null,
        input.scheduleId ?? null,
        input.webhookTokenId ?? null,
        ts,
        ts,
      );
      store.audit('job.enqueued', {
        jobId,
        runId,
        agentId: input.agentId,
        trigger: input.trigger,
      });
      return store.getJob(jobId)!;
    },

    getJob(jobId) {
      const row = db
        .prepare('SELECT * FROM jobs WHERE job_id = ?')
        .get(jobId) as Record<string, unknown> | undefined;
      return row ? rowToJob(row) : undefined;
    },

    getJobByRunId(runId) {
      const row = db
        .prepare('SELECT * FROM jobs WHERE run_id = ?')
        .get(runId) as Record<string, unknown> | undefined;
      return row ? rowToJob(row) : undefined;
    },

    listJobs(opts) {
      const limit = opts?.limit ?? 200;
      const agentId = opts?.agentId;
      const statuses = opts?.status
        ? Array.isArray(opts.status)
          ? opts.status
          : [opts.status]
        : undefined;
      if (statuses?.length && agentId) {
        const placeholders = statuses.map(() => '?').join(',');
        const rows = db
          .prepare(
            `SELECT * FROM jobs
             WHERE agent_id = ? AND status IN (${placeholders})
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(agentId, ...statuses, limit) as Array<Record<string, unknown>>;
        return rows.map(rowToJob);
      }
      if (statuses?.length) {
        const placeholders = statuses.map(() => '?').join(',');
        const rows = db
          .prepare(
            `SELECT * FROM jobs WHERE status IN (${placeholders})
             ORDER BY priority DESC, created_at ASC LIMIT ?`,
          )
          .all(...statuses, limit) as Array<Record<string, unknown>>;
        return rows.map(rowToJob);
      }
      if (agentId) {
        const rows = db
          .prepare(
            `SELECT * FROM jobs WHERE agent_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(agentId, limit) as Array<Record<string, unknown>>;
        return rows.map(rowToJob);
      }
      const rows = db
        .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as Array<Record<string, unknown>>;
      return rows.map(rowToJob);
    },

    claimNext(limit) {
      const ts = nowIso();
      const pending = db
        .prepare(
          `SELECT job_id FROM jobs
           WHERE status = 'pending'
           ORDER BY priority DESC, created_at ASC
           LIMIT ?`,
        )
        .all(limit) as Array<{ job_id: string }>;
      const claimed: ControlJob[] = [];
      for (const row of pending) {
        const result = db
          .prepare(
            `UPDATE jobs SET status = 'claimed', claimed_at = ?, updated_at = ?
             WHERE job_id = ? AND status = 'pending'`,
          )
          .run(ts, ts, row.job_id);
        if (Number(result.changes) > 0) {
          const job = store.getJob(row.job_id);
          if (job) claimed.push(job);
        }
      }
      return claimed;
    },

    markRunning(jobId) {
      const ts = nowIso();
      db.prepare(
        `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?),
         updated_at = ? WHERE job_id = ?`,
      ).run(ts, ts, jobId);
    },

    markTerminal(jobId, status, error) {
      const ts = nowIso();
      db.prepare(
        `UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = ?
         WHERE job_id = ?`,
      ).run(status, error ?? null, ts, ts, jobId);
      store.audit('job.terminal', { jobId, status, error });
    },

    cancelJob(jobId) {
      const job = store.getJob(jobId);
      if (!job) return undefined;
      if (job.status === 'pending' || job.status === 'claimed') {
        store.markTerminal(jobId, 'cancelled');
        store.audit('job.cancelled', { jobId, phase: job.status });
        return store.getJob(jobId);
      }
      if (job.status === 'running') {
        // Caller must abort the live run; we only mark intent here if needed.
        return job;
      }
      return undefined;
    },

    reconcileOrphans() {
      const ts = nowIso();
      const result = db
        .prepare(
          `UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
           WHERE status IN ('claimed', 'running')`,
        )
        .run('Process restart: orphaned in-flight job', ts, ts);
      const n = Number(result.changes ?? 0);
      if (n > 0) {
        store.audit('jobs.reconcile_orphans', { count: n });
      }
      return n;
    },

    queueDepth() {
      return store.countByStatus('pending');
    },

    countByStatus(status) {
      const row = db
        .prepare('SELECT COUNT(*) AS c FROM jobs WHERE status = ?')
        .get(status) as { c: number };
      return Number(row.c);
    },

    countByTrigger(sinceIso) {
      const triggers: JobTrigger[] = ['manual', 'schedule', 'webhook'];
      const out = { manual: 0, schedule: 0, webhook: 0 } as Record<
        JobTrigger,
        number
      >;
      for (const t of triggers) {
        const row = sinceIso
          ? (db
              .prepare(
                `SELECT COUNT(*) AS c FROM jobs WHERE trigger = ? AND created_at >= ?`,
              )
              .get(t, sinceIso) as { c: number })
          : (db
              .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE trigger = ?`)
              .get(t) as { c: number });
        out[t] = Number(row.c);
      }
      return out;
    },

    recentFailureRate(limit = 50) {
      const rows = db
        .prepare(
          `SELECT status FROM jobs
           WHERE status IN ('completed', 'failed', 'cancelled')
           ORDER BY finished_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{ status: string }>;
      const total = rows.length;
      const failed = rows.filter((r) => r.status === 'failed').length;
      return {
        total,
        failed,
        rate: total === 0 ? 0 : failed / total,
      };
    },

    listSchedules() {
      const rows = db
        .prepare('SELECT * FROM schedules ORDER BY created_at DESC')
        .all() as Array<Record<string, unknown>>;
      return rows.map(rowToSchedule);
    },

    getSchedule(id) {
      const row = db
        .prepare('SELECT * FROM schedules WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      return row ? rowToSchedule(row) : undefined;
    },

    createSchedule(input) {
      const ts = nowIso();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO schedules (
          id, agent_id, cron, values_json, model_json,
          enabled, next_run_at, last_job_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        input.agentId,
        input.cron,
        JSON.stringify(input.values ?? {}),
        input.model != null ? JSON.stringify(input.model) : null,
        input.enabled === false ? 0 : 1,
        input.nextRunAt ?? null,
        ts,
        ts,
      );
      store.audit('schedule.created', { id, agentId: input.agentId });
      return store.getSchedule(id)!;
    },

    updateSchedule(id, patch) {
      const cur = store.getSchedule(id);
      if (!cur) return undefined;
      const ts = nowIso();
      const cron = patch.cron ?? cur.cron;
      const valuesJson =
        patch.values !== undefined
          ? JSON.stringify(patch.values)
          : cur.valuesJson;
      const modelJson =
        patch.model === null
          ? null
          : patch.model !== undefined
            ? JSON.stringify(patch.model)
            : cur.modelJson;
      const enabled =
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled;
      const nextRunAt =
        patch.nextRunAt !== undefined ? patch.nextRunAt : cur.nextRunAt;
      const lastJobId =
        patch.lastJobId !== undefined ? patch.lastJobId : cur.lastJobId;
      db.prepare(
        `UPDATE schedules SET cron = ?, values_json = ?, model_json = ?,
         enabled = ?, next_run_at = ?, last_job_id = ?,
         updated_at = ? WHERE id = ?`,
      ).run(
        cron,
        valuesJson,
        modelJson,
        enabled,
        nextRunAt,
        lastJobId,
        ts,
        id,
      );
      return store.getSchedule(id);
    },

    deleteSchedule(id) {
      const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
      const ok = Number(result.changes) > 0;
      if (ok) store.audit('schedule.deleted', { id });
      return ok;
    },

    dueSchedules(now) {
      const rows = db
        .prepare(
          `SELECT * FROM schedules
           WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           ORDER BY next_run_at ASC`,
        )
        .all(now) as Array<Record<string, unknown>>;
      return rows.map(rowToSchedule);
    },

    listWebhookTokens() {
      return (
        db
          .prepare('SELECT * FROM webhook_tokens ORDER BY created_at DESC')
          .all() as Array<Record<string, unknown>>
      ).map((row) => {
        const full = rowToWebhook(row);
        const { tokenHash: _h, ...rest } = full;
        return rest;
      });
    },

    createWebhookToken(input) {
      const ts = nowIso();
      const id = randomUUID();
      const rawToken = input.rawToken ?? randomBytes(24).toString('base64url');
      const tokenHash = hashToken(rawToken);
      const tokenPrefix = rawToken.slice(0, 8);
      db.prepare(
        `INSERT INTO webhook_tokens (
          id, name, agent_id, values_json, model_json,
          token_hash, token_prefix, enabled, created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
      ).run(
        id,
        input.name,
        input.agentId,
        JSON.stringify(input.values ?? {}),
        input.model != null ? JSON.stringify(input.model) : null,
        tokenHash,
        tokenPrefix,
        ts,
      );
      store.audit('webhook.created', { id, agentId: input.agentId });
      return { token: store.findWebhookByRawToken(rawToken)!, rawToken };
    },

    findWebhookByRawToken(rawToken) {
      const row = db
        .prepare('SELECT * FROM webhook_tokens WHERE token_hash = ?')
        .get(hashToken(rawToken)) as Record<string, unknown> | undefined;
      return row ? rowToWebhook(row) : undefined;
    },

    touchWebhook(id) {
      db.prepare(
        `UPDATE webhook_tokens SET last_used_at = ? WHERE id = ?`,
      ).run(nowIso(), id);
    },

    setWebhookEnabled(id, enabled) {
      const result = db
        .prepare(
          `UPDATE webhook_tokens SET enabled = ? WHERE id = ?`,
        )
        .run(enabled ? 1 : 0, id);
      return Number(result.changes) > 0;
    },

    deleteWebhookToken(id) {
      const result = db
        .prepare('DELETE FROM webhook_tokens WHERE id = ?')
        .run(id);
      const ok = Number(result.changes) > 0;
      if (ok) store.audit('webhook.deleted', { id });
      return ok;
    },

    listChatSessions(opts) {
      const limit = opts.limit ?? 40;
      const rows = db
        .prepare(
          `SELECT id, agent_id, title, turns_json, created_at, updated_at
           FROM chat_sessions
           WHERE agent_id = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(opts.agentId, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => {
        let turnCount = 0;
        try {
          const turns = JSON.parse(String(row['turns_json'] ?? '[]')) as unknown;
          turnCount = Array.isArray(turns) ? turns.length : 0;
        } catch {
          turnCount = 0;
        }
        return {
          id: String(row['id']),
          agentId: String(row['agent_id']),
          title: String(row['title'] ?? 'Chat'),
          turnCount,
          createdAt: String(row['created_at']),
          updatedAt: String(row['updated_at']),
        };
      });
    },

    getChatSession(id) {
      const row = db
        .prepare(`SELECT * FROM chat_sessions WHERE id = ?`)
        .get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      let turns: ChatSessionTurn[] = [];
      try {
        const parsed = JSON.parse(String(row['turns_json'] ?? '[]')) as unknown;
        if (Array.isArray(parsed)) {
          turns = parsed.filter(
            (t): t is ChatSessionTurn =>
              Boolean(t) &&
              typeof t === 'object' &&
              typeof (t as ChatSessionTurn).id === 'string' &&
              ((t as ChatSessionTurn).role === 'user' ||
                (t as ChatSessionTurn).role === 'assistant') &&
              typeof (t as ChatSessionTurn).text === 'string',
          );
        }
      } catch {
        turns = [];
      }
      return {
        id: String(row['id']),
        agentId: String(row['agent_id']),
        title: String(row['title'] ?? 'Chat'),
        turns,
        createdAt: String(row['created_at']),
        updatedAt: String(row['updated_at']),
      };
    },

    upsertChatSession(input) {
      const ts = nowIso();
      const id = input.id?.trim() || randomUUID();
      const existing = store.getChatSession(id);
      const title = input.title.trim() || existing?.title || 'Chat';
      const turnsJson = JSON.stringify(input.turns);
      if (existing) {
        db.prepare(
          `UPDATE chat_sessions
           SET title = ?, turns_json = ?, updated_at = ?
           WHERE id = ?`,
        ).run(title, turnsJson, ts, id);
      } else {
        db.prepare(
          `INSERT INTO chat_sessions
           (id, agent_id, title, turns_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, input.agentId, title, turnsJson, ts, ts);
      }
      store.audit('chat_session.upsert', {
        id,
        agentId: input.agentId,
        turns: input.turns.length,
      });
      return store.getChatSession(id)!;
    },

    deleteChatSession(id) {
      const result = db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id);
      const ok = Number(result.changes) > 0;
      if (ok) store.audit('chat_session.delete', { id });
      return ok;
    },

    audit(action, detail = {}) {
      db.prepare(
        `INSERT INTO audit_log (id, action, detail_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), action, JSON.stringify(detail), nowIso());
    },

    listAudit(limit = 100) {
      const rows = db
        .prepare(
          `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r['id']),
        action: String(r['action']),
        detailJson: String(r['detail_json']),
        createdAt: String(r['created_at']),
      }));
    },

    close() {
      db.close();
    },
  };

  return store;
}

export function jobPublic(job: ControlJob) {
  return {
    jobId: job.jobId,
    runId: job.runId,
    agentId: job.agentId,
    status: job.status,
    trigger: job.trigger,
    priority: job.priority,
    messagePreview: job.messagePreview,
    scheduleId: job.scheduleId,
    webhookTokenId: job.webhookTokenId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    claimedAt: job.claimedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function parseJobValues(job: ControlJob): Record<string, unknown> {
  try {
    const parsed = JSON.parse(job.valuesJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function jobPublicWithValues(job: ControlJob) {
  return {
    ...jobPublic(job),
    values: parseJobValues(job),
  };
}
