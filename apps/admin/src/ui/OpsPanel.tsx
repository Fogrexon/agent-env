import { Heading, Tile } from '@carbon/react';
import type { ReactNode } from 'react';

export interface OpsPanelProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Flat Carbon Tile panel — replaces rounded SaaS card panels. */
export function OpsPanel({ title, actions, children, className }: OpsPanelProps) {
  const rootClass = ['ops-panel', className].filter(Boolean).join(' ');
  return (
    <Tile className={rootClass}>
      {title || actions ? (
        <div className="ops-panel-head">
          {title ? (
            <Heading type="heading-02" className="ops-panel-title">
              {title}
            </Heading>
          ) : (
            <span />
          )}
          {actions}
        </div>
      ) : null}
      {children}
    </Tile>
  );
}
