import { useState } from 'react';

import { Bot, Code } from '@carbon/icons-react';

import { Button } from '@carbon/react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { AgentNavList } from './AgentNavList.js';
import { SectionLabel } from './SectionLabel.js';

import { SplitMainHeader } from './SplitMainHeader.js';

import { SplitPageLayout } from './SplitPageLayout.js';



const sampleAgents = [

  {

    id: 'hello',

    title: 'Hello',

    description: 'Minimal builtin sample for smoke tests.',

  },

  {

    id: 'character-chat',

    title: 'Character chat',

    description: 'Interactive persona chat from showcase pack.',

  },

  {

    id: 'web-qa',

    title: 'Web QA',

    description: 'Autonomous research workflow with Tavily tools.',

  },

];



const meta = {

  title: 'Carbon/AgentNavList',

  component: AgentNavList,

  parameters: {

    layout: 'centered',

  },

} satisfies Meta<typeof AgentNavList>;



export default meta;

type Story = StoryObj<typeof meta>;



export const AutonomousSidebar: Story = {

  render: () => {

    const [selectedId, setSelectedId] = useState('web-qa');

    return (

      <div className="ops-split-sider" style={{ width: 260 }}>

        <SectionLabel>Autonomous</SectionLabel>

        <AgentNavList

          items={sampleAgents}

          selectedId={selectedId}

          onSelect={setSelectedId}

        />

      </div>

    );

  },

};



export const InteractiveWithIcon: Story = {

  render: () => {

    const [selectedId, setSelectedId] = useState('character-chat');

    return (

      <div className="ops-split-sider" style={{ width: 260 }}>

        <SectionLabel hint="Bound tools & subagents define the session">

          Interactive

        </SectionLabel>

        <AgentNavList

          items={sampleAgents.filter((a) => a.id !== 'web-qa')}

          selectedId={selectedId}

          icon={<Code size={16} />}

          onSelect={setSelectedId}

        />

      </div>

    );

  },

};



export const JobsPattern: Story = {
  render: () => {
    const [selectedId, setSelectedId] = useState('hello');
    const selected = sampleAgents.find((a) => a.id === selectedId);

    return (
      <div className="ops-storybook-surface ops-storybook-session" style={{ width: 860 }}>
        <SplitPageLayout
          fill
          session
          sidebar={
            <>
              <SectionLabel>Autonomous</SectionLabel>
              <AgentNavList
                items={sampleAgents}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </>
          }
        >
          <div className="ops-split-main-stack">
            <SplitMainHeader title={selected?.title ?? selectedId} />
            <div className="ops-session-body">
              <p className="muted">Param form and recent inputs render here.</p>
            </div>
          </div>
        </SplitPageLayout>
      </div>
    );
  },
};

export const AgentChatPattern: Story = {
  render: () => {
    const [selectedId, setSelectedId] = useState('character-chat');
    const selected = sampleAgents.find((a) => a.id === selectedId);

    return (
      <div className="ops-storybook-surface ops-storybook-session" style={{ width: 860 }}>
        <SplitPageLayout
          fill
          session
          sidebar={
            <>
              <SectionLabel hint="Bound tools & subagents define the session">
                Interactive
              </SectionLabel>
              <AgentNavList
                items={sampleAgents.filter((a) => a.id !== 'web-qa')}
                selectedId={selectedId}
                icon={<Code size={16} />}
                onSelect={setSelectedId}
              />
              <div className="ops-split-sider-section ops-chat-history">
                <SectionLabel>History</SectionLabel>
                <p className="muted ops-chat-history-empty">No saved chats</p>
              </div>
            </>
          }
        >
          <div className="ops-split-main-stack">
            <SplitMainHeader
              title={selected?.title ?? selectedId}
              subtitle={selected?.id ?? '—'}
              icon={<Bot size={20} />}
              actions={
                <Button kind="ghost" size="sm">
                  New chat
                </Button>
              }
            />
            <div className="ops-agent-transcript">
              <div className="ops-agent-empty">
                <Code size={32} className="ops-agent-empty-icon" />
                <h2 className="ops-agent-empty-title">Start a session</h2>
                <p className="muted" style={{ marginBottom: 0 }}>
                  Carbon ContainedList sidebar + dense transcript workspace.
                </p>
              </div>
            </div>
            <footer className="ops-agent-composer">
              <p className="muted" style={{ margin: 0 }}>
                Composer area
              </p>
            </footer>
          </div>
        </SplitPageLayout>
      </div>
    );
  },
};



export const Loading: Story = {

  args: {

    items: [],

    loading: true,

    onSelect: () => undefined,

  },

};



export const Empty: Story = {

  args: {

    items: [],

    emptyMessage: 'No autonomous agents. Interactive ones live under Chat.',

    onSelect: () => undefined,

  },

};


