import {
  AppstoreOutlined,
  CalendarOutlined,
  ControlOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { Flex, Layout, Menu, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

const { Header, Sider, Content } = Layout;

type MenuItem = Required<MenuProps>['items'][number];

const NAV: MenuItem[] = [
  { key: '/catalog', icon: <AppstoreOutlined />, label: 'Catalog' },
  { key: '/chat', icon: <MessageOutlined />, label: 'Chat' },
  {
    key: 'jobs-group',
    icon: <DeploymentUnitOutlined />,
    label: 'Jobs',
    children: [
      { key: '/jobs', icon: <PlayCircleOutlined />, label: 'Run' },
      { key: '/queue', icon: <UnorderedListOutlined />, label: 'Queue' },
      { key: '/schedules', icon: <CalendarOutlined />, label: 'Schedules' },
    ],
  },
  { key: '/dashboard', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: '/settings', icon: <SettingOutlined />, label: 'Settings' },
];

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
  const { token } = theme.useToken();
  const selected = useMemo(
    () => [selectedKey(location.pathname)],
    [location.pathname],
  );
  const [openKeys, setOpenKeys] = useState<string[]>(['jobs-group']);

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
          openKeys={openKeys}
          onOpenChange={setOpenKeys}
          items={NAV}
          onClick={({ key }) => {
            if (key === 'jobs-group') return;
            navigate(key);
          }}
        />
      </Sider>
      <Layout>
        <Header className="ops-header" style={{ borderBottomColor: token.colorBorder }}>
          <Typography.Text type="secondary" className="ops-header-meta">
            Catalog · Chat · Jobs
          </Typography.Text>
        </Header>
        <Content className="ops-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
