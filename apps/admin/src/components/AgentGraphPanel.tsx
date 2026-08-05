import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { AgentGraph, ObservedAgentGraph } from '@agent-env/shared';
import {
  buildFlowElements,
  type GraphNodeData,
} from './layoutAgentGraph.js';

export interface AgentGraphPanelProps {
  graph: AgentGraph | ObservedAgentGraph;
  /** Set when this is the run's observed execution overlay rather than the pre-run plan. */
  observed?: boolean;
}

function isObservedGraph(
  graph: AgentGraph | ObservedAgentGraph,
): graph is ObservedAgentGraph {
  return 'executedNodeIds' in graph;
}

type GraphFlowNode = Node<GraphNodeData>;

function sourceKindOf(node: GraphNodeData['graphNode']): string | undefined {
  const kind = node.meta?.['sourceKind'];
  return typeof kind === 'string' ? kind : undefined;
}

function AgentNode({ data }: NodeProps<GraphFlowNode>) {
  const node = data.graphNode;
  const title = node.label ?? node.id;
  const kindLabel =
    node.kind === 'sequential'
      ? 'Sequential'
      : node.kind === 'parallel'
        ? 'Parallel'
        : node.kind === 'review_loop'
          ? 'Review loop'
          : node.kind === 'llm'
            ? 'LLM'
            : node.kind;
  const nonConnectorTools = node.tools.filter((t) => t.kind !== 'connector');
  const flowHint =
    data.flowMode === 'sequential'
      ? 'chain: one after another'
      : data.flowMode === 'parallel'
        ? 'fork: run together'
        : data.isMergeTarget
          ? 'receives parallel results'
          : node.model ??
            (nonConnectorTools.length > 0
              ? nonConnectorTools
                  .map((t) => t.name)
                  .slice(0, 2)
                  .join(', ')
              : undefined);

  return (
    <div
      className={`rf-agent-node kind-${node.kind} flow-${data.flowMode}${
        data.isRoot ? ' is-root' : ''
      }${data.skipped ? ' is-skipped' : ''}${
        data.isMergeTarget ? ' is-merge-target' : ''
      }`}
    >
      <Handle type="target" position={Position.Top} className="rf-handle" />
      <div className="rf-agent-kind">
        {data.flowMode === 'sequential' ? (
          <span className="rf-flow-badge seq">SEQ</span>
        ) : null}
        {data.flowMode === 'parallel' ? (
          <span className="rf-flow-badge par">PAR</span>
        ) : null}
        {data.isMergeTarget ? (
          <span className="rf-flow-badge merge">MERGE</span>
        ) : null}
        <span>{kindLabel}</span>
      </div>
      <div className="rf-agent-title">{title}</div>
      {flowHint ? <div className="rf-agent-sub">{flowHint}</div> : null}
      <Handle type="source" position={Position.Bottom} className="rf-handle" />
    </div>
  );
}

