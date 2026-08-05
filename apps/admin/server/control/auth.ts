/**
 * Optional Basic Auth for admin Control Plane.
 * Enabled only when both ADMIN_BASIC_USER and ADMIN_BASIC_PASSWORD are set.
 */
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

export interface BasicAuthConfig {
  enabled: boolean;
  user?: string;
  password?: string;
}

export function readBasicAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): BasicAuthConfig {
  const user = env['ADMIN_BASIC_USER']?.trim();
  const password = env['ADMIN_BASIC_PASSWORD'];
  if (user && password !== undefined && password !== '') {
    return { enabled: true, user, password };
  }
  return { enabled: false };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Protects `/api/*` except health and webhook hooks.
 * Webhooks authenticate via their own token.
 */
export function createBasicAuthMiddleware(config: BasicAuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.enabled || !config.user || config.password === undefined) {
      next();
      return;
    }

    const path = req.path;
    if (path === '/api/health' || path.startsWith('/api/hooks/')) {
      next();
      return;
    }
    if (!path.startsWith('/api/')) {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header?.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="agent-env-admin"');
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      res.setHeader('WWW-Authenticate', 'Basic realm="agent-env-admin"');
      res.status(401).json({ error: 'Invalid Authorization header' });
      return;
    }
    const colon = decoded.indexOf(':');
    const user = colon >= 0 ? decoded.slice(0, colon) : decoded;
    const pass = colon >= 0 ? decoded.slice(colon + 1) : '';
    if (
      !safeEqual(user, config.user) ||
      !safeEqual(pass, config.password)
    ) {
      res.setHeader('WWW-Authenticate', 'Basic realm="agent-env-admin"');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    next();
  };
}
