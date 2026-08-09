import {
  Button,
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
import {
  getControlSettings,
  listAgents,
  listAudit,
  listWebhookTokens,
} from '../api/client.js';
import type { AgentListItem, WebhookTokenItem } from '../api/types.js';
import { PageShell } from '../ui/PageShell.js';
import { OpsPanel } from '../ui/OpsPanel.js';

type AuditRow = {
  id: string;
  action: string;
  detailJson: string;
  createdAt: string;
};

export function SettingsPage() {
  const [settings, setSettings] = useState<{
    maxSlots: number;
    running: number;
    queueDepth: number;
    authEnabled: boolean;
    dbPath: string;
  } | null>(null);
  const [tokens, setTokens] = useState<WebhookTokenItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createdRaw, setCreatedRaw] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    agentId: '',
    message: '',
  });
  const [auditPage, setAuditPage] = useState(1);
  const auditPageSize = 20;

  const refresh = async () => {
    try {
      const [s, t, a, au] = await Promise.all([
        getControlSettings(),
        listWebhookTokens(),
        listAgents(),
        listAudit(40),
      ]);
      setSettings(s);
      setTokens(t);
      setAgents(a);
      setAudit(au);
      if (!form.agentId && a[0]) {
        setForm((f) => ({ ...f, agentId: a[0]!.id }));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreateToken = async () => {
    setCreatedRaw(null);
    try {
      const res = await fetch('/api/hooks/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name || `${form.agentId}-hook`,
          agentId: form.agentId,
          values: { message: form.message },
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        rawToken?: string;
        hookPath?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setCreatedRaw(
        data.hookPath
          ? `${window.location.origin.replace(':5173', ':8799')}${data.hookPath}`
          : (data.rawToken ?? null),
      );
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleToken = async (id: string, enabled: boolean) => {
    await fetch(`/api/hooks/tokens/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    void refresh();
  };

  const deleteToken = async (id: string) => {
    if (!window.confirm('Delete this webhook token?')) return;
    await fetch(`/api/hooks/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    void refresh();
  };

  const auditPages = Math.max(1, Math.ceil(audit.length / auditPageSize));
  const safeAuditPage = Math.min(auditPage, auditPages);
  const auditRows = audit.slice(
    (safeAuditPage - 1) * auditPageSize,
    safeAuditPage * auditPageSize,
  );

  return (
    <PageShell
      title="Settings"
      subtitle="Slots, auth, webhooks, audit"
      crumbs={[{ title: 'Settings' }]}
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

      <OpsPanel title="Control plane">
        {settings ? (
          <dl className="ops-desc">
            <div>
              <dt>maxSlots</dt>
              <dd>
                <strong>{settings.maxSlots}</strong>{' '}
                <span className="muted">(env ADMIN_MAX_SLOTS)</span>
              </dd>
            </div>
            <div>
              <dt>running / queue</dt>
              <dd>
                {settings.running} / {settings.queueDepth}
              </dd>
            </div>
            <div>
              <dt>auth</dt>
              <dd>
                <strong>
                  {settings.authEnabled ? 'Basic enabled' : 'disabled'}
                </strong>{' '}
                <span className="muted">
                  (ADMIN_BASIC_USER / ADMIN_BASIC_PASSWORD)
                </span>
              </dd>
            </div>
            <div>
              <dt>db</dt>
              <dd>
                <code>{settings.dbPath}</code>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </OpsPanel>

      <OpsPanel title="Webhook tokens" className="ops-stack-gap">
        <div className="ops-form" style={{ maxWidth: 720, marginBottom: 16 }}>
          <div className="ops-form-row">
            <TextInput
              id="hook-name"
              labelText="Name"
              size="sm"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
            />
            <Select
              id="hook-agent"
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
          </div>
          <TextInput
            id="hook-message"
            labelText="Default message"
            size="sm"
            value={form.message}
            onChange={(e) =>
              setForm((f) => ({ ...f, message: e.target.value }))
            }
          />
          <div>
            <Button kind="primary" size="sm" onClick={() => void onCreateToken()}>
              Issue token
            </Button>
          </div>
        </div>
        {createdRaw ? (
          <InlineNotification
            kind="success"
            lowContrast
            hideCloseButton
            title="POST once (save now)"
            subtitle={createdRaw}
            className="ops-inline-alert"
          />
        ) : null}
        <Table size="sm">
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              <TableHeader>Agent</TableHeader>
              <TableHeader>Prefix</TableHeader>
              <TableHeader>Last used</TableHeader>
              <TableHeader>Enabled</TableHeader>
              <TableHeader />
            </TableRow>
          </TableHead>
          <TableBody>
            {tokens.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <span className="ops-inline-gap">
                    {row.name}
                    {!row.enabled ? <span className="muted">off</span> : null}
                  </span>
                </TableCell>
                <TableCell>
                  <code>{row.agentId}</code>
                </TableCell>
                <TableCell>
                  <code>{row.tokenPrefix}…</code>
                </TableCell>
                <TableCell>
                  {row.lastUsedAt
                    ? new Date(row.lastUsedAt).toLocaleString()
                    : '—'}
                </TableCell>
                <TableCell>
                  <Toggle
                    id={`hook-toggle-${row.id}`}
                    size="sm"
                    hideLabel
                    labelA="Off"
                    labelB="On"
                    toggled={row.enabled}
                    onToggle={(checked) => void toggleToken(row.id, checked)}
                  />
                </TableCell>
                <TableCell>
                  <Button
                    kind="danger--tertiary"
                    size="sm"
                    onClick={() => void deleteToken(row.id)}
                  >
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </OpsPanel>

      <OpsPanel title="Audit log" className="ops-stack-gap">
        <Table size="sm">
          <TableHead>
            <TableRow>
              <TableHeader>When</TableHeader>
              <TableHeader>Action</TableHeader>
              <TableHeader>Detail</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {auditRows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  {new Date(row.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <strong>{row.action}</strong>
                </TableCell>
                <TableCell className="ops-ellipsis">{row.detailJson}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {audit.length > auditPageSize ? (
          <div className="ops-pager">
            <Button
              kind="ghost"
              size="sm"
              disabled={safeAuditPage <= 1}
              onClick={() => setAuditPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <span className="muted">
              {safeAuditPage} / {auditPages}
            </span>
            <Button
              kind="ghost"
              size="sm"
              disabled={safeAuditPage >= auditPages}
              onClick={() =>
                setAuditPage((p) => Math.min(auditPages, p + 1))
              }
            >
              Next
            </Button>
          </div>
        ) : null}
      </OpsPanel>
    </PageShell>
  );
}
