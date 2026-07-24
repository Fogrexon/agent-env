import { registerConnector } from './registry.js';
import { createDemoConnectors } from './demo.js';
import {
  createGithubGhConnector,
  isGithubGhAvailable,
  type CreateGithubGhConnectorOptions,
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
  type CreateWebSearchConnectorOptions,
} from './web-search.js';
import type { DataSourceConnector } from './types.js';

export interface RegisterConnectorsOptions {
  /** Include KB/CRM/status fixtures. Default true. */
  demo?: boolean;
  /**
   * Register GitHub via `gh` when the CLI is authenticated.
   * Pass options (e.g. `repo`) from the app — this helper does not read env.
   * `true` ≡ `{}` (repo from `gh repo view` if available).
   */
  githubGh?: boolean | CreateGithubGhConnectorOptions;
  /**
   * Register X search via Grok Build headless when `grok` is available.
   * `true` ≡ `{}`. Auth is whatever `grok login` already configured.
   */
  grokBuildX?: boolean | CreateGrokBuildXSearchConnectorOptions;
  /** Extra HTTP JSON connectors (easy plug-ins). */
  http?: CreateSimpleHttpJsonConnectorOptions[];
  /**
   * Web search connector(s). Caller must pass `provider` + `apiKey`
   * (no env auto-detection in the harness).
   */
  webSearch?:
    | CreateWebSearchConnectorOptions
    | CreateWebSearchConnectorOptions[];
  replace?: boolean;
}

/**
 * One-shot registration helper for apps / sample agents.
 * Configuration and secrets are always supplied by the caller.
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

  if (options.githubGh) {
    const ghOpts =
      typeof options.githubGh === 'object' ? options.githubGh : {};
    const available = await isGithubGhAvailable();
    if (available) {
      const github = createGithubGhConnector(ghOpts);
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

  if (options.webSearch) {
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
