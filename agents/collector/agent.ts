import { LlmAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import {
  bootstrapProvidersFromEnv,
  defaultGeminiModelRef,
  loadDotEnv,
  registerDemoConnectors,
  resolveModel,
  getConnector,
} from '@agent-env/harness';

loadDotEnv();
bootstrapProvidersFromEnv();
registerDemoConnectors();

const model = resolveModel(defaultGeminiModelRef());

const kb = getConnector('kb');
const crm = getConnector('crm');
const status = getConnector('status');

/**
 * Fan-out collectors: each specialist only sees its own data-source tool.
 * Results land in distinct outputKeys for the synthesizer.
 */
const kbAgent = new LlmAgent({
  name: 'kb_collector',
  model,
  description: 'Searches the product knowledge base.',
  instruction: `You gather evidence from the knowledge base only.
Call ${kb.meta.contract.name} with a focused query derived from the user topic.
Then output 3 bullet findings grounded ONLY in the tool result. No preamble.`,
  tools: [kb.createTool()],
  outputKey: 'kb_findings',
});

const crmAgent = new LlmAgent({
  name: 'crm_collector',
  model,
  description: 'Searches CRM account snippets.',
  instruction: `You gather commercial context from CRM only.
Call ${crm.meta.contract.name} with a focused query derived from the user topic.
Then output 3 bullet findings grounded ONLY in the tool result. No preamble.`,
  tools: [crm.createTool()],
  outputKey: 'crm_findings',
});

const statusAgent = new LlmAgent({
  name: 'status_collector',
  model,
  description: 'Reads the ops status board.',
  instruction: `You gather operational status only.
Call ${status.meta.contract.name} with a focused query derived from the user topic.
Then output 3 bullet findings grounded ONLY in the tool result. No preamble.`,
  tools: [status.createTool()],
  outputKey: 'status_findings',
});

const fanOut = new ParallelAgent({
  name: 'collect_fan_out',
  description: 'Collect evidence from KB, CRM, and status in parallel.',
  subAgents: [kbAgent, crmAgent, statusAgent],
});

const synthesizer = new LlmAgent({
  name: 'brief_synthesizer',
  model,
  description: 'Merges multi-source evidence into one ops/account brief.',
  instruction: `Synthesize a short multi-source briefing.

Knowledge base findings:
{kb_findings}

CRM findings:
{crm_findings}

Status board findings:
{status_findings}

Rules:
- Ground every claim in the findings above (do not invent sources).
- Structure exactly:
  Overview
  Sources
  Risks
  Recommendation
- Under Sources, name which buckets contributed (KB / CRM / Status).
- Keep the whole response under 220 words.
- Include the word "verified" once near the end if evidence was present.`,
});

/**
 * Data-source collector orchestration sample.
 * Parallel read connectors → single synthesizer (no scheduler required).
 */
export const rootAgent = new SequentialAgent({
  name: 'collector',
  description:
    'Gather from multiple data sources in parallel, then synthesize one brief.',
  subAgents: [fanOut, synthesizer],
});
