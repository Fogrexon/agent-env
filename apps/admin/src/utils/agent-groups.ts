import type { AgentListItem } from '../api/types.js';

export const PACK_ORDER = ['meta', 'builtin', 'showcase', 'personal'] as const;

export const PACK_HINTS: Record<string, string> = {
  meta: 'エージェント作成などのメタ作業',
  showcase: '公開デモ',
  personal: 'ホスト側の自動化',
  builtin: '組み込みサンプル',
};

export function packDisplayLabel(pack: string, group?: string): string {
  return group ?? pack;
}

export interface AgentPackGroup {
  pack: string;
  label: string;
  hint?: string;
  agents: AgentListItem[];
}

/** Group agents by pack with stable section order (meta first). */
export function groupAgentsByPack(agents: AgentListItem[]): AgentPackGroup[] {
  const byPack = new Map<string, AgentListItem[]>();
  for (const agent of agents) {
    const pack = agent.pack ?? 'other';
    const list = byPack.get(pack) ?? [];
    list.push(agent);
    byPack.set(pack, list);
  }

  const orderedPacks = [
    ...PACK_ORDER.filter((pack) => byPack.has(pack)),
    ...[...byPack.keys()]
      .filter((pack) => !PACK_ORDER.includes(pack as typeof PACK_ORDER[number]))
      .sort(),
  ];

  return orderedPacks.map((pack) => {
    const groupAgents = byPack.get(pack) ?? [];
    const label = packDisplayLabel(pack, groupAgents[0]?.group);
    return {
      pack,
      label,
      hint: PACK_HINTS[pack],
      agents: groupAgents.sort((a, b) => a.id.localeCompare(b.id)),
    };
  });
}
