import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ToolContract, ToolRiskClass } from '@agent-env/shared';
import { emitApprovalProgress } from './progress-context.js';

export type ToolApprovalMode = 'deny' | 'auto' | 'interactive';
export type ToolApprovalDecision = 'granted' | 'denied' | 'expired';

export interface ToolApprovalRequest {
  approvalId: string;
  contract: ToolContract;
  input: Record<string, unknown>;
}

/**
 * Per-run approval policy for T2/T3 tools.
 * Injected by CLI / admin via {@link runWithToolApproval}.
 */
export interface ToolApprovalPolicy {
  mode: ToolApprovalMode;
  /**
   * Risks auto-granted when `mode === 'auto'`.
   * Default: `['T2']` — T3 is never auto-approved unless listed explicitly.
   */
  autoRisks?: readonly ToolRiskClass[];
  /**
   * Interactive gate. Required when `mode === 'interactive'`.
   * Admin wires this to a pending Promise resolved by POST /approvals/:id.
   */
  requestApproval?: (
    request: ToolApprovalRequest,
  ) => Promise<'granted' | 'denied'>;
  /** Interactive wait timeout. Default 10 minutes. */
  timeoutMs?: number;
  /**
   * Optional hook when entering / leaving WAITING_APPROVAL.
   * Used by executeAgentRun to drive the run state machine.
   */
  onWaitingChange?: (waiting: boolean, request?: ToolApprovalRequest) => void;
}

const DEFAULT_AUTO_RISKS: readonly ToolRiskClass[] = ['T2'];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const approvalAls = new AsyncLocalStorage<ToolApprovalPolicy>();

/** Run `fn` under a per-run tool approval policy. */
export function runWithToolApproval<T>(
  policy: ToolApprovalPolicy,
  fn: () => Promise<T>,
): Promise<T> {
  return approvalAls.run(policy, fn);
}

/** Current run approval policy, if any. */
export function getToolApprovalPolicy(): ToolApprovalPolicy | undefined {
  return approvalAls.getStore();
}

function decisionGranted(
  decision: ToolApprovalDecision,
): decision is 'granted' {
  return decision === 'granted';
}

/**
 * Resolve whether a T2/T3 tool may execute under the active run policy.
 * No ALS context → deny (fail closed).
 */
export async function resolveToolApproval(args: {
  contract: ToolContract;
  input: Record<string, unknown>;
}): Promise<{
  granted: boolean;
  decision: ToolApprovalDecision;
  approvalId?: string;
  source: 'auto' | 'interactive' | 'deny' | 'none';
}> {
  const policy = approvalAls.getStore();
  if (!policy) {
    return { granted: false, decision: 'denied', source: 'none' };
  }

  const risk = args.contract.riskClass;
  if (policy.mode === 'auto') {
    const autoRisks = policy.autoRisks ?? DEFAULT_AUTO_RISKS;
    if (autoRisks.includes(risk)) {
      return { granted: true, decision: 'granted', source: 'auto' };
    }
    return { granted: false, decision: 'denied', source: 'auto' };
  }

  if (policy.mode === 'deny') {
    return { granted: false, decision: 'denied', source: 'deny' };
  }

  // interactive
  if (!policy.requestApproval) {
    return { granted: false, decision: 'denied', source: 'interactive' };
  }

  const approvalId = randomUUID();
  const request: ToolApprovalRequest = {
    approvalId,
    contract: args.contract,
    input: args.input,
  };

  emitApprovalProgress('approval.requested', {
    author: `tool:${args.contract.name}`,
    message: `Approval required for ${args.contract.name} (${risk})`,
    payload: {
      approvalId,
      tool: args.contract.name,
      riskClass: risk,
      sideEffect: args.contract.sideEffect,
      input: args.input,
    },
  });
  policy.onWaitingChange?.(true, request);

  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let decision: ToolApprovalDecision;
  try {
    decision = await Promise.race([
      policy.requestApproval(request),
      new Promise<ToolApprovalDecision>((resolve) => {
        timer = setTimeout(() => resolve('expired'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    policy.onWaitingChange?.(false, request);
  }

  if (decision !== 'granted' && decision !== 'denied') {
    decision = 'expired';
  }

  emitApprovalProgress('approval.resolved', {
    author: `tool:${args.contract.name}`,
    message: `Approval ${decision} for ${args.contract.name}`,
    payload: {
      approvalId,
      tool: args.contract.name,
      riskClass: risk,
      decision,
    },
  });

  return {
    granted: decisionGranted(decision),
    decision,
    approvalId,
    source: 'interactive',
  };
}
