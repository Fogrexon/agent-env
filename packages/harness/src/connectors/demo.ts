import { createMemoryConnector, type DataSourceConnector } from './types.js';
import { registerConnector } from './registry.js';

/**
 * Demo connectors with fixture data (no external network).
 * Replace factories with real APIs by closing over credentials in your app.
 */
export function createDemoConnectors(): DataSourceConnector[] {
  const kb = createMemoryConnector({
    id: 'kb',
    title: 'Product knowledge base',
    description: 'Internal FAQ / runbooks (fixture).',
    tags: ['docs', 'faq'],
    records: [
      {
        title: 'Remote access VPN',
        body: 'Employees must use the company VPN before accessing staging databases. Guest accounts are prohibited on production bastion hosts.',
        uri: 'kb://vpn',
      },
      {
        title: 'Incident severity levels',
        body: 'SEV-1: customer-wide outage. SEV-2: major feature broken. SEV-3: workaround available. Page on-call for SEV-1/2 within 5 minutes.',
        uri: 'kb://sev',
      },
      {
        title: 'Data retention',
        body: 'Application logs are retained 30 days; audit logs 365 days. PII in debug logs is a policy violation.',
        uri: 'kb://retention',
      },
    ],
  });

  const crm = createMemoryConnector({
    id: 'crm',
    title: 'CRM snippets',
    description: 'Account notes and open opportunities (fixture).',
    tags: ['crm', 'sales'],
    records: [
      {
        title: 'Acme Corp',
        body: 'Enterprise renewal in 45 days. Risk: missing SSO rollout. Champion: Mina (IT). ARR $180k.',
        uri: 'crm://acme',
      },
      {
        title: 'Globex',
        body: 'Pilot of collector agents for ops briefings. Asked for Notion + PagerDuty connectors next quarter.',
        uri: 'crm://globex',
      },
      {
        title: 'Initech',
        body: 'Churn risk after support delay last month. Credit offered. Needs weekly status digest.',
        uri: 'crm://initech',
      },
    ],
  });

  const status = createMemoryConnector({
    id: 'status',
    title: 'Ops status board',
    description: 'Current incidents and maintenance windows (fixture).',
    tags: ['ops', 'status'],
    records: [
      {
        title: 'API latency elevated',
        body: 'SEV-2 investigating p95 latency on /v1/search since 02:10 UTC. Mitigation: cache warmers redeployed. Next update in 30m.',
        uri: 'status://inc-221',
      },
      {
        title: 'Scheduled maintenance',
        body: 'Read replica failover drill Sunday 09:00–11:00 UTC. Expect brief read-only blips in analytics.',
        uri: 'status://maint-12',
      },
      {
        title: 'All clear: billing',
        body: 'Yesterday SEV-3 invoice PDF rendering issue resolved. No customer action needed.',
        uri: 'status://inc-218',
      },
    ],
  });

  return [kb, crm, status];
}

/** Idempotent registration of demo connectors for sample agents / CLI. */
export function registerDemoConnectors(): DataSourceConnector[] {
  const created = createDemoConnectors();
  for (const connector of created) {
    registerConnector(connector, { replace: true });
  }
  return created;
}
