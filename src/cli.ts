import { spawn, spawnSync, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROXY_PORT, DOMAIN, DNS_PORT, SCHEME, STATE_DIR, LOG_FILE, CONFIG_FILE,
  sanitizeName, api, proxyUrl, readConfig, writeConfig, type Route,
} from './shared';

// In the published bundle this module lives in dist/lhp.js next to
// dist/daemon.js; when running from source, bun executes daemon.ts directly.
const DAEMON_PATH = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? './daemon.ts' : './daemon.js', import.meta.url)
);

interface Flags {
  name?: string;
  port?: string;
}

interface RegisterResponse {
  name: string;
  url: string;
}

interface ProjectConfig {
  env?: Record<string, string | null>;
}

interface TemplateVars {
  url: string;
  port: number;
  name: string;
}

const HELP = `localhost-proxy — stable per-worktree dev URLs

Usage:
  lhp [--name <name>] [--port <port>] [--] <dev command...>
      Wrap a dev command: allocates a port (exported as PORT), registers this
      worktree with the proxy daemon, and runs the command. The -- is
      optional. Any literal {port} in the command is replaced with the
      allocated port (for servers that ignore PORT, e.g.
      lhp -- vite --port {port}).

  lhp list                 Show registered worktrees
  lhp status               Show daemon status
  lhp stop                 Stop the proxy daemon
  lhp config               Show configuration (~/.lhp/config.json)
  lhp config port <n>      Set the proxy's listen port (default 80: port-free URLs)
  lhp config domain <tld>  Set the URL domain (default "test"; "localhost" needs no setup)
  lhp config scheme <s>    "worktree.repo" (default) or "worktree" (no repo subdomain)
  lhp setup                One-time sudo step non-localhost domains need (/etc/resolver)
  lhp help                 Show this help

The proxy listens on http://localhost:${PROXY_PORT} (dashboard) and routes
${proxyUrl('<worktree>')} to each worktree's dev server.
Env overrides: LHP_PROXY_PORT, LHP_DOMAIN, LHP_DNS_PORT, LHP_SCHEME.
After changing config, run \`lhp stop\` — the daemon restarts with the new
settings on the next dev run.`;

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

// The repo name comes from the main repository's directory (the common .git
// dir is shared by all worktrees), falling back to the origin remote's name.
function detectRepo(cwd: string): string | null {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (common) {
    const dir = path.basename(common) === '.git' ? path.dirname(common) : common;
    const base = path.basename(dir).replace(/\.git$/, '');
    if (base) return base;
  }
  const origin = git(['remote', 'get-url', 'origin'], cwd);
  return origin ? path.basename(origin).replace(/\.git$/, '') : null;
}

function detectWorktree(cwd: string) {
  const toplevel = git(['rev-parse', '--show-toplevel'], cwd);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const repoName = detectRepo(cwd);
  const repo = repoName ? sanitizeName(repoName) : null;
  let name = sanitizeName(path.basename(toplevel || cwd));
  if (SCHEME === 'worktree.repo' && repo) {
    // The main checkout's dir often IS the repo name — avoid repo.repo.
    name = name === repo ? repo : `${name}.${repo}`;
  }
  return {
    dir: toplevel || cwd,
    name,
    repo,
    branch: branch === 'HEAD' ? git(['rev-parse', '--short', 'HEAD'], cwd) : branch,
  };
}

// Project-level config: an "lhp" key in the nearest package.json (the app
// being run — matters in monorepos) or a .lhp.json at the worktree root.
// Currently supports { "env": { "KEY": "{url}" } } with {url}/{port}/{name}
// placeholders, so any framework can be told its public URL without lhp
// knowing about it.
function readProjectConfig(cwd: string, worktreeDir: string): ProjectConfig {
  const sources: Array<() => ProjectConfig | undefined> = [
    () => JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).lhp,
    () => JSON.parse(fs.readFileSync(path.join(worktreeDir, '.lhp.json'), 'utf8')),
    () => JSON.parse(fs.readFileSync(path.join(worktreeDir, 'package.json'), 'utf8')).lhp,
  ];
  for (const read of sources) {
    try {
      const config = read();
      if (config) return config;
    } catch {
      // missing or unparsable — try the next location
    }
  }
  return {};
}

function fillTemplate(value: string, vars: TemplateVars): string {
  return String(value)
    .replaceAll('{url}', vars.url)
    .replaceAll('{port}', String(vars.port))
    .replaceAll('{name}', vars.name);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

interface Health {
  ok: boolean;
  pid: number;
  port: number;
  started: number;
}

async function daemonAlive(): Promise<Health | null> {
  try {
    return await api<Health>('/api/health', { timeout: 700 });
  } catch {
    return null;
  }
}

async function ensureDaemon(): Promise<void> {
  if (await daemonAlive()) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');
  spawn(process.execPath, [DAEMON_PATH], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  }).unref();
  fs.closeSync(logFd);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await daemonAlive()) return;
  }
  throw new Error(`proxy daemon failed to start — see ${LOG_FILE}`);
}

