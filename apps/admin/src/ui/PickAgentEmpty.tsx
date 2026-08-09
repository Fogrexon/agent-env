import { Application } from '@carbon/icons-react';
import { Button } from '@carbon/react';
import { Link, useNavigate } from 'react-router-dom';
import { OpsPanel } from './OpsPanel.js';

export interface RecentAgentLink {
  id: string;
  title: string;
}

export interface PickAgentEmptyProps {
  mode: 'interactive' | 'autonomous';
  /** Present when the URL has an agent id that is not in the catalog. */
  unknownId?: string;
  /** True while the agent list is still loading. */
  loading?: boolean;
  /** No agents of this mode exist at all. */
  noneAvailable?: boolean;
  /** Recently used agents (from sessions / recent inputs), if any. */
  recentAgents?: RecentAgentLink[];
}

/** Empty workspace when Chat/Jobs has no selected agent — discovery lives in Catalog. */
export function PickAgentEmpty({
  mode,
  unknownId,
  loading = false,
  noneAvailable = false,
  recentAgents = [],
}: PickAgentEmptyProps) {
  const navigate = useNavigate();
  const catalogHref = `/catalog?mode=${mode}`;
  const workspace = mode === 'interactive' ? 'Chat' : 'Jobs';
  const modeLabel = mode === 'interactive' ? 'interactive' : 'autonomous';
  const openPath = (id: string) =>
    mode === 'interactive' ? `/chat/${id}` : `/jobs/${id}`;

  let body: string;
  if (loading) {
    body = 'Loading agents…';
  } else if (noneAvailable) {
    body =
      mode === 'interactive'
        ? 'No interactive agents are registered. Add mode: interactive on an agentDefinition, then open it from Catalog.'
        : 'No autonomous agents are registered. Interactive agents live under Chat; add autonomous definitions and open them from Catalog.';
  } else if (unknownId) {
    body = `Unknown agent “${unknownId}”. Pick one from Catalog.`;
  } else {
    body = `${workspace} is a workspace for an agent you already chose. Find and open a ${modeLabel} agent from Catalog.`;
  }

  return (
    <OpsPanel title="Choose an agent">
      <p className="muted" style={{ marginTop: 0 }}>
        {body}
      </p>
      {!loading && recentAgents.length > 0 ? (
        <div className="ops-recent-agents">
          <p className="ops-recent-agents-label muted">Recent</p>
          <ul className="ops-recent-agents-list">
            {recentAgents.map((a) => (
              <li key={a.id}>
                <Link to={openPath(a.id)}>{a.title}</Link>
                <code className="muted">{a.id}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!loading ? (
        <div className="ops-action-row">
          <Button
            kind="primary"
            size="sm"
            renderIcon={Application}
            onClick={() => navigate(catalogHref)}
          >
            Browse catalog
          </Button>
        </div>
      ) : null}
    </OpsPanel>
  );
}
