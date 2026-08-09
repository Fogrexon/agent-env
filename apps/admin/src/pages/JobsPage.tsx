import {
  Button,
  Checkbox,
  InlineLoading,
  InlineNotification,
  NumberInput,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
} from '@carbon/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  getAgentParams,
  getRun,
  listAgents,
  listRecentInputs,
  previewAgentGraph,
} from '../api/client.js';
import {
  previewMessage,
  type AgentGraphPreview,
  type AgentListItem,
  type ParamsResponse,
  type RecentInputItem,
} from '../api/types.js';
import { AgentGraphPanel } from '../components/AgentGraphPanel.js';
import { ParamForm } from '../components/ParamForm.js';
import { AgentSelect } from '../ui/AgentSelect.js';
import { OpsPanel } from '../ui/OpsPanel.js';
import { PageShell } from '../ui/PageShell.js';
import {
  PickAgentEmpty,
  type RecentAgentLink,
} from '../ui/PickAgentEmpty.js';
import { StatusTag } from '../ui/StatusTag.js';
import { groupAgentsByPack } from '../utils/agent-groups.js';

function autonomousAgents(agents: AgentListItem[]): AgentListItem[] {
  return agents.filter((a) => (a.mode ?? 'autonomous') === 'autonomous');
}

export function JobsPage() {
  const { agentId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const fromRun = searchParams.get('fromRun');
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [params, setParams] = useState<ParamsResponse | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [autoApprove, setAutoApprove] = useState(true);
  const [priority, setPriority] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [graphPreview, setGraphPreview] = useState<AgentGraphPreview | null>(
    null,
  );
  const [graphLoading, setGraphLoading] = useState(false);
  const [recent, setRecent] = useState<RecentInputItem[]>([]);
  const [reusedFrom, setReusedFrom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentAgents, setRecentAgents] = useState<RecentAgentLink[]>([]);

  const jobAgents = useMemo(() => autonomousAgents(agents), [agents]);
  const jobAgentGroups = useMemo(() => groupAgentsByPack(jobAgents), [jobAgents]);
  const selectedId =
    agentId && jobAgents.some((a) => a.id === agentId) ? agentId : undefined;
  const unknownAgentId =
    Boolean(agentId) &&
    !listLoading &&
    jobAgents.length > 0 &&
    !selectedId
      ? agentId
      : undefined;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setListLoading(true);
      try {
        const a = await listAgents();
        if (cancelled) return;
        setAgents(a);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedId || listLoading || jobAgents.length === 0) {
      setRecentAgents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const rows = await Promise.all(
        jobAgents.slice(0, 16).map(async (agent) => {
          try {
            const inputs = await listRecentInputs(agent.id, 1);
            const latest = inputs[0];
            if (!latest) return null;
            return {
              id: agent.id,
              title: agent.title ?? agent.name ?? agent.id,
              createdAt: latest.createdAt,
            };
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const next = rows
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        )
        .slice(0, 5)
        .map(({ id, title }) => ({ id, title }));
      setRecentAgents(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, listLoading, jobAgents]);

  const refreshRecent = useCallback(async (id: string) => {
    try {
      const inputs = await listRecentInputs(id, 12);
      setRecent(inputs);
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void (async () => {
      setParamsLoading(true);
      setParams(null);
      setGraphPreview(null);
      setReusedFrom(null);
      try {
        const data = await getAgentParams(selectedId);
        if (cancelled) return;
        setParams(data);
        setValues(data.defaults);
        setAutoApprove(true);
        setError(null);
        await refreshRecent(selectedId);
      } catch (err) {
        if (!cancelled) {
          setParams(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setParamsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshRecent]);

  // Apply ?fromRun= once this agent's params finished loading, then clear the query.
  useEffect(() => {
    if (!selectedId || !params || paramsLoading || !fromRun) return;
    let cancelled = false;
    const defaults = params.defaults;
    void (async () => {
      try {
        const snap = await getRun(fromRun);
        if (cancelled) return;
        if (snap.agentId === selectedId && snap.values) {
          setValues({ ...defaults, ...snap.values });
          if (typeof snap.autoApprove === 'boolean') {
            setAutoApprove(snap.autoApprove);
          }
          setReusedFrom(fromRun);
          setGraphPreview(null);
        }
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) {
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.delete('fromRun');
              return next;
            },
            { replace: true },
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromRun, selectedId, params, paramsLoading, setSearchParams]);

  const onFieldChange = useCallback((id: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [id]: value }));
    setReusedFrom(null);
  }, []);

  const applyRecent = (item: RecentInputItem) => {
    setValues((prev) => ({ ...prev, ...item.values }));
    setAutoApprove(item.autoApprove);
    setReusedFrom(item.runId);
    setGraphPreview(null);
  };

  const onPreviewGraph = async () => {
    if (!selectedId) return;
    setGraphLoading(true);
    setError(null);
    try {
      const data = await previewAgentGraph(selectedId, values);
      setGraphPreview(data);
    } catch (err) {
      setGraphPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGraphLoading(false);
    }
  };

  const onBuild = async (overrideValues?: Record<string, unknown>) => {
    if (!selectedId) return;
    const payloadValues = overrideValues ?? values;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${selectedId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          values: payloadValues,
          autoApprove,
          priority,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        runId?: string;
        error?: string;
        issues?: string[];
      };
      if (!res.ok || !data.ok || !data.runId) {
        setError(
          [data.error, ...(data.issues ?? [])].filter(Boolean).join('\n') ||
            `HTTP ${res.status}`,
        );
        return;
      }
      void refreshRecent(selectedId);
      navigate(`/runs/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const title = selectedId
    ? (params?.spec.title ??
      jobAgents.find((a) => a.id === selectedId)?.title ??
      selectedId)
    : 'Jobs';

  const subtitle = selectedId
    ? [selectedId, params?.spec.description ?? null].filter(Boolean).join(' · ')
    : 'Autonomous workspace — pick an agent from Catalog to build a run.';

  return (
    <PageShell
      title={title}
      subtitle={subtitle}
      crumbs={[{ title: 'Jobs' }]}
      extra={
        <div className="ops-page-extra-row">
          {selectedId ? (
            <AgentSelect
              id="jobs-agent-select"
              labelText="Job agent"
              hideLabel
              groups={jobAgentGroups}
              selectedId={selectedId}
              disabled={listLoading}
              onChange={(id) => navigate(`/jobs/${id}`)}
            />
          ) : null}
          <Link className="ops-browse-catalog" to="/catalog?mode=autonomous">
            Browse catalog
          </Link>
        </div>
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

      {!selectedId ? (
        <PickAgentEmpty
          mode="autonomous"
          loading={listLoading}
          unknownId={unknownAgentId}
          noneAvailable={!listLoading && jobAgents.length === 0}
          recentAgents={recentAgents}
        />
      ) : paramsLoading || !params ? (
        paramsLoading ? (
          <InlineLoading description="Loading job" />
        ) : (
          <p className="muted">Select a job</p>
        )
      ) : (
        <>
          <OpsPanel title="Build">
            {reusedFrom ? (
              <p className="ops-reuse-banner muted">
                Form loaded from run{' '}
                <Link to={`/runs/${reusedFrom}`}>
                  <code>{reusedFrom.slice(0, 8)}</code>
                </Link>
                . Edit freely before Build.
              </p>
            ) : null}
            <ParamForm
              fields={params.spec.fields}
              values={values}
              onChange={onFieldChange}
            />
            <div className="ops-inline-controls">
              <Checkbox
                id="jobs-auto-approve"
                labelText="Auto-approve T2"
                checked={autoApprove}
                onChange={(_e, { checked }) => setAutoApprove(checked)}
              />
              <div className="ops-priority-row">
                <span className="muted">Priority</span>
                <NumberInput
                  id="jobs-priority"
                  label=""
                  hideLabel
                  size="sm"
                  value={priority}
                  onChange={(_e, { value }) => setPriority(Number(value) || 0)}
                />
              </div>
            </div>
            <div className="ops-action-row">
              <Button
                kind="primary"
                size="sm"
                disabled={submitting}
                onClick={() => void onBuild()}
              >
                {submitting ? 'Building…' : 'Build'}
              </Button>
              <Button
                kind="secondary"
                size="sm"
                disabled={graphLoading}
                onClick={() => void onPreviewGraph()}
              >
                {graphLoading
                  ? 'Loading…'
                  : graphPreview
                    ? 'Refresh graph'
                    : 'Show graph'}
              </Button>
              <Link to="/queue">View queue</Link>
            </div>
            <p className="muted" style={{ marginTop: 12 }}>
              preview:{' '}
              {previewMessage(values[params.spec.objectiveField]) ?? '—'}
            </p>
          </OpsPanel>

          <OpsPanel
            title="Recent inputs"
            actions={
              <Button
                kind="ghost"
                size="sm"
                onClick={() =>
                  selectedId ? void refreshRecent(selectedId) : undefined
                }
              >
                Refresh
              </Button>
            }
            className="ops-stack-gap ops-recent-inputs"
          >
            {recent.length === 0 ? (
              <p className="muted">No previous runs for this agent yet.</p>
            ) : (
              <StructuredListWrapper aria-label="Recent inputs">
                <StructuredListBody>
                  {recent.map((item) => (
                    <StructuredListRow key={item.runId} id={item.runId}>
                      <StructuredListCell>
                        <div className="ops-recent-meta">
                          <StatusTag status={item.status} />
                          <Tag size="sm" type="gray">
                            {item.trigger}
                          </Tag>
                          <Link to={`/runs/${item.runId}`}>
                            <code>{item.runId.slice(0, 8)}</code>
                          </Link>
                          <span className="muted">
                            {new Date(item.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="ops-recent-preview muted">
                          {item.messagePreview || '—'}
                        </p>
                        <div className="ops-action-row">
                          <Button
                            kind="tertiary"
                            size="sm"
                            onClick={() => applyRecent(item)}
                          >
                            Reuse inputs
                          </Button>
                          <Button
                            kind="ghost"
                            size="sm"
                            onClick={() => {
                              applyRecent(item);
                              void onBuild({ ...values, ...item.values });
                            }}
                          >
                            Reuse &amp; Build
                          </Button>
                        </div>
                      </StructuredListCell>
                    </StructuredListRow>
                  ))}
                </StructuredListBody>
              </StructuredListWrapper>
            )}
          </OpsPanel>

          {graphPreview ? (
            <OpsPanel title="Graph" className="ops-stack-gap">
              <AgentGraphPanel graph={graphPreview.graph} />
            </OpsPanel>
          ) : null}
        </>
      )}
    </PageShell>
  );
}
