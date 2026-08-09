import type { Decorator } from '@storybook/react-vite';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CatalogOpenButton } from './CatalogOpenButton.js';

const meta = {
  title: 'Carbon/CatalogOpenButton',
  component: CatalogOpenButton,
} satisfies Meta<typeof CatalogOpenButton>;

export default meta;
type Story = StoryObj<typeof meta>;

const inCatalogCell: Decorator = (Story) => (
  <div className="ops-catalog-open">
    <Story />
  </div>
);

export const OpenInChat: Story = {
  args: {
    mode: 'interactive',
    onClick: () => undefined,
  },
  decorators: [inCatalogCell],
};

export const RunAsJob: Story = {
  args: {
    mode: 'autonomous',
    onClick: () => undefined,
  },
  decorators: [inCatalogCell],
};

export const Pair: Story = {
  render: () => (
    <div className="ops-inline-gap">
      <div className="ops-catalog-open">
        <CatalogOpenButton mode="interactive" onClick={() => undefined} />
      </div>
      <div className="ops-catalog-open">
        <CatalogOpenButton mode="autonomous" onClick={() => undefined} />
      </div>
    </div>
  ),
};
