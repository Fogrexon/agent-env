import { Heading } from '@carbon/react';
import type { ReactNode } from 'react';

export interface SplitMainHeaderProps {
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}

/** Title bar inside the split layout main pane (Jobs, Agent chat). */
export function SplitMainHeader({
  title,
  subtitle,
  icon,
  actions,
}: SplitMainHeaderProps) {
  return (
    <header className="ops-split-header">
      <div className="ops-split-header-title">
        {icon ? <span className="ops-split-header-icon">{icon}</span> : null}
        <div className="ops-split-header-text">
          <Heading type="heading-02" className="ops-split-title">
            {title}
          </Heading>
          {subtitle ? (
            <span className="ops-split-subtitle muted">{subtitle}</span>
          ) : null}
        </div>
      </div>
      {actions ? <div className="ops-split-header-actions">{actions}</div> : null}
    </header>
  );
}
