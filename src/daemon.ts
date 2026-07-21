// The lhp proxy daemon. One instance per machine, listening on PROXY_PORT.
//
//   http://localhost:<port>            -> dashboard + control API
//   http://<name>.<domain>[:<port>]    -> proxied to that worktree's dev server
//
// Routes are registered by the `lhp` CLI wrapping each dev command, persisted
// to disk so a daemon restart keeps them, and pruned when the registering
// process dies.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import {
  PROXY_PORT, PROXY_HOST, DOMAIN, DNS_PORT, HTTPS_ENABLED, HTTPS_PORT,
  STATE_DIR, ROUTES_FILE, pidAlive, proxyUrl, type Route,
} from './shared';
import { ensureCa, ensureLeaf, LEAF_KEY, LEAF_CERT } from './certs';
import { dashboardHtml, errorHtml, esc } from './pages';
import { startDnsServer } from './dns';

const started = Date.now();
const routes = new Map<string, Route>();

fs.mkdirSync(STATE_DIR, { recursive: true });
loadRoutes();
setInterval(() => { pruneDead(); probeHealth(); }, 5000).unref();
probeHealth();

// A cheap TCP connect tells the dashboard whether each dev server is
// actually answering, not just registered.
function probeHealth(): void {
  for (const r of routes.values()) {
    const sock = net.connect({ port: r.port, host: PROXY_HOST });
    const timer = setTimeout(() => { sock.destroy(); r.healthy = false; }, 500);
    sock.on('connect', () => { clearTimeout(timer); r.healthy = true; sock.end(); });
    sock.on('error', () => { clearTimeout(timer); r.healthy = false; });
  }
}

function countHit(route: Route): void {
  route.hits = (route.hits ?? 0) + 1;
  route.lastHit = Date.now();
}

function loadRoutes(): void {
  try {
    for (const r of JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')) as Route[]) {
      if (pidAlive(r.pid)) routes.set(r.name, r);
    }
  } catch {
    // no routes file yet, or unreadable — start empty
  }
}

function saveRoutes(): void {
  fs.writeFileSync(ROUTES_FILE, JSON.stringify([...routes.values()], null, 2));
}

function pruneDead(): void {
  let changed = false;
  for (const [name, r] of routes) {
    if (!pidAlive(r.pid)) {
      routes.delete(name);
      changed = true;
      log(`pruned ${name} (pid ${r.pid} gone)`);
    }
  }
  if (changed) saveRoutes();
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function hostNameOf(req: http.IncomingMessage): string {
  const raw = (req.headers.host || '').toLowerCase();
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1); // [::1]:80
  return raw.split(':')[0]!;
}

// Returns the route name from the Host header, or null for the bare
// localhost control surface. `.localhost` always works; a custom domain
// (via `lhp config domain <tld>`) is accepted alongside it.
function routeName(req: http.IncomingMessage): string | null {
  const host = hostNameOf(req);
  for (const suffix of ['.localhost', `.${DOMAIN}`]) {
    if (host.endsWith(suffix)) return host.slice(0, -suffix.length);
  }
  return null;
}

// The control API must only answer to genuinely local names — a DNS-rebound
// hostname pointing at 127.0.0.1 would otherwise reach it from a browser.
// The bare configured domain (http://test) is safe: it only resolves through
// our /etc/resolver entry to loopback, and it makes a handy dashboard URL.
const CONTROL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', DOMAIN]);

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

// Pick a free name: reuse the requested one when it points at the same
// directory or a dead process, otherwise suffix -2, -3, ...
function resolveName(requested: string, dir: string): string {
  let name = requested;
  for (let i = 2; ; i++) {
    const existing = routes.get(name);
    if (!existing || existing.dir === dir || !pidAlive(existing.pid)) return name;
    name = `${requested}-${i}`;
  }
}

