import { Heading } from '@carbon/react';
import type { ReactNode } from 'react';

export interface SectionLabelProps {
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}

/** Carbon label heading for sidebars and grouped sections. */
export function SectionLabel({ children, hint, className }: SectionLabelProps) {
  return (
    <div className={className ? `ops-section-head ${className}` : 'ops-section-head'}>
      <Heading type="label-01" className="ops-section-label">
        {children}
      </Heading>
      {hint ? <span className="ops-section-hint muted">{hint}</span> : null}
    </div>
  );
}
