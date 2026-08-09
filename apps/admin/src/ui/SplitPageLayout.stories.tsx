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
  title: 'Carbon/SplitPageLayout',
  component: SplitPageLayout,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof SplitPageLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Dense session shell: Layer sidebar + main, toolbar header, scrollable body. */
export const AgentSession: Story = {
  render: () => {
    const [selectedId, setSelectedId] = useState('character-chat');
    const selected = sampleAgents.find((a) => a.id === selectedId);

    return (
      <div className="ops-storybook-surface ops-storybook-session">
        <SplitPageLayout
          fill
          session
          sidebar={
            <>
              <SectionLabel hint="Grouped by plugin pack">
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
                  Full-bleed Carbon session — ContainedList nav, Layer panes.
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

/** Jobs run uses the same Carbon session chrome as Agent chat. */
export const JobsRun: Story = {
  render: () => {
    const [selectedId, setSelectedId] = useState('web-qa');
    const selected = sampleAgents.find((a) => a.id === selectedId);

    return (
      <div className="ops-storybook-surface ops-storybook-session">
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
            <SplitMainHeader
              title={selected?.title ?? selectedId}
              subtitle={selected?.id ?? '—'}
            />
            <div className="ops-session-body">
              <p className="muted">
                Param form, StructuredList recent inputs, Tile graph panel.
              </p>
            </div>
          </div>
        </SplitPageLayout>
      </div>
    );
  },
};