async function handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url!, 'http://localhost');

  // Cross-origin form posts can reach localhost without a preflight, but they
  // can't carry application/json — requiring it shuts that CSRF door.
  if (req.method === 'POST' && !(req.headers['content-type'] || '').includes('application/json')) {
    return json(res, 415, { error: 'expected content-type: application/json' });
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, pid: process.pid, port: PROXY_PORT, started });
  }
  if (req.method === 'GET' && pathname === '/api/routes') {
    return json(res, 200, {
      routes: [...routes.values()].map((r) => ({ ...r, url: proxyUrl(r.name) })),
      daemon: { pid: process.pid, port: PROXY_PORT, domain: DOMAIN, https: HTTPS_ENABLED, started },
    });
  }
  if (req.method === 'POST' && pathname === '/api/register') {
    const body = await readBody(req);
    if (typeof body.name !== 'string' || typeof body.dir !== 'string' ||
        !Number.isInteger(body.port) || (body.port as number) < 1 || (body.port as number) > 65535) {
      return json(res, 400, { error: 'invalid registration' });
    }
    const name = resolveName(body.name, body.dir);
    const route = { ...body, name, since: Date.now() } as unknown as Route;
    routes.set(name, route);
    saveRoutes();
    refreshHttps();
    log(`registered ${name} -> :${route.port} (${route.dir})`);
    return json(res, 200, { name, url: proxyUrl(name) });
  }
  if (req.method === 'POST' && pathname === '/api/unregister') {
    const { name, pid } = (await readBody(req)) as { name: string; pid?: number };
    const existing = routes.get(name);
    if (existing && (!pid || existing.pid === pid)) {
      routes.delete(name);
      saveRoutes();
      log(`unregistered ${name}`);
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/shutdown') {
    json(res, 200, { ok: true });
    log('shutdown requested');
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (req.method === 'GET' && pathname === '/') {
    return html(res, 200, dashboardHtml([...routes.values()], started));
  }
  return json(res, 404, { error: 'not found' });
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, route: Route): void {
  countHit(route);
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-proto'] = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? undefined;

  const upstream = http.request(
    { host: PROXY_HOST, port: route.port, method: req.method, path: req.url, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on('error', (err: NodeJS.ErrnoException) => {
    if (!res.headersSent) {
      html(res, 502, errorHtml(
        `“${route.name}” isn't answering`,
        `The dev server for <b>${esc(route.name)}</b> is registered on port ${route.port} but refused the connection (${esc(err.code || err.message)}). It may still be starting up.`,
        [...routes.values()],
      ));
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
  res.on('close', () => upstream.destroy());
}

async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const name = routeName(req);
  try {
    if (name === null) {
      if (!CONTROL_HOSTS.has(hostNameOf(req))) {
        return json(res, 421, { error: 'unrecognized host' });
      }
      return await handleControl(req, res);
    }
    const route = routes.get(name);
    if (!route) {
      return html(res, 404, errorHtml(
        `No worktree named “${name}”`,
        `Nothing is registered under <b>${esc(name)}</b>. Start its dev server with <code>lhp -- &lt;your dev command&gt;</code>.`,
        [...routes.values()],
      ));
    }
    proxyRequest(req, res, route);
  } catch (err) {
    log(`error handling ${req.url}: ${err instanceof Error ? err.stack : err}`);
    if (!res.headersSent) json(res, 500, { error: String(err) });
  }
}

// WebSocket (and any other Upgrade) passthrough — needed for HMR.
function upgradeHandler(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  const name = routeName(req);
  const route = name ? routes.get(name) : undefined;
  if (!route) return void socket.destroy();

  countHit(route);
  const upstream = net.connect(route.port, PROXY_HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(raw + '\r\n');
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

// Loopback only: the proxy fronts local dev servers and the control API is
// unauthenticated — neither has any business being reachable from the LAN.
// macOS permits unprivileged low-port binds only on the wildcard address, so
// we bind wide and drop non-loopback connections at the socket instead.
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function guard(server: http.Server | https.Server): void {
  server.on('connection', (socket: net.Socket) => {
    if (!LOOPBACKS.has(socket.remoteAddress ?? '')) socket.destroy();
  });
  server.on('upgrade', upgradeHandler);
}

const server = http.createServer(requestHandler);
guard(server);
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${PROXY_PORT} already in use — another daemon is likely running`);
    process.exit(0);
  }
  throw err;
});
server.listen(PROXY_PORT, () => {
  log(`lhp daemon listening on http://localhost:${PROXY_PORT} (pid ${process.pid}, domain .${DOMAIN})`);
});

// ── https ─────────────────────────────────────────────────────────────────
// One multi-SAN cert covers every registered host (TLS wildcards can't span
// labels, clients reject TLD-depth wildcards, and Bun lacks SNICallback).
// When a new host appears the leaf is re-minted and applied to the live
// listener via setSecureContext — never by restarting the listener, which
// would refuse connections until every open socket (HMR websockets included)
// drained.

function computeSans(): string[] {
  const sans = new Set(['DNS:localhost', 'IP:127.0.0.1', `DNS:${DOMAIN}`]);
  for (const r of routes.values()) {
    sans.add(`DNS:${r.name}.${DOMAIN}`);
    const parent = r.name.split('.').slice(1).join('.');
    if (parent) sans.add(`DNS:*.${parent}.${DOMAIN}`);
  }
  return [...sans];
}

let httpsServer: https.Server | null = null;

function leafContext(): { key: Buffer; cert: Buffer } {
  return { key: fs.readFileSync(LEAF_KEY), cert: fs.readFileSync(LEAF_CERT) };
}

function startHttpsServer(): void {
  const srv = https.createServer(leafContext(), requestHandler);
  guard(srv);
  srv.on('error', (err: NodeJS.ErrnoException) => {
    log(`https listener error: ${err.code || err.message}`);
    if (httpsServer === srv) httpsServer = null;
  });
  srv.listen(HTTPS_PORT, () => {
    log(`https listening on :${HTTPS_PORT}`);
  });
  httpsServer = srv;
}

function refreshHttps(): void {
  if (!HTTPS_ENABLED) return;
  try {
    const sans = computeSans();
    const minted = ensureLeaf(sans);
    if (!httpsServer) {
      startHttpsServer();
    } else if (minted) {
      // New handshakes get the new cert; established connections keep the
      // one they already validated. Zero downtime, nothing disconnected.
      httpsServer.setSecureContext(leafContext());
      log(`https cert refreshed (${sans.length} SANs)`);
    }
  } catch (err) {
    log(`https cert refresh failed: ${err instanceof Error ? err.message : err}`);
  }
}

if (HTTPS_ENABLED) {
  try {
    if (ensureCa()) {
      log(`created local CA — run \`lhp setup\` so the system trusts it`);
    }
    refreshHttps();
  } catch (err) {
    log(`https disabled — CA setup failed: ${err instanceof Error ? err.message : err}`);
  }
}

if (DOMAIN !== 'localhost') {
  startDnsServer(DNS_PORT, PROXY_HOST, ({ port }) => {
    log(`dns responder for *.${DOMAIN} on ${PROXY_HOST}:${port}`);
  });
}
