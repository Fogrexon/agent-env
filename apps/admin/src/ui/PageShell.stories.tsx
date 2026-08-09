import { Renew } from '@carbon/icons-react';

import { Button } from '@carbon/react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { PageShell } from './PageShell.js';



const meta = {

  title: 'Carbon/PageShell',

  component: PageShell,

  parameters: {

    layout: 'fullscreen',

  },

} satisfies Meta<typeof PageShell>;



export default meta;

type Story = StoryObj<typeof meta>;



export const Catalog: Story = {

  args: {

    title: 'Catalog',

    subtitle:

      'Discovered workflow definitions — open interactive agents in Chat, autonomous ones as Jobs.',

    crumbs: [{ title: 'Catalog', path: '/catalog' }],

    extra: (

      <Button kind="tertiary" size="sm" renderIcon={Renew}>

        Refresh

      </Button>

    ),

    children: (

      <p className="muted">

        Page body uses Carbon g10 tokens, heading-03 page titles, body-compact-01

        subtitles, and flat Tile panels at productive density.

      </p>

    ),

  },

};



export const Dashboard: Story = {

  args: {

    title: 'Dashboard',

    subtitle: 'Executor slots, queue depth, recent builds',

    crumbs: [{ title: 'Dashboard' }],

    children: (

      <p className="muted">

        Metrics use Carbon Grid + Tile; tables use Data Table primitives.

      </p>

    ),

  },

};


