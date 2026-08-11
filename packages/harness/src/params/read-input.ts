/**
 * Helpers for reading AgentBuildContext.inputs / form values in createAgent.
 */

export function readBoolInput(
  inputs: Readonly<Record<string, unknown>> | undefined,
  key: string,
  defaultValue: boolean,
): boolean {
  const value = inputs?.[key];
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
  }
  return defaultValue;
}

export function readStringInput(
  inputs: Readonly<Record<string, unknown>> | undefined,
  key: string,
  defaultValue = '',
): string {
  const value = inputs?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return defaultValue;
}

export function readNumberInput(
  inputs: Readonly<Record<string, unknown>> | undefined,
  key: string,
  defaultValue: number,
  opts?: { min?: number; max?: number },
): number {
  const value = inputs?.[key];
  let n = defaultValue;
  if (typeof value === 'number' && Number.isFinite(value)) n = value;
  else if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (opts?.min !== undefined) n = Math.max(opts.min, n);
  if (opts?.max !== undefined) n = Math.min(opts.max, n);
  return n;
}
