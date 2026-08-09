import { Renew } from '@carbon/icons-react';

import { Button, Tag } from '@carbon/react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { OpsPanel } from './OpsPanel.js';



const meta = {

  title: 'Carbon/OpsPanel',

  component: OpsPanel,

  parameters: {

    layout: 'padded',

  },

} satisfies Meta<typeof OpsPanel>;



export default meta;

type Story = StoryObj<typeof meta>;



export const FlatTilePanel: Story = {

  args: {

    title: 'Recent builds',

    actions: (

      <Button kind="ghost" size="sm" renderIcon={Renew}>

        Refresh

      </Button>

    ),

    children: (

      <p className="muted">

        Flat Carbon Tile wrapper — productive density (heading-02 titles,

        sm tables/buttons) for Dashboard, Queue, Jobs, Settings.

      </p>

    ),

  },

};



export const TriggerTags: Story = {

  args: {

    title: 'Triggers (24h)',

    children: (

      <div className="ops-chip-row">

        <Tag size="sm" type="gray">

          manual: 12

        </Tag>

        <Tag size="sm" type="gray">

          schedule: 4

        </Tag>

      </div>

    ),

  },

};