/** Data source / connector — visually distinct from LLM agents. */
function DatasourceNode({ data }: NodeProps<GraphFlowNode>) {
  const node = data.graphNode;
  const title = node.label ?? node.id;
  const sourceKind = sourceKindOf(node);
  const connectorId =
    typeof node.meta?.['connectorId'] === 'string'
      ? node.meta['connectorId']
      : node.id.replace(/^ds:/, '');

  return (
    <div
      className={`rf-datasource-node${data.skipped ? ' is-skipped' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="rf-handle ds" />
      <div className="rf-datasource-kind">
        <span className="rf-flow-badge ds">DS</span>
        <span>{sourceKind ?? 'source'}</span>
      </div>
      <div className="rf-datasource-title">{title}</div>
      <div className="rf-datasource-sub mono">{connectorId}</div>
    </div>
  );
}

const nodeTypes = {
  agent: AgentNode,
  datasource: DatasourceNode,
};

function AgentGraphFlow({
  graph,
  observed,
}: {
  graph: AgentGraph | ObservedAgentGraph;
  observed?: boolean;
}) {
  const observedGraph = isObservedGraph(graph) ? graph : undefined;
  const executed = useMemo(
    () => new Set(observedGraph?.executedNodeIds ?? []),
    [observedGraph],
  );
  const modelsUsed = observedGraph?.modelsUsed ?? [];
  const isObserved = observed ?? Boolean(observedGraph);
  const [showDetails, setShowDetails] = useState(false);

  const { nodes, edges } = useMemo(
    () =>
      buildFlowElements(graph, {
        executedIds: observedGraph ? executed : undefined,
      }),
    [graph, observedGraph, executed],
  );

  const [flowKey, setFlowKey] = useState(0);
  useEffect(() => {
    setFlowKey((k) => k + 1);
  }, [graph]);

  const hasJoin = graph.edges.some((e) => e.kind === 'join');
  const hasHandoff = graph.edges.some((e) => e.kind === 'handoff');
  const hasDatasource = graph.nodes.some((n) => n.kind === 'datasource');

  return (
    <div className="agent-graph-panel">
      <div className="graph-toolbar">
        <p className="muted graph-toolbar-meta">
          {graph.nodes.length} nodes / {graph.edges.length} edges
          {' · '}
          root <span className="mono">{graph.root}</span>
          {isObserved ? ' · observed' : ' · plan'}
          <span className="graph-legend-inline">
            {' '}
            · <span className="rf-flow-badge seq">SEQ</span>
            {' / '}
            <span className="rf-flow-badge par">PAR</span>
            {hasJoin ? (
              <>
                {' / '}
                <span className="rf-flow-badge merge">merge (session)</span>
              </>
            ) : null}
            {hasHandoff ? (
              <>
                {' / '}
                <span className="rf-flow-badge handoff">handoff</span>
              </>
            ) : null}
            {hasDatasource ? (
              <>
                {' / '}
                <span className="rf-flow-badge ds">DS</span>
                {' reads'}
              </>
            ) : null}
          </span>
        </p>
        <div className="graph-toolbar-actions">
          <button
            type="button"
            className="graph-legend-toggle"
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? 'Hide details' : 'Details'}
          </button>
        </div>
      </div>

      {modelsUsed.length > 0 ? (
        <div className="graph-models">
          <span className="graph-models-label">Models used:</span>{' '}
          {modelsUsed.map((m) => (
            <span key={m} className="badge mono">
              {m}
            </span>
          ))}
        </div>
      ) : null}

      <div className="graph-canvas-wrap rf-wrap">
        <ReactFlow
          key={flowKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.35}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
        >
          <Background gap={18} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      {showDetails ? (
        <details className="graph-details" open>
          <summary>Node table</summary>
          <table className="data-table graph-node-table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Kind</th>
                <th>Model / source</th>
                <th>Tools</th>
                {observedGraph ? <th>Executed</th> : null}
              </tr>
            </thead>
            <tbody>
              {graph.nodes.map((node) => (
                <tr
                  key={node.id}
                  className={
                    observedGraph && !executed.has(node.id)
                      ? 'graph-node-skipped'
                      : undefined
                  }
                >
                  <td>
                    <span className="mono">{node.id}</span>
                    {node.label ? (
                      <span className="muted"> {node.label}</span>
                    ) : null}
                  </td>
                  <td>{node.kind}</td>
                  <td className="mono">
                    {node.kind === 'datasource'
                      ? String(node.meta?.['sourceKind'] ?? '-')
                      : (node.model ?? '-')}
                  </td>
                  <td className="muted">
                    {node.tools.length > 0
                      ? node.tools.map((t) => t.name).join(', ')
                      : '-'}
                  </td>
                  {observedGraph ? (
                    <td>{executed.has(node.id) ? 'yes' : '-'}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

export function AgentGraphPanel(props: AgentGraphPanelProps) {
  return (
    <ReactFlowProvider>
      <AgentGraphFlow {...props} />
    </ReactFlowProvider>
  );
}
