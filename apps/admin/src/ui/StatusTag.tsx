import { Tag } from '@carbon/react';

type CarbonTagType =
  | 'red'
  | 'magenta'
  | 'purple'
  | 'blue'
  | 'cyan'
  | 'teal'
  | 'green'
  | 'gray'
  | 'cool-gray'
  | 'warm-gray';

const STATUS_TYPE: Record<string, CarbonTagType> = {
  queued: 'gray',
  pending: 'gray',
  claimed: 'blue',
  running: 'blue',
  completed: 'green',
  succeeded: 'green',
  failed: 'red',
  cancelled: 'warm-gray',
  verifying: 'purple',
  repairing: 'teal',
};

export function StatusTag({ status }: { status: string }) {
  const type = STATUS_TYPE[status.toLowerCase()] ?? 'cool-gray';
  return (
    <Tag size="sm" type={type} className="ops-status-tag">
      {status}
    </Tag>
  );
}
