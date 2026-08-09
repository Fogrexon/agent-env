import {
  Application,
  Calendar,
  Chat,
  Dashboard,
  FlowData,
  List,
  Play,
  Settings,
} from '@carbon/icons-react';
import {
  Content,
  SideNav,
  SideNavItems,
  SideNavLink,
  SideNavMenu,
  SideNavMenuItem,
  Theme,
} from '@carbon/react';
import type { MouseEvent } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

function selectedKey(pathname: string): string {
  if (pathname.startsWith('/catalog') || pathname === '/') return '/catalog';
  if (pathname.startsWith('/chat')) return '/chat';
  if (pathname.startsWith('/jobs') || pathname.startsWith('/runs')) return '/jobs';
  if (pathname.startsWith('/queue')) return '/queue';
  if (pathname.startsWith('/schedules')) return '/schedules';
  if (pathname.startsWith('/dashboard')) return '/dashboard';
  if (pathname.startsWith('/settings')) return '/settings';
  return '/catalog';
}

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const selected = selectedKey(location.pathname);
  const jobsOpen =
    selected === '/jobs' ||
    selected === '/queue' ||
    selected === '/schedules';

  return (
    <div className="ops-shell">
      <Theme theme="g100">
        <SideNav
          aria-label="Side navigation"
          isFixedNav
          expanded
          isChildOfHeader={false}
          className="ops-sidenav"
        >
          <div className="ops-brand">
            <div className="ops-brand-mark">
              <FlowData size={16} /> agent-env
            </div>
            <div className="ops-brand-sub">control plane</div>
          </div>
          <SideNavItems>
            <SideNavLink
              renderIcon={Application}
              isActive={selected === '/catalog'}
              onClick={(e: MouseEvent) => {
                e.preventDefault();
                navigate('/catalog');
              }}
              href="/catalog"
            >
              Catalog
            </SideNavLink>
            <SideNavLink
              renderIcon={Chat}
              isActive={selected === '/chat'}
              onClick={(e: MouseEvent) => {
                e.preventDefault();
                navigate('/chat');
              }}
              href="/chat"
            >
              Chat
            </SideNavLink>
            <SideNavMenu
              renderIcon={FlowData}
              title="Jobs"
              defaultExpanded={jobsOpen}
              isActive={jobsOpen}
            >
              <SideNavMenuItem
                isActive={selected === '/jobs'}
                onClick={(e: MouseEvent) => {
                  e.preventDefault();
                  navigate('/jobs');
                }}
                href="/jobs"
              >
                <Play size={16} style={{ marginInlineEnd: 8 }} />
                Run
              </SideNavMenuItem>
              <SideNavMenuItem
                isActive={selected === '/queue'}
                onClick={(e: MouseEvent) => {
                  e.preventDefault();
                  navigate('/queue');
                }}
                href="/queue"
              >
                <List size={16} style={{ marginInlineEnd: 8 }} />
                Queue
              </SideNavMenuItem>
              <SideNavMenuItem
                isActive={selected === '/schedules'}
                onClick={(e: MouseEvent) => {
                  e.preventDefault();
                  navigate('/schedules');
                }}
                href="/schedules"
              >
                <Calendar size={16} style={{ marginInlineEnd: 8 }} />
                Schedules
              </SideNavMenuItem>
            </SideNavMenu>
            <SideNavLink
              renderIcon={Dashboard}
              isActive={selected === '/dashboard'}
              onClick={(e: MouseEvent) => {
                e.preventDefault();
                navigate('/dashboard');
              }}
              href="/dashboard"
            >
              Dashboard
            </SideNavLink>
            <SideNavLink
              renderIcon={Settings}
              isActive={selected === '/settings'}
              onClick={(e: MouseEvent) => {
                e.preventDefault();
                navigate('/settings');
              }}
              href="/settings"
            >
              Settings
            </SideNavLink>
          </SideNavItems>
        </SideNav>
      </Theme>

      <Content className="ops-content">
        <header className="ops-header">
          <span className="ops-header-meta">Catalog · Chat · Jobs</span>
        </header>
        <div className="ops-content-body">
          <Outlet />
        </div>
      </Content>
    </div>
  );
}
