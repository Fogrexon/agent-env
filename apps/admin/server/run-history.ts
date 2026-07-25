/**
 * Shared file-backed run history for the admin API (same layout as CLI).
 */
import { resolve } from 'node:path';
import { createRunHistoryStore } from '@agent-env/harness';

let store: ReturnType<typeof createRunHistoryStore> | undefined;
let storeRoot: string | undefined;

export function getAdminRunHistory(repoRoot: string) {
  const baseDir = resolve(repoRoot, '.runs', 'runs');
  if (!store || storeRoot !== baseDir) {
    store = createRunHistoryStore({ baseDir });
    storeRoot = baseDir;
  }
  return store;
}
