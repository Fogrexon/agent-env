import { Renew } from '@carbon/icons-react';
import {
  Button,
  ContentSwitcher,
  InlineLoading,
  InlineNotification,
  Search,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { listAgents } from '../api/client.js';
import type { AgentListItem } from '../api/types.js';
import { CatalogOpenButton } from '../ui/CatalogOpenButton.js';
import { OpsPanel } from '../ui/OpsPanel.js';
import { PageShell } from '../ui/PageShell.js';
import { SectionLabel } from '../ui/SectionLabel.js';
import { groupAgentsByPack } from '../utils/agent-groups.js';

type ModeFilter = 'all' | 'interactive' | 'autonomous';

const MODE_INDEX: ModeFilter[] = ['all', 'interactive', 'autonomous'];

function modeOf(agent: AgentListItem): 'interactive' | 'autonomous' {
  return agent.mode ?? 'autonomous';
}

function catalogPrimaryLabel(row: AgentListItem): string {
  return (row.title ?? row.name ?? row.id).trim() || row.id;
}

function parseModeParam(raw: string | null): ModeFilter {
  if (raw === 'interactive' || raw === 'autonomous' || raw === 'all') {
    return raw;
  }
  return 'all';
}

export function CatalogPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [modeFilter, setModeFilter] = useState<ModeFilter>(() =>
    parseModeParam(searchParams.get('mode')),
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    const fromUrl = parseModeParam(searchParams.get('mode'));
    setModeFilter((prev) => (prev === fromUrl ? prev : fromUrl));
  }, [searchParams]);

  const setMode = (next: ModeFilter) => {
    setModeFilter(next);
    setPage(1);
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (next === 'all') sp.delete('mode');
        else sp.set('mode', next);
        return sp;
      },
      { replace: true },
    );
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await listAgents();
      setAgents(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      const mode = modeOf(a);
      if (modeFilter !== 'all' && mode !== modeFilter) return false;
      if (!q) return true;
      const hay = `${a.id} ${a.title ?? ''} ${a.name} ${a.description} ${a.pack ?? ''} ${a.group ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [agents, query, modeFilter]);

  const filteredGroups = useMemo(
    () => groupAgentsByPack(filtered),
    [filtered],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const pageGroupPacks = new Set(
    pageRows.map((row) => row.pack ?? 'other'),
  );
  const pageGroups = filteredGroups.filter((g) => pageGroupPacks.has(g.pack));

  return (
    <PageShell
      title="Catalog"
      subtitle="Find agents here — search, compare, then open interactive ones in Chat or autonomous ones as Jobs. Meta pack includes エージェント作成 (agent-author)."
      crumbs={[{ title: 'Catalog', path: '/catalog' }]}
      extra={
        <Button
          kind="tertiary"
          size="sm"
          renderIcon={Renew}
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
      {error ? (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title={error}
          className="ops-inline-alert"
        />
      ) : null}

      <OpsPanel title="Definitions">
        <div className="ops-toolbar">
          <Search
            size="sm"
            labelText="Filter agents"
            placeholder="Filter by id / title / description"
            value={query}
            closeButtonLabelText="Clear"
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            onClear={() => {
              setQuery('');
              setPage(1);
            }}
            className="ops-search"
          />
          <ContentSwitcher
            size="sm"
            selectedIndex={MODE_INDEX.indexOf(modeFilter)}
            onChange={(data: { index?: number; name?: string | number }) => {
              const idx =
                typeof data.index === 'number'
                  ? data.index
                  : MODE_INDEX.indexOf(String(data.name) as ModeFilter);
              const next = MODE_INDEX[idx] ?? 'all';
              setMode(next);
            }}
          >
            <Switch name="all" text="All" />
            <Switch name="interactive" text="Interactive" />
            <Switch name="autonomous" text="Autonomous" />
          </ContentSwitcher>
          <span className="muted">
            {filtered.length} / {agents.length}
          </span>
          {loading ? <InlineLoading description="Loading" /> : null}
        </div>

        {pageRows.length === 0 && !loading ? (
          <p className="muted">
            No agents. Add packs under <code>agents/&lt;pack&gt;/</code>（例:{' '}
            <code>agents/meta/</code> のエージェント作成 /{' '}
            <code>agents/personal/</code>）。See <Link to="/chat">Chat</Link> /{' '}
            <Link to="/jobs">Jobs</Link>.
          </p>
        ) : (
          <div className="ops-catalog-groups">
            {pageGroups.map((group) => {
              const rows = pageRows.filter(
                (row) => (row.pack ?? 'other') === group.pack,
              );
              if (rows.length === 0) return null;
              return (
                <section key={group.pack} className="ops-catalog-group">
                  <SectionLabel hint={group.hint}>{group.label}</SectionLabel>
                  <Table size="sm">
                    <TableHead>
                      <TableRow>
                        <TableHeader>Agent</TableHeader>
                        <TableHeader>Mode</TableHeader>
                        <TableHeader>Description</TableHeader>
                        <TableHeader>Fields</TableHeader>
                        <TableHeader>Open</TableHeader>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.map((row) => {
                        const mode = modeOf(row);
                        const label = catalogPrimaryLabel(row);
                        return (
                          <TableRow key={row.id}>
                            <TableCell>
                              <strong>{label}</strong>
                            </TableCell>
                            <TableCell>
                              <Tag
                                size="sm"
                                type={
                                  mode === 'interactive' ? 'blue' : 'purple'
                                }
                              >
                                {mode}
                              </Tag>
                            </TableCell>
                            <TableCell className="ops-ellipsis muted">
                              {row.description || '—'}
                            </TableCell>
                            <TableCell>{row.fieldCount ?? '—'}</TableCell>
                            <TableCell className="ops-catalog-open">
                              <CatalogOpenButton
                                mode={mode}
                                onClick={() =>
                                  navigate(
                                    mode === 'interactive'
                                      ? `/chat/${row.id}`
                                      : `/jobs/${row.id}`,
                                  )
                                }
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </section>
              );
            })}
          </div>
        )}

        {filtered.length > 0 ? (
          <div className="ops-pager">
            <label className="ops-pager-size">
              Page size{' '}
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value) || 20);
                  setPage(1);
                }}
              >
                {[10, 20, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <div className="ops-pager-nav">
              <Button
                kind="ghost"
                size="sm"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <span className="muted">
                {safePage} / {pageCount}
              </span>
              <Button
                kind="ghost"
                size="sm"
                disabled={safePage >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </OpsPanel>
    </PageShell>
  );
}
