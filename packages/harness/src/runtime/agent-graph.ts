import {
  isAgentTool,
  isBaseTool,
  isLlmAgent,
  isLoopAgent,
  isParallelAgent,
  isRoutedAgent,
  isSequentialAgent,
  type BaseAgent,
  type BaseTool,
  type LlmAgent,
} from '@google/adk';
import {
  formatModelRef,
  type AgentGraph,
  type AgentGraphEdge,
  type AgentGraphNode,
  type AgentGraphToolRef,
  type AgentProgressEvent,
  type ObservedAgentGraph,
  type ProviderModelId,
} from '@agent-env/shared';
import { getEmitHandoffToolMeta } from '../handoff/index.js';
import {
  datasourceNodeId,
  getConnectorToolMeta,
} from '../connectors/tool-meta.js';
import { getTrackedAgentToolMeta } from '../tools/tracked-agent-tool.js';
import { getReviewLoopMeta } from '../agents/review-loop-agent.js';

function modelStringOf(llm: LlmAgent): string | undefined {
  const model = llm.model;
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') {
    const withRef = model as {
      modelRef?: { provider: string; model: string };
      providerId?: string;
      model?: string;
    };
    if (withRef.modelRef) return formatModelRef(withRef.modelRef);
    if (typeof withRef.providerId === 'string' && typeof withRef.model === 'string') {
      return `${withRef.providerId}:${withRef.model}`;
    }
    if (typeof withRef.model === 'string') return withRef.model;
  }
  return undefined;
}

function toolRefs(tools: readonly unknown[]): AgentGraphToolRef[] {
  const out: AgentGraphToolRef[] = [];
  for (const tool of tools) {
    if (!isBaseTool(tool as BaseTool) && typeof (tool as BaseTool)?.name !== 'string') {
      continue;
    }
    const base = tool as BaseTool;
    const tracked = getTrackedAgentToolMeta(base);
    if (tracked || isAgentTool(base)) {
      out.push({
        name: base.name,
        kind: 'agent_tool',
        ...(tracked?.agentName ? { agentName: tracked.agentName } : {}),
        ...(tracked?.definitionId ? { definitionId: tracked.definitionId } : {}),
      });
      continue;
    }
    const connector = getConnectorToolMeta(base as object);
    if (connector) {
      out.push({
        name: base.name,
        kind: 'connector',
        connectorId: connector.connectorId,
      });
      continue;
    }
    out.push({ name: base.name, kind: 'function' });
  }
  return out;
}

function kindOf(agent: BaseAgent): AgentGraphNode['kind'] {
  if (getReviewLoopMeta(agent)) return 'review_loop';
  if (isLlmAgent(agent)) return 'llm';
  if (isSequentialAgent(agent)) return 'sequential';
  if (isParallelAgent(agent)) return 'parallel';
  if (isLoopAgent(agent)) return 'loop';
  if (isRoutedAgent(agent)) return 'routed';
  return 'custom';
}

/**
 * Build an effective agent graph from an ADK agent tree.
 * Does not guess opaque custom BaseAgent internals.
 */
