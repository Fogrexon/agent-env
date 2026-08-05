/**
 * Layout AgentGraph with dagre (top-to-bottom).
 * Distinguishes sequential chains, parallel forks, session join, and typed handoff.
 */
import dagre from '@dagrejs/dagre';
import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type {
  AgentGraph,
  AgentGraphEdge,
  AgentGraphEdgeKind,
  AgentGraphNode,
} from '@agent-env/shared';

export type GraphLayoutDirection = 'TB';

const NODE_W = 196;
const NODE_H = 82;

export interface GraphNodeData extends Record<string, unknown> {
  graphNode: AgentGraphNode;
  skipped: boolean;
  isRoot: boolean;
  direction: GraphLayoutDirection;
  flowMode: 'sequential' | 'parallel' | 'other';
  /** True when this node receives join/handoff fan-in after a parallel step. */
  isMergeTarget: boolean;
}

function isFeedback(edge: AgentGraphEdge): boolean {
  return edge.kind === 'feedback';
}

function flowModeOf(node: AgentGraphNode): GraphNodeData['flowMode'] {
  if (node.kind === 'sequential' || node.kind === 'review_loop') {
    return 'sequential';
  }
  if (node.kind === 'parallel') return 'parallel';
  return 'other';
}

/**
 * Edges that drive dagre ranking (TB).
 * Skip raw contains when flow edges already explain structure.
 */
function layoutEdges(graph: AgentGraph): AgentGraphEdge[] {
  const byKind = new Map<AgentGraphEdgeKind, AgentGraphEdge[]>();
  for (const e of graph.edges) {
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }

  const out: AgentGraphEdge[] = [];
  const push = (edges: AgentGraphEdge[] | undefined) => {
    if (!edges) return;
    for (const e of edges) {
      if (e.from !== e.to) out.push(e);
    }
  };

  push(byKind.get('next'));
  push(byKind.get('review'));
  push(byKind.get('parallel'));
  push(byKind.get('route'));
  push(byKind.get('join'));
  push(byKind.get('handoff'));
  push(byKind.get('reads'));
  push(byKind.get('delegate'));
  push(byKind.get('tool-call'));

  const nextLike = [
    ...(byKind.get('next') ?? []),
    ...(byKind.get('review') ?? []),
    ...(byKind.get('join') ?? []),
  ];
  const inboundFlow = new Set(nextLike.map((e) => e.to));
  const contains = byKind.get('contains') ?? [];
  const childrenByParent = new Map<string, string[]>();
  for (const e of contains) {
    const list = childrenByParent.get(e.from) ?? [];
    list.push(e.to);
    childrenByParent.set(e.from, list);
  }

  for (const node of graph.nodes) {
    const mode = flowModeOf(node);
    const kids = childrenByParent.get(node.id) ?? [];
    if (kids.length === 0) continue;

    if (mode === 'sequential') {
      const entry = kids.find((id) => !inboundFlow.has(id)) ?? kids[0]!;
      if (!out.some((e) => e.from === node.id && e.to === entry)) {
        out.push({ from: node.id, to: entry, kind: 'next', label: 'start' });
      }
    } else if (mode === 'parallel') {
      const hasParallel = (byKind.get('parallel') ?? []).some(
        (e) => e.from === node.id,
      );
      if (!hasParallel) {
        for (const kid of kids) {
          out.push({ from: node.id, to: kid, kind: 'parallel' });
        }
      }
    } else {
      for (const kid of kids) {
        out.push({ from: node.id, to: kid, kind: 'contains' });
      }
    }
  }

  return out;
}

function edgeVisual(
  kind: AgentGraphEdgeKind,
  feedback: boolean,
  label?: string,
): {
  label?: string;
  stroke: string;
  dash?: string;
  animated: boolean;
  className: string;
} {
  if (feedback) {
    return {
      label: 'feedback',
      stroke: '#8b2e2e',
      dash: '5 4',
      animated: false,
      className: 'rf-edge rf-edge-feedback is-feedback',
    };
  }
  switch (kind) {
    case 'next':
      return {
        label: label ?? 'then',
        stroke: '#0f6b5c',
        animated: false,
        className: 'rf-edge rf-edge-next',
      };
    case 'review':
      return {
        label: 'review',
        stroke: '#6b4f2e',
        animated: false,
        className: 'rf-edge rf-edge-review',
      };
    case 'parallel':
      return {
        label: 'parallel',
        stroke: '#2a5f8f',
        animated: true,
        className: 'rf-edge rf-edge-parallel',
      };
    case 'join':
      return {
        label: label ?? 'merge',
        stroke: '#8a5a00',
        dash: '6 3',
        animated: false,
        className: 'rf-edge rf-edge-join',
      };
    case 'handoff':
      return {
        label: label ?? 'handoff',
        stroke: '#7a2f8a',
        animated: true,
        className: 'rf-edge rf-edge-handoff',
      };
    case 'reads':
      return {
        label: label ?? 'reads',
        stroke: '#3d5a40',
        dash: '3 3',
        animated: false,
        className: 'rf-edge rf-edge-reads',
      };
    case 'route':
      return {
        label: 'route',
        stroke: '#2a5f8f',
        dash: '2 3',
        animated: true,
        className: 'rf-edge rf-edge-route',
      };
    case 'contains':
      return {
        label: 'contains',
        stroke: '#a39a8c',
        dash: '4 3',
        animated: false,
        className: 'rf-edge rf-edge-contains',
      };
    case 'delegate':
      return {
        label: 'delegate',
        stroke: '#6b4f2e',
        animated: false,
        className: 'rf-edge rf-edge-delegate',
      };
    default:
      return {
        label: kind,
        stroke: '#5c564c',
        animated: false,
        className: `rf-edge rf-edge-${kind}`,
      };
  }
}

