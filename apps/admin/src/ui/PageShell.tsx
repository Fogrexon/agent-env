import { Breadcrumb, BreadcrumbItem, Heading } from '@carbon/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface PageShellProps {
  title: string;
  subtitle?: string;
  crumbs?: Array<{ title: ReactNode; path?: string }>;
  extra?: ReactNode;
  children: ReactNode;
  /** Stretch to fill the content column (Chat workspace). */
  fill?: boolean;
  className?: string;
}

export function PageShell({
  title,
  subtitle,
  crumbs,
  extra,
  children,
  fill = false,
  className,
}: PageShellProps) {
  const rootClass = ['ops-page', fill ? 'is-fill' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass}>
      {crumbs && crumbs.length > 0 ? (
        <Breadcrumb noTrailingSlash className="ops-breadcrumb">
          {crumbs.map((c, i) => (
            <BreadcrumbItem key={i} isCurrentPage={!c.path}>
              {c.path ? <Link to={c.path}>{c.title}</Link> : c.title}
            </BreadcrumbItem>
          ))}
        </Breadcrumb>
      ) : null}
      <div className="ops-page-head">
        <div>
          <Heading type="heading-03" className="ops-page-title">
            {title}
          </Heading>
          {subtitle ? (
            <p className="ops-page-subtitle cds--body-compact-01">{subtitle}</p>
          ) : null}
        </div>
        {extra ? <div className="ops-page-extra">{extra}</div> : null}
      </div>
      {children}
    </div>
  );
}
