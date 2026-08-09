import { Select, SelectItem } from '@carbon/react';
import type { AgentPackGroup } from '../utils/agent-groups.js';

export interface AgentSelectProps {
  id: string;
  labelText?: string;
  hideLabel?: boolean;
  groups: AgentPackGroup[];
  selectedId?: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  className?: string;
}

function itemLabel(
  agent: AgentPackGroup['agents'][number],
  packLabel: string,
  showPack: boolean,
): string {
  const title = agent.title ?? agent.name ?? agent.id;
  if (!showPack) return title;
  return `${title} · ${packLabel}`;
}

/** Compact agent picker for control-plane headers (not a second sidebar). */
export function AgentSelect({
  id,
  labelText = 'Agent',
  hideLabel = false,
  groups,
  selectedId,
  onChange,
  disabled = false,
  className,
}: AgentSelectProps) {
  const flat = groups.flatMap((g) =>
    g.agents.map((agent) => ({ agent, packLabel: g.label })),
  );
  const showPack = groups.length > 1;

  return (
    <Select
      id={id}
      labelText={labelText}
      hideLabel={hideLabel}
      size="sm"
      value={selectedId ?? ''}
      disabled={disabled || flat.length === 0}
      className={className ? `ops-agent-select ${className}` : 'ops-agent-select'}
      onChange={(e) => {
        const next = e.target.value;
        if (next) onChange(next);
      }}
    >
      {flat.length === 0 ? (
        <SelectItem value="" text="No agents" />
      ) : (
        flat.map(({ agent, packLabel }) => (
          <SelectItem
            key={agent.id}
            value={agent.id}
            text={itemLabel(agent, packLabel, showPack)}
          />
        ))
      )}
    </Select>
  );
}