export function describeAgentGraph(
  root: BaseAgent,
  options: { agentId?: string } = {},
): AgentGraph {
  const nodes: AgentGraphNode[] = [];
  const edges: AgentGraphEdge[] = [];
  const seen = new Set<string>();
  const datasourceSeen = new Set<string>();

  const ensureDatasource = (
    meta: NonNullable<ReturnType<typeof getConnectorToolMeta>>,
  ): string => {
    const id = datasourceNodeId(meta.connectorId);
    if (!datasourceSeen.has(id)) {
      datasourceSeen.add(id);
      nodes.push({
        id,
        kind: 'datasource',
        label: meta.title,
        description: meta.description,
        tools: [],
        meta: {
          connectorId: meta.connectorId,
          sourceKind: meta.kind,
          ...(meta.tags?.length ? { tags: meta.tags } : {}),
        },
      });
    }
    return id;
  };

  const walk = (agent: BaseAgent): void => {
    if (seen.has(agent.name)) return;
    seen.add(agent.name);

    const kind = kindOf(agent);
    const review = getReviewLoopMeta(agent);
    const node: AgentGraphNode = {
      id: agent.name,
      kind,
      label: agent.name,
      description: agent.description,
      tools: [],
      meta: {},
    };

    if (isLlmAgent(agent)) {
      const model = modelStringOf(agent);
      if (model) node.model = model;
      if (agent.outputKey) node.outputKey = agent.outputKey;
      node.tools = toolRefs(agent.tools ?? []);
      for (const tool of node.tools) {
        if (tool.kind === 'agent_tool' && tool.agentName) {
          edges.push({
            from: agent.name,
            to: tool.agentName,
            kind: 'delegate',
            label: tool.name,
          });
        }
      }
      // Walk tracked AgentTool children for nested graphs.
      for (const t of agent.tools ?? []) {
        const meta = getTrackedAgentToolMeta(t as BaseTool);
        if (meta?.agent) walk(meta.agent);
        const handoff = getEmitHandoffToolMeta(t as object);
        if (handoff) {
          edges.push({
            from: handoff.fromAgent || agent.name,
            to: handoff.toAgent,
            kind: 'handoff',
            label: handoff.toolName,
          });
        }
        const connector = getConnectorToolMeta(t as object);
        if (connector) {
          const dsId = ensureDatasource(connector);
          edges.push({
            from: agent.name,
            to: dsId,
            kind: 'reads',
            label: (t as BaseTool).name,
          });
        }
      }
    }

    if (isLoopAgent(agent)) {
      node.maxIterations = agent.maxIterations;
    }

    if (review) {
      node.meta = {
        reviewKey: review.reviewKey,
        maxIterations: review.maxIterations,
      };
      node.maxIterations = review.maxIterations;
    }

    nodes.push(node);

    const children = agent.subAgents ?? [];
    for (const child of children) {
      edges.push({ from: agent.name, to: child.name, kind: 'contains' });
      walk(child);
    }

    if (isSequentialAgent(agent) || kind === 'review_loop') {
      for (let i = 0; i < children.length - 1; i += 1) {
        const from = children[i]!;
        const to = children[i + 1]!;
        const isReviewTail =
          kind === 'review_loop' && i === children.length - 2;

        if (isParallelAgent(from) && !isReviewTail) {
          // Control join: wait for all branches, then continue.
          edges.push({
            from: from.name,
            to: to.name,
            kind: 'join',
            label: 'after parallel',
          });
          // Data fan-in: session merge unless a typed handoff already exists.
          for (const branch of from.subAgents ?? []) {
            const hasHandoff = edges.some(
              (e) =>
                e.kind === 'handoff' &&
                e.from === branch.name &&
                e.to === to.name,
            );
            if (!hasHandoff) {
              edges.push({
                from: branch.name,
                to: to.name,
                kind: 'join',
                label: 'merge (session)',
              });
            } else {
              // Ensure handoff label is readable on the graph.
              for (const e of edges) {
                if (
                  e.kind === 'handoff' &&
                  e.from === branch.name &&
                  e.to === to.name &&
                  !e.label
                ) {
                  e.label = 'handoff';
                }
              }
            }
          }
        } else {
          edges.push({
            from: from.name,
            to: to.name,
            kind: isReviewTail ? 'review' : 'next',
          });
        }
      }
      if (kind === 'review_loop' && children.length >= 2) {
        edges.push({
          from: children[children.length - 1]!.name,
          to: children[0]!.name,
          kind: 'feedback',
        });
      }
    }

    if (isParallelAgent(agent)) {
      for (const child of children) {
        edges.push({ from: agent.name, to: child.name, kind: 'parallel' });
      }
    }

    if (isLoopAgent(agent) && children.length > 0) {
      edges.push({
        from: children[children.length - 1]!.name,
        to: children[0]!.name,
        kind: 'feedback',
      });
    }

    if (isRoutedAgent(agent)) {
      for (const child of children) {
        edges.push({ from: agent.name, to: child.name, kind: 'route' });
      }
    }
  };

  walk(root);
  return {
    root: root.name,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    nodes,
    edges,
  };
}

/**
 * Fail-fast validation: every LLM node must use a provider-qualified model
 * string or a BaseLlm with resolvable provider metadata.
 */
export function assertGraphModelsResolvable(graph: AgentGraph): void {
  for (const node of graph.nodes) {
    if (node.kind !== 'llm') continue;
    const model = node.model;
    if (!model) {
      throw new Error(
        `LLM agent "${node.id}" has no model. Use a provider:model string (e.g. cursor:auto).`,
      );
    }
    if (!model.includes(':') || model.indexOf(':') === 0 || model.endsWith(':')) {
      throw new Error(
        `LLM agent "${node.id}" model "${model}" is not provider-qualified. Use provider:model.`,
      );
    }
  }
}

/** Overlay progress events onto a declared/effective graph. */
export function buildObservedGraph(
  graph: AgentGraph,
  events: readonly AgentProgressEvent[],
): ObservedAgentGraph {
  const executed = new Set<string>();
  const models = new Set<string>();
  for (const event of events) {
    if (event.author) executed.add(event.author);
    const provider = event.agentEvent?.provider;
    const model = event.agentEvent?.model;
    if (provider && model) models.add(`${provider}:${model}` as ProviderModelId);
    const payloadModel = event.payload?.['model'];
    if (typeof payloadModel === 'string' && payloadModel.includes(':')) {
      models.add(payloadModel);
    }
  }
  return {
    ...graph,
    executedNodeIds: [...executed],
    modelsUsed: [...models],
  };
}
