import { isLlmAgent, type BaseAgent, type LlmAgent } from '@google/adk';

/**
 * Depth-first collection of every LlmAgent in an ADK agent tree
 * (Sequential / Parallel / Loop roots included).
 */
export function collectLlmAgents(
  root: BaseAgent,
  out: LlmAgent[] = [],
): LlmAgent[] {
  if (isLlmAgent(root)) out.push(root);
  for (const sub of root.subAgents) collectLlmAgents(sub, out);
  return out;
}
