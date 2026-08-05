import { Breadcrumb, Flex, Typography } from 'antd';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface PageShellProps {
  title: string;
  subtitle?: string;
  crumbs?: Array<{ title: ReactNode; path?: string }>;
  extra?: ReactNode;
  children: ReactNode;
}

export function PageShell({
  title,
  subtitle,
  crumbs,
  extra,
  children,
}: PageShellProps) {
  return (
    <div className="ops-page">
      {crumbs && crumbs.length > 0 ? (
        <Breadcrumb
          className="ops-breadcrumb"
          items={crumbs.map((c) => ({
            title: c.path ? <Link to={c.path}>{c.title}</Link> : c.title,
          }))}
        />
      ) : null}
      <Flex
        align="flex-start"
        justify="space-between"
        gap={16}
        wrap="wrap"
        className="ops-page-head"
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          {subtitle ? (
            <Typography.Text type="secondary">{subtitle}</Typography.Text>
          ) : null}
        </div>
        {extra ? <div className="ops-page-extra">{extra}</div> : null}
      </Flex>
      {children}
    </div>
  );
}
