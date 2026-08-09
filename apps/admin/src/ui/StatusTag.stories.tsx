import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusTag } from './StatusTag.js';

const meta = {
  title: 'Carbon/StatusTag',
  component: StatusTag,
} satisfies Meta<typeof StatusTag>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Queued: Story = {
  args: { status: 'queued' },
};

export const Running: Story = {
  args: { status: 'running' },
};

export const Succeeded: Story = {
  args: { status: 'succeeded' },
};

export const Failed: Story = {
  args: { status: 'failed' },
};

export const AllStatuses: Story = {
  render: () => (
    <div className="ops-inline-gap ops-wrap">
      {[
        'queued',
        'pending',
        'claimed',
        'running',
        'completed',
        'succeeded',
        'failed',
        'cancelled',
        'verifying',
        'repairing',
      ].map((status) => (
        <StatusTag key={status} status={status} />
      ))}
    </div>
  ),
};
