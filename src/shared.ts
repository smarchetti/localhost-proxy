import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface LhpConfig {
  port?: number;
  domain?: string;
  dnsPort?: number;
  scheme?: 'worktree' | 'worktree.repo';
  https?: boolean;
  httpsPort?: number;
}

export interface Route {
  name: string;
  port: number;
  pid: number;
  dir: string;
  repo?: string | null;
  branch?: string | null;
  cmd?: string;
  since: number;
}

export const PROXY_HOST = '127.0.0.1';

export const STATE_DIR = path.join(os.homedir(), '.lhp');
export const ROUTES_FILE = path.join(STATE_DIR, 'routes.json');
export const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
export const LOG_FILE = path.join(STATE_DIR, 'daemon.log');

export function readConfig(): LhpConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(config: LhpConfig): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

const config = readConfig();

// Precedence: env var > ~/.lhp/config.json > default.
// Defaults give port-free repo-scoped URLs: http://<worktree>.<repo>.test
// (port 80 binds without root on modern macOS; .test needs one `lhp setup`).
export const PROXY_PORT = Number(process.env.LHP_PROXY_PORT || config.port || 80);
export const DOMAIN = (process.env.LHP_DOMAIN || config.domain || 'test')
  .toLowerCase()
  .replace(/^\./, '');
export const DNS_PORT = Number(process.env.LHP_DNS_PORT || config.dnsPort || 5354);
// 'worktree.repo' -> feature-auth.my-repo.test; 'worktree' -> feature-auth.test
export const SCHEME = process.env.LHP_SCHEME || config.scheme || 'worktree.repo';

const envHttps = process.env.LHP_HTTPS;
export const HTTPS_ENABLED = envHttps != null ? envHttps === '1' || envHttps === 'true' : config.https === true;
export const HTTPS_PORT = Number(process.env.LHP_HTTPS_PORT || config.httpsPort || 443);

export function controlUrl(pathname: string): string {
  return `http://${PROXY_HOST}:${PROXY_PORT}${pathname}`;
}

export function proxyUrl(name: string): string {
  if (HTTPS_ENABLED) {
    const port = HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`;
    return `https://${name}.${DOMAIN}${port}`;
  }
  const port = PROXY_PORT === 80 ? '' : `:${PROXY_PORT}`;
  return `http://${name}.${DOMAIN}${port}`;
}

// DNS labels: lowercase alphanumerics and dashes; dots separate subdomain
// labels (used by the worktree.repo scheme).
export function sanitizeName(raw: string): string {
  const name = raw
    .toLowerCase()
    .split('.')
    .map((label) =>
      label
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
    )
    .filter(Boolean)
    .join('.');
  return name || 'worktree';
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function api<T = unknown>(
  pathname: string,
  options: { timeout?: number; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(controlUrl(pathname), {
    signal: AbortSignal.timeout(options.timeout ?? 2000),
    ...(options.body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(options.body),
        }
      : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`daemon responded ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
