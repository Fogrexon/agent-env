import { ConfigProvider, theme as antTheme } from 'antd';
import type { ReactNode } from 'react';

/** Dense ops-console tokens — teal accent, sharp corners, not purple SaaS. */
export const adminTheme = {
  algorithm: antTheme.defaultAlgorithm,
  token: {
    colorPrimary: '#0f6b5c',
    colorInfo: '#2a5f8f',
    colorSuccess: '#2f6b3a',
    colorWarning: '#8a5a00',
    colorError: '#8b2e2e',
    colorBgLayout: '#eef1f0',
    colorBgContainer: '#fbfcfb',
    colorBorder: '#c9d0cc',
    colorText: '#1a1f1d',
    colorTextSecondary: '#5a6560',
    borderRadius: 4,
    fontFamily:
      '"IBM Plex Sans", "Segoe UI", system-ui, -apple-system, sans-serif',
    fontFamilyCode:
      '"IBM Plex Mono", "Cascadia Code", ui-monospace, monospace',
    fontSize: 13,
    controlHeight: 32,
  },
  components: {
    Layout: {
      siderBg: '#141a18',
      headerBg: '#fbfcfb',
      bodyBg: '#eef1f0',
      triggerBg: '#0f1513',
    },
    Menu: {
      darkItemBg: '#141a18',
      darkSubMenuItemBg: '#101614',
      darkItemSelectedBg: '#0f6b5c',
      darkItemHoverBg: '#1c2622',
      itemBorderRadius: 4,
    },
    Table: {
      headerBg: '#e8eeeb',
      rowHoverBg: '#f0f5f2',
      borderColor: '#c9d0cc',
      cellPaddingBlockSM: 6,
      cellPaddingInlineSM: 10,
    },
    Card: {
      borderRadiusLG: 4,
    },
    Button: {
      borderRadius: 4,
    },
  },
} as const;

export function AdminThemeProvider({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={adminTheme} componentSize="middle">
      {children}
    </ConfigProvider>
  );
}
