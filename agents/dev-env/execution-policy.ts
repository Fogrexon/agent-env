import type { AgentExecutionLimits } from '@agent-env/shared';

/** Host-wide soft ceilings; agent `limits` take the min per field. */
export const DEFAULT_HOST_EXECUTION_LIMITS: AgentExecutionLimits = {
  maxSteps: 2000,
  maxToolCalls: 2000,
  maxWallSeconds: 7200,
  maxRepairs: 3,
  maxSubagentDepth: 3,
};
