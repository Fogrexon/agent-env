import { InlineLoading } from '@carbon/react';
import type { ReactNode } from 'react';
import { AgentNavList, type AgentNavEntry } from './AgentNavList.js';
import { SectionLabel } from './SectionLabel.js';
import type { AgentPackGroup } from '../utils/agent-groups.js';

export interface AgentNavGroupsProps {
  groups: AgentPackGroup[];
  selectedId?: string;
  onSelect: (id: string) => void;
  emptyMessage?: ReactNode;
  loading?: boolean;
  icon?: ReactNode;
}

function toNavEntry(agent: AgentPackGroup['agents'][number]): AgentNavEntry {
  return {
    id: agent.id,
    title: agent.title,
    name: agent.name,
    description: agent.description,
  };
}

export function AgentNavGroups({
  groups,
  selectedId,
  onSelect,
  emptyMessage = 'No agents.',
  loading = false,
  icon,
}: AgentNavGroupsProps) {
  if (loading) {
    return <InlineLoading description="Loading" />;
  }

  const total = groups.reduce((n, g) => n + g.agents.length, 0);
  if (total === 0) {
    return (
      <p className="muted ops-nav-empty">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="ops-nav-groups">
      {groups.map((group) => (
        <div key={group.pack} className="ops-nav-group">
          <SectionLabel hint={group.hint}>{group.label}</SectionLabel>
          <AgentNavList
            items={group.agents.map(toNavEntry)}
            selectedId={selectedId}
            onSelect={onSelect}
            icon={icon}
          />
        </div>
      ))}
    </div>
  );
}
