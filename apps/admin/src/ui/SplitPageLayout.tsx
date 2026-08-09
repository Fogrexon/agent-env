import { Layer } from '@carbon/react';
import type { ReactNode } from 'react';

export interface SplitPageLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  /** Fill remaining viewport height (Agent chat / Jobs run). */
  fill?: boolean;
  /** Full-bleed session chrome (no outer border; denser sider). */
  session?: boolean;
  className?: string;
}

/** Sidebar + main content shell (Agent chat, Jobs run). */
export function SplitPageLayout({
  sidebar,
  children,
  fill = false,
  session = false,
  className,
}: SplitPageLayoutProps) {
  const rootClass = [
    'ops-split-layout',
    fill ? 'is-fill' : '',
    session ? 'is-session' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass}>
      <Layer level={1} className="ops-split-sider">
        {sidebar}
      </Layer>
      <Layer level={0} className="ops-split-content">
        {children}
      </Layer>
    </div>
  );
}
