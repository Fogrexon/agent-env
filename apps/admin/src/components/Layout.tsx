import {
  CalendarOutlined,
  ControlOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { Flex, Layout, Menu, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

const { Header, Sider, Content } = Layout;

const NAV = [
  { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: '/jobs', icon: <DeploymentUnitOutlined />, label: 'Jobs' },
  { key: '/queue', icon: <UnorderedListOutlined />, label: 'Queue' },
  { key: '/schedules', icon: <CalendarOutlined />, label: 'Schedules' },
  { key: '/settings', icon: <SettingOutlined />, label: 'Settings' },
] as const;

function selectedKey(pathname: string): string {
  if (pathname.startsWith('/jobs') || pathname.startsWith('/runs')) return '/jobs';
  if (pathname.startsWith('/queue')) return '/queue';
  if (pathname.startsWith('/schedules')) return '/schedules';
  if (pathname.startsWith('/settings')) return '/settings';
  return '/';
}

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  const selected = useMemo(
    () => [selectedKey(location.pathname)],
    [location.pathname],
  );

  return (
    <Layout className="ops-shell">
      <Sider width={220} breakpoint="lg" collapsedWidth={64} theme="dark">
        <Flex vertical className="ops-brand" gap={2}>
          <Typography.Text className="ops-brand-mark">
            <ControlOutlined /> agent-env
          </Typography.Text>
          <Typography.Text className="ops-brand-sub">
            control plane
          </Typography.Text>
        </Flex>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selected}
          items={[...NAV]}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header className="ops-header" style={{ borderBottomColor: token.colorBorder }}>
          <Typography.Text type="secondary" className="ops-header-meta">
            Durable queue · RunSpec · Evaluation
          </Typography.Text>
        </Header>
        <Content className="ops-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
