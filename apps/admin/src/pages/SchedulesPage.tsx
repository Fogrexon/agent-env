import {
  Button,
  Checkbox,
  InlineNotification,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextInput,
  Toggle,
} from '@carbon/react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listAgents, listSchedules } from '../api/client.js';
import type { AgentListItem, ScheduleItem } from '../api/types.js';
import { PageShell } from '../ui/PageShell.js';
import { OpsPanel } from '../ui/OpsPanel.js';

export function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    agentId: '',
    cron: '0 * * * *',
    message: '',
    enabled: true,
  });

  const refresh = async () => {
    try {
      const [s, a] = await Promise.all([listSchedules(), listAgents()]);
      const autonomous = a.filter(
        (x) => (x.mode ?? 'autonomous') === 'autonomous',
      );
      setSchedules(s);
      setAgents(autonomous);
      if (!form.agentId && autonomous[0]) {
        setForm((f) => ({ ...f, agentId: autonomous[0]!.id }));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreate = async () => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: form.agentId,
          cron: form.cron,
          values: { message: form.message },
          enabled: form.enabled,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    void refresh();
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('Delete this schedule?')) return;
    await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    void refresh();
  };

  return (
    <PageShell
      title="Schedules"
      subtitle="Enqueue jobs on a cron expression"
      crumbs={[{ title: 'Jobs', path: '/jobs' }, { title: 'Schedules' }]}
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

      <OpsPanel title="New schedule">
        <div className="ops-form" style={{ maxWidth: 720 }}>
          <div className="ops-form-row">
            <Select
              id="schedule-agent"
              labelText="Agent"
              size="sm"
              value={form.agentId}
              onChange={(e) =>
                setForm((f) => ({ ...f, agentId: e.target.value }))
              }
            >
              {agents.map((a) => (
                <SelectItem
                  key={a.id}
                  value={a.id}
                  text={a.title ?? a.id}
                />
              ))}
            </Select>
            <TextInput
              id="schedule-cron"
              labelText="Cron"
              size="sm"
              value={form.cron}
              placeholder="0 * * * *"
              onChange={(e) =>
                setForm((f) => ({ ...f, cron: e.target.value }))
              }
            />
          </div>
          <TextInput
            id="schedule-message"
            labelText="Message (objective)"
            size="sm"
            value={form.message}
            onChange={(e) =>
              setForm((f) => ({ ...f, message: e.target.value }))
            }
          />
          <div className="ops-inline-controls">
            <Checkbox
              id="schedule-enabled"
              labelText="Enabled"
              checked={form.enabled}
              onChange={(_e, { checked }) =>
                setForm((f) => ({ ...f, enabled: checked }))
              }
            />
          </div>
          <div>
            <Button
              kind="primary"
              size="sm"
              disabled={submitting}
              onClick={() => void onCreate()}
            >
              {submitting ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </div>
      </OpsPanel>

      <OpsPanel title="Configured" className="ops-stack-gap">
        {schedules.length === 0 ? (
          <p className="muted">No schedules</p>
        ) : (
          <Table size="sm">
            <TableHead>
              <TableRow>
                <TableHeader>Agent</TableHeader>
                <TableHeader>Cron</TableHeader>
                <TableHeader>Next</TableHeader>
                <TableHeader>Last job</TableHeader>
                <TableHeader>Enabled</TableHeader>
                <TableHeader />
              </TableRow>
            </TableHead>
            <TableBody>
              {schedules.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <span className="ops-inline-gap">
                      <Link to={`/jobs/${row.agentId}`}>
                        <code>{row.agentId}</code>
                      </Link>
                      {!row.enabled ? (
                        <span className="muted">off</span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code>{row.cron}</code>
                  </TableCell>
                  <TableCell>
                    {row.nextRunAt
                      ? new Date(row.nextRunAt).toLocaleString()
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {row.lastJobId ? (
                      <code>{row.lastJobId.slice(0, 8)}</code>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <Toggle
                      id={`sched-toggle-${row.id}`}
                      size="sm"
                      hideLabel
                      labelA="Off"
                      labelB="On"
                      toggled={row.enabled}
                      onToggle={(checked) => void toggle(row.id, checked)}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      kind="danger--tertiary"
                      size="sm"
                      onClick={() => void onDelete(row.id)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </OpsPanel>
    </PageShell>
  );
}
