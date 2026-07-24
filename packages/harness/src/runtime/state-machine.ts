import {
  isTerminalRunState,
  type RunPhase,
  type RunState,
} from '@agent-env/shared';

/** Legal transitions for the Phase A state machine (research §6.2 subset). */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  QUEUED: ['PROVISIONING', 'CANCELLED'],
  PROVISIONING: ['RUNNING', 'FAILED_INFRA', 'CANCELLED'],
  RUNNING: [
    'WAITING_TOOL',
    'WAITING_APPROVAL',
    'CHECKPOINTING',
    'VERIFYING',
    'BUDGET_EXHAUSTED',
    'POLICY_DENIED',
    'FAILED',
    'CANCELLED',
    'UNKNOWN_EXTERNAL_EFFECT',
  ],
  WAITING_TOOL: [
    'RUNNING',
    'FAILED',
    'UNKNOWN_EXTERNAL_EFFECT',
    'CANCELLED',
    'BUDGET_EXHAUSTED',
  ],
  WAITING_APPROVAL: ['RUNNING', 'APPROVAL_EXPIRED', 'CANCELLED', 'POLICY_DENIED'],
  CHECKPOINTING: ['RUNNING', 'FAILED_INFRA', 'CANCELLED'],
  VERIFYING: ['SUCCEEDED', 'REPAIRING', 'FAILED_INFRA', 'FAILED'],
  REPAIRING: ['RUNNING', 'BUDGET_EXHAUSTED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  FAILED_INFRA: [],
  BUDGET_EXHAUSTED: [],
  POLICY_DENIED: [],
  APPROVAL_EXPIRED: [],
  CANCELLED: [],
  UNKNOWN_EXTERNAL_EFFECT: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run state transition: ${from} → ${to}`);
  }
}

export function phaseForState(state: RunState): RunPhase {
  if (isTerminalRunState(state)) return 'terminated';
  switch (state) {
    case 'WAITING_TOOL':
    case 'WAITING_APPROVAL':
      return 'waiting';
    case 'VERIFYING':
      return 'verifying';
    case 'CHECKPOINTING':
    case 'REPAIRING':
    case 'PROVISIONING':
    case 'QUEUED':
      return 'acting';
    default:
      return 'reasoning';
  }
}

export class RunStateMachine {
  #state: RunState;

  constructor(initial: RunState = 'QUEUED') {
    this.#state = initial;
  }

  get state(): RunState {
    return this.#state;
  }

  get phase(): RunPhase {
    return phaseForState(this.#state);
  }

  get terminal(): boolean {
    return isTerminalRunState(this.#state);
  }

  transition(to: RunState): RunState {
    assertTransition(this.#state, to);
    this.#state = to;
    return this.#state;
  }
}
