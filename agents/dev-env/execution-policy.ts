import type { AgentExecutionLimits } from '@agent-env/shared';

/** Host-wide soft ceilings; agent `limits` take the min per field. */
export const DEFAULT_HOST_EXECUTION_LIMITS: AgentExecutionLimits = {
  maxSteps: 200,
  maxToolCalls: 200,
  maxWallSeconds: 1800,
  maxRepairs: 3,
  maxSubagentDepth: 3,
};
