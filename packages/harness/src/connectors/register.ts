import { registerConnector } from './registry.js';
import { createDemoConnectors } from './demo.js';
import {
  createGithubGhConnector,
  isGithubGhAvailable,
} from './github-gh.js';
import {
  createSimpleHttpJsonConnector,
  type CreateSimpleHttpJsonConnectorOptions,
} from './http.js';
import {
  createWebSearchConnector,
  createWebSearchConnectorFromEnv,
  type CreateWebSearchConnectorOptions,
} from './web-search.js';
import type { DataSourceConnector } from './types.js';

export interface RegisterConnectorsOptions {
  /** Include KB/CRM/status fixtures. Default true. */
  demo?: boolean;
  /**
   * Register GitHub via `gh` when the CLI is authenticated.
   * Default: true when available.
   */
  githubGh?: boolean | { repo?: string; id?: string };
  /** Extra HTTP JSON connectors (easy plug-ins). */
  http?: CreateSimpleHttpJsonConnectorOptions[];
  /**
   * Web search connector(s).
   * - `true`: auto from `BRAVE_API_KEY` / `TAVILY_API_KEY`
   * - object / array: explicit `createWebSearchConnector` options
   */
  webSearch?:
    | boolean
    | CreateWebSearchConnectorOptions
    | CreateWebSearchConnectorOptions[];
  replace?: boolean;
}

/**
 * One-shot registration helper for apps / sample agents.
 * Pass HTTP connector configs and optional GitHub / web search wiring.
 */
export async function registerConnectors(
  options: RegisterConnectorsOptions = {},
): Promise<DataSourceConnector[]> {
  const replace = options.replace ?? true;
  const registered: DataSourceConnector[] = [];

  if (options.demo ?? true) {
    for (const connector of createDemoConnectors()) {
      registerConnector(connector, { replace });
      registered.push(connector);
    }
  }

  const wantGithub = options.githubGh !== false;
  if (wantGithub) {
    const ghOpts =
      typeof options.githubGh === 'object' ? options.githubGh : {};
    const available = await isGithubGhAvailable();
    if (available) {
      const github = createGithubGhConnector({
        id: ghOpts.id ?? 'github',
        repo: ghOpts.repo ?? process.env['GH_REPO'],
      });
      registerConnector(github, { replace });
      registered.push(github);
    }
  }

  for (const http of options.http ?? []) {
    const connector = createSimpleHttpJsonConnector(http);
    registerConnector(connector, { replace });
    registered.push(connector);
  }

  if (options.webSearch === true) {
    const web = createWebSearchConnectorFromEnv();
    if (web) {
      registerConnector(web, { replace });
      registered.push(web);
    }
  } else if (options.webSearch) {
    const list = Array.isArray(options.webSearch)
      ? options.webSearch
      : [options.webSearch];
    for (const cfg of list) {
      const connector = createWebSearchConnector(cfg);
      registerConnector(connector, { replace });
      registered.push(connector);
    }
  }

  return registered;
}