async function cmdRun(flags: Flags, command: string[]): Promise<void> {
  if (!command.length) {
    console.error('No dev command given. Usage: lhp -- <dev command...>\n');
    console.error(HELP);
    process.exit(1);
  }

  const wt = detectWorktree(process.cwd());
  const name = flags.name ? sanitizeName(flags.name) : wt.name;
  const port = flags.port ? Number(flags.port) : Number(process.env.PORT) || (await freePort());

  await ensureDaemon();
  const reg = await api<RegisterResponse>('/api/register', {
    body: {
      name, port, pid: process.pid,
      dir: wt.dir, repo: wt.repo, branch: wt.branch, cmd: command.join(' '),
    },
  });

  const url = reg.url || proxyUrl(reg.name);
  const vars: TemplateVars = { url, port, name: reg.name };
  const args = command.map((a) => fillTemplate(a, vars));

  console.log('');
  console.log(`  ┌ localhost-proxy`);
  console.log(`  │ worktree   ${reg.name}${wt.branch ? `  (${wt.branch})` : ''}`);
  console.log(`  │ proxied    ${url}`);
  console.log(`  │ upstream   http://localhost:${port}`);
  console.log(`  └ running    ${args.join(' ')}`);
  console.log('');

  // Env injection, lowest to highest precedence — the shell env always wins
  // so explicit user settings are never overridden:
  //   1. Built-in defaults for Auth.js/NextAuth (harmless when unused): apps
  //      must build absolute URLs on the proxy origin, and the Next dev
  //      server rewrites forwarded headers, so trustHost alone can't see it.
  //   2. Project config env ({url}/{port}/{name} templates).
  // Note shell env also beats .env files in Next, so injected values win
  // over stale localhost values in .env.local.
  const injected: Record<string, string> = {
    AUTH_URL: url,
    NEXTAUTH_URL: url,
    AUTH_TRUST_HOST: 'true',
  };
  const project = readProjectConfig(process.cwd(), wt.dir);
  for (const [key, value] of Object.entries(project.env ?? {})) {
    if (value === null) delete injected[key]; // opt out of a built-in default
    else injected[key] = fillTemplate(value, vars);
  }
  for (const key of Object.keys(injected)) {
    if (key in process.env) delete injected[key];
  }

  const child = spawn(args[0]!, args.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port), LHP_URL: url, LHP_NAME: reg.name, ...injected },
  });

  const startedAt = Date.now();
  let receivedSignal: string | null = null;
  let exiting = false;
  const cleanup = async (code: number, detail: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    // Dev servers are expected to run until interrupted — always say why we
    // stopped, so a silent instant exit (or a stray SIGINT from a wrapper
    // like turbo) is diagnosable from the task output.
    console.error(
      `lhp: ${args[0]} exited ${detail} after ${secs}s` +
        (receivedSignal ? ` (lhp received ${receivedSignal})` : '') +
        ` — unregistered ${reg.name}`
    );
    await api('/api/unregister', { body: { name: reg.name, pid: process.pid } }).catch(() => {});
    process.exit(code);
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      receivedSignal = sig;
      // Forward to the child; cleanup runs when it exits.
      child.kill(sig);
      // If the child is already gone, clean up ourselves.
      if (child.exitCode !== null || child.signalCode) cleanup(0, `(${sig})`);
    });
  }
  child.on('error', (err) => {
    console.error(`lhp: failed to run "${args[0]}": ${err.message}`);
    cleanup(1, '(spawn error)');
  });
  child.on('exit', (code, signal) =>
    cleanup(signal ? 0 : code ?? 0, signal ? `(${signal})` : `(code ${code ?? 0})`)
  );
}

async function cmdList(): Promise<void> {
  const alive = await daemonAlive();
  if (!alive) {
    console.log('Proxy daemon is not running. It starts automatically with `lhp -- <cmd>`.');
    return;
  }
  const { routes } = await api<{ routes: Route[] }>('/api/routes');
  if (!routes.length) {
    console.log(`No worktrees registered. Dashboard: http://localhost:${PROXY_PORT}/`);
    return;
  }
  const width = Math.max(...routes.map((r) => r.name.length));
  for (const r of routes.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(
      `${r.name.padEnd(width)}  ${proxyUrl(r.name)}  ->  :${r.port}` +
        (r.branch ? `  (${r.branch})` : '')
    );
  }
}

async function cmdStatus(): Promise<void> {
  const alive = await daemonAlive();
  if (!alive) {
    console.log('daemon: not running');
    return;
  }
  const { routes } = await api<{ routes: Route[] }>('/api/routes');
  console.log(`daemon: running (pid ${alive.pid}, port ${alive.port})`);
  console.log(`routes: ${routes.length}`);
  console.log(`dashboard: http://localhost:${alive.port}/`);
}

// TLDs where a plain-http local domain can't work: .dev and .app are real
// Google TLDs on the browser HSTS-preload list (forced HTTPS), .local is
// claimed by mDNS/Bonjour.
const BAD_DOMAINS: Record<string, string> = {
  dev: 'browsers force HTTPS on .dev (HSTS-preloaded TLD) — http:// URLs will never load',
  app: 'browsers force HTTPS on .app (HSTS-preloaded TLD) — http:// URLs will never load',
  local: '.local is reserved for mDNS/Bonjour and resolves unpredictably on macOS',
};