export function buildFlowElements(
  graph: AgentGraph,
  options: {
    executedIds?: Set<string>;
  },
): { nodes: Node<GraphNodeData>[]; edges: Edge[] } {
  const direction: GraphLayoutDirection = 'TB';
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    nodesep: 48,
    ranksep: 70,
    marginx: 20,
    marginy: 20,
    edgesep: 28,
  });

  for (const node of graph.nodes) {
    const w = node.kind === 'datasource' ? 168 : NODE_W;
    const h = node.kind === 'datasource' ? 72 : NODE_H;
    g.setNode(node.id, { width: w, height: h });
  }

  const rankingEdges = layoutEdges(graph);
  for (const edge of rankingEdges) {
    if (!g.hasNode(edge.from) || !g.hasNode(edge.to)) continue;
    const sequential = edge.kind === 'next' || edge.kind === 'review';
    const parallelFork = edge.kind === 'parallel' || edge.kind === 'route';
    const fanIn = edge.kind === 'join' || edge.kind === 'handoff';
    const reads = edge.kind === 'reads';
    g.setEdge(edge.from, edge.to, {
      minlen: reads ? 1 : 1,
      weight: sequential ? 4 : fanIn ? 3 : parallelFork ? 2 : reads ? 1 : 1,
    });
  }

  dagre.layout(g);

  const parallelParents = new Set(
    graph.edges.filter((e) => e.kind === 'parallel').map((e) => e.from),
  );
  for (const parentId of parallelParents) {
    const kids = graph.edges
      .filter((e) => e.kind === 'parallel' && e.from === parentId)
      .map((e) => e.to);
    if (kids.length < 2) continue;
    const positions = kids
      .map((id) => g.node(id))
      .filter(Boolean) as Array<{ x: number; y: number }>;
    if (positions.length < 2) continue;
    const avgY = positions.reduce((s, p) => s + p.y, 0) / positions.length;
    for (const id of kids) {
      const n = g.node(id);
      if (n) n.y = avgY;
    }
  }

  const mergeTargets = new Set(
    graph.edges
      .filter((e) => e.kind === 'join' || e.kind === 'handoff')
      .map((e) => e.to),
  );

  const executed = options.executedIds;
  const nodes: Node<GraphNodeData>[] = graph.nodes.map((node) => {
    const pos = g.node(node.id);
    const skipped = Boolean(executed) && !executed!.has(node.id);
    const mode = flowModeOf(node);
    const w = node.kind === 'datasource' ? 168 : NODE_W;
    const h = node.kind === 'datasource' ? 72 : NODE_H;
    return {
      id: node.id,
      type: node.kind === 'datasource' ? 'datasource' : 'agent',
      position: {
        x: (pos?.x ?? 0) - w / 2,
        y: (pos?.y ?? 0) - h / 2,
      },
      data: {
        graphNode: node,
        skipped,
        isRoot: node.id === graph.root,
        direction,
        flowMode: mode,
        isMergeTarget: mergeTargets.has(node.id),
      },
      sourcePosition: 'bottom',
      targetPosition: 'top',
    } as Node<GraphNodeData>;
  });

  const hasFlowChild = new Set<string>();
  for (const e of graph.edges) {
    if (
      e.kind === 'next' ||
      e.kind === 'review' ||
      e.kind === 'parallel' ||
      e.kind === 'route' ||
      e.kind === 'join' ||
      e.kind === 'handoff' ||
      e.kind === 'reads'
    ) {
      hasFlowChild.add(`child:${e.to}`);
    }
  }

  const displayEdges = graph.edges.filter((edge) => {
    if (edge.from === edge.to) return false;
    if (edge.kind === 'contains' && hasFlowChild.has(`child:${edge.to}`)) {
      return false;
    }
    return true;
  });

  // Deduplicate identical from/to/kind
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (let i = 0; i < displayEdges.length; i += 1) {
    const edge = displayEdges[i]!;
    const key = `${edge.from}|${edge.to}|${edge.kind}|${edge.label ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const feedback = isFeedback(edge);
    const visual = edgeVisual(edge.kind, feedback, edge.label);
    edges.push({
      id: `${edge.from}-${edge.to}-${edge.kind}-${i}`,
      source: edge.from,
      target: edge.to,
      label: visual.label,
      type: 'smoothstep',
      animated: visual.animated,
      className: visual.className,
      style: {
        stroke: visual.stroke,
        strokeWidth:
          edge.kind === 'join' || edge.kind === 'handoff' || edge.kind === 'parallel'
            ? 2.2
            : 1.6,
        ...(visual.dash ? { strokeDasharray: visual.dash } : {}),
      },
      labelStyle: {
        fill: visual.stroke,
        fontSize: 10,
        fontWeight: 650,
      },
      labelBgStyle: { fill: '#fffdf8', fillOpacity: 0.92 },
      labelBgPadding: [5, 2] as [number, number],
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: visual.stroke,
      },
    } as Edge);
  }

  return { nodes, edges };
}
