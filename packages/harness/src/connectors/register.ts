import { registerConnector } from './registry.js';
import { createDemoConnectors } from './demo.js';
import {
  createGithubGhConnector,
  isGithubGhAvailable,
} from './github-gh.js';
import {
  createGrokBuildXSearchConnector,
  isGrokBuildAvailable,
  type CreateGrokBuildXSearchConnectorOptions,
} from './grok-build-x.js';
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
  /**
   * Register X search via Grok Build headless when `grok` is available.
   * Default: false (opt-in). Pass `true` to auto-detect.
   */
  grokBuildX?: boolean | CreateGrokBuildXSearchConnectorOptions;
  /** Extra HTTP JSON connectors (easy plug-ins). */
  http?: CreateSimpleHttpJsonConnectorOptions[];
  /**
   * Web search connector(s) — prefer Tavily via env.
   * - `true`: auto from `TAVILY_API_KEY` / `BRAVE_API_KEY`
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
 * Pass HTTP / web / GitHub / Grok Build X wiring as needed.
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

  if (options.grokBuildX) {
    const available = await isGrokBuildAvailable();
    if (available) {
      const xOpts =
        typeof options.grokBuildX === 'object' ? options.grokBuildX : {};
      const x = createGrokBuildXSearchConnector(xOpts);
      registerConnector(x, { replace });
      registered.push(x);
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
