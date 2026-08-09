import {
  ContainedList,
  ContainedListItem,
  InlineLoading,
} from '@carbon/react';
import type { ReactNode } from 'react';

export interface AgentNavEntry {
  id: string;
  title?: string;
  name?: string;
  description?: string;
}

export interface AgentNavListProps {
  items: AgentNavEntry[];
  selectedId?: string;
  onSelect: (id: string) => void;
  emptyMessage?: ReactNode;
  loading?: boolean;
  icon?: ReactNode;
  className?: string;
}

function primaryLabel(item: AgentNavEntry): string {
  return item.title ?? item.name ?? item.id;
}

export function AgentNavList({
  items,
  selectedId,
  onSelect,
  emptyMessage = 'No agents.',
  loading = false,
  icon,
  className,
}: AgentNavListProps) {
  if (loading) {
    return <InlineLoading description="Loading" />;
  }

  if (items.length === 0) {
    return <p className="muted ops-nav-empty">{emptyMessage}</p>;
  }

  return (
    <ContainedList
      label=""
      kind="on-page"
      size="sm"
      isInset
      className={className ? `ops-nav-list ${className}` : 'ops-nav-list'}
    >
      {items.map((item) => {
        const active = item.id === selectedId;
        const primary = primaryLabel(item);
        const showId = primary !== item.id;
        return (
          <ContainedListItem
            key={item.id}
            onClick={() => onSelect(item.id)}
            className={active ? 'ops-nav-item is-active' : 'ops-nav-item'}
          >
            <span className="ops-nav-item-row">
              {icon ? <span className="ops-nav-item-icon">{icon}</span> : null}
              <span className="ops-nav-item-body">
                <span className="ops-nav-item-title">{primary}</span>
                {showId ? (
                  <code className="ops-nav-item-id">{item.id}</code>
                ) : null}
                <span className="ops-nav-item-desc">
                  {item.description || '—'}
                </span>
              </span>
            </span>
          </ContainedListItem>
        );
      })}
    </ContainedList>
  );
}