async function cmdConfig(key?: string, value?: string): Promise<void> {
  if (!key) {
    console.log(`config file: ${CONFIG_FILE}`);
    console.log(JSON.stringify(readConfig(), null, 2));
    console.log(`\neffective:  port=${PROXY_PORT}  domain=${DOMAIN}  scheme=${SCHEME}  dnsPort=${DNS_PORT}`);
    const example = SCHEME === 'worktree.repo' ? '<worktree>.<repo>' : '<worktree>';
    console.log(`worktree URLs look like: ${proxyUrl(example)}`);
    return;
  }
  const config = readConfig();
  if (key === 'port' || key === 'proxy-port') {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${value}`);
      process.exit(1);
    }
    config.port = port;
  } else if (key === 'domain') {
    const domain = (value || '').toLowerCase().replace(/^\./, '');
    if (!/^[a-z0-9-]+$/.test(domain)) {
      console.error(`Invalid domain: "${value}" — use a single label like "test" or "orca"`);
      process.exit(1);
    }
    if (BAD_DOMAINS[domain]) {
      console.error(`Refusing ".${domain}": ${BAD_DOMAINS[domain]}`);
      console.error('Good choices: .test (IETF-reserved), .localhost (zero-setup), or made up like .orca');
      process.exit(1);
    }
    config.domain = domain;
  } else if (key === 'scheme') {
    if (value !== 'worktree' && value !== 'worktree.repo') {
      console.error(`Invalid scheme: "${value}" (valid: worktree, worktree.repo)`);
      process.exit(1);
    }
    config.scheme = value;
  } else {
    console.error(`Unknown config key: ${key} (valid: port, domain, scheme)`);
    process.exit(1);
  }
  writeConfig(config);
  console.log(`Saved to ${CONFIG_FILE}: ${JSON.stringify(config)}`);
  if (config.domain && config.domain !== 'localhost') {
    console.log(`\nCustom domains need a one-time resolver entry: run \`lhp setup\``);
  }
  if (await daemonAlive()) {
    console.log(`\nThe daemon is running with the old settings — run \`lhp stop\`;`);
    console.log(`it restarts automatically with the new settings on the next dev run.`);
  }
}

async function cmdSetup(): Promise<void> {
  if (DOMAIN === 'localhost') {
    console.log('Domain is "localhost" — no setup needed, *.localhost already resolves.');
    return;
  }
  const resolverFile = `/etc/resolver/${DOMAIN}`;
  const content = `nameserver 127.0.0.1\nport ${DNS_PORT}\n`;
  console.log(`Writing ${resolverFile} so macOS sends *.${DOMAIN} lookups to lhp's`);
  console.log(`local DNS responder (127.0.0.1:${DNS_PORT}). This needs sudo:\n`);
  const script =
    `mkdir -p /etc/resolver && printf '${content}' > ${resolverFile}` +
    ` && dscacheutil -flushcache && killall -HUP mDNSResponder`;
  const result = spawnSync('sudo', ['sh', '-c', script], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nsetup failed — you can do it manually:\n  sudo sh -c "${script}"`);
    process.exit(1);
  }
  console.log(`\nDone. *.${DOMAIN} now resolves to 127.0.0.1 whenever the daemon is running.`);
  console.log(`Worktree URLs: ${proxyUrl('<worktree>')}`);
}

async function cmdStop(): Promise<void> {
  if (!(await daemonAlive())) {
    console.log('daemon: not running');
    return;
  }
  await api('/api/shutdown', { body: {} }).catch(() => {}); // socket may drop mid-response
  console.log('daemon stopped');
}

const SUBCOMMANDS = new Set(['list', 'ls', 'status', 'stop', 'config', 'setup', 'help', 'run', '-h', '--help']);

export async function main(argv: string[]): Promise<void> {
  // Flags are only recognized at the front, and `--` is optional: wrappers
  // like bun and mise shims consume the first `--` themselves, so anything
  // that isn't a known subcommand is treated as the dev command to run.
  const flags: Flags = {};
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === '--name') { flags.name = argv[i + 1]; i += 2; }
    else if (argv[i] === '--port') { flags.port = argv[i + 1]; i += 2; }
    else break;
  }
  if (argv[i] === '--') i++;
  const rest = argv.slice(i);
  const sub = rest[0];

  if (!SUBCOMMANDS.has(sub ?? '')) return cmdRun(flags, rest);

  if (sub === 'list' || sub === 'ls') return cmdList();
  if (sub === 'status') return cmdStatus();
  if (sub === 'stop') return cmdStop();
  if (sub === 'config') return cmdConfig(rest[1], rest[2]);
  if (sub === 'setup') return cmdSetup();
  if (sub === 'help' || sub === '-h' || sub === '--help') return void console.log(HELP);
  // 'run': unambiguous form for dev commands whose binary shares a subcommand name
  const command = rest[1] === '--' ? rest.slice(2) : rest.slice(1);
  return cmdRun(flags, command);
}
