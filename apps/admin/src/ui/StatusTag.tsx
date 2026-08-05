import { Tag } from 'antd';

const STATUS_COLOR: Record<string, string> = {
  queued: 'default',
  pending: 'default',
  claimed: 'processing',
  running: 'processing',
  completed: 'success',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'warning',
  verifying: 'geekblue',
  repairing: 'orange',
};

export function StatusTag({ status }: { status: string }) {
  const color = STATUS_COLOR[status.toLowerCase()] ?? 'default';
  return (
    <Tag color={color} style={{ marginInlineEnd: 0, fontFamily: 'var(--ant-font-family-code, monospace)' }}>
      {status}
    </Tag>
  );
}
