// The lhp proxy daemon. One instance per machine, listening on PROXY_PORT.
//
//   http://localhost:<port>            -> dashboard + control API
//   http://<name>.<domain>[:<port>]    -> proxied to that worktree's dev server
//
// Routes are registered by the `lhp` CLI wrapping each dev command, persisted
// to disk so a daemon restart keeps them, and pruned when the registering
// process dies.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import {
  PROXY_PORT, PROXY_HOST, DOMAIN, DNS_PORT, STATE_DIR, ROUTES_FILE,
  pidAlive, proxyUrl, type Route,
} from './shared';
import { dashboardHtml, errorHtml, esc } from './pages';
import { startDnsServer } from './dns';

const started = Date.now();
const routes = new Map<string, Route>();

fs.mkdirSync(STATE_DIR, { recursive: true });
loadRoutes();
setInterval(pruneDead, 5000).unref();

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
const CONTROL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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
    return json(res, 200, { routes: [...routes.values()] });
  }
  if (req.method === 'POST' && pathname === '/api/register') {
    const body = await readBody(req);
    const name = resolveName(body.name as string, body.dir as string);
    const route = { ...body, name, since: Date.now() } as unknown as Route;
    routes.set(name, route);
    saveRoutes();
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
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-proto'] = 'http';
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

const server = http.createServer(async (req, res) => {
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
});

// WebSocket (and any other Upgrade) passthrough — needed for HMR.
server.on('upgrade', (req, socket, head) => {
  const name = routeName(req);
  const route = name ? routes.get(name) : undefined;
  if (!route) return socket.destroy();

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
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${PROXY_PORT} already in use — another daemon is likely running`);
    process.exit(0);
  }
  throw err;
});

// Loopback only: the proxy fronts local dev servers and the control API is
// unauthenticated — neither has any business being reachable from the LAN.
// macOS permits unprivileged port-80 binds only on the wildcard address, so
// we bind wide and drop non-loopback connections at the socket instead.
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
server.on('connection', (socket) => {
  if (!LOOPBACKS.has(socket.remoteAddress ?? '')) socket.destroy();
});

server.listen(PROXY_PORT, () => {
  log(`lhp daemon listening on http://localhost:${PROXY_PORT} (pid ${process.pid}, domain .${DOMAIN})`);
});

if (DOMAIN !== 'localhost') {
  startDnsServer(DNS_PORT, PROXY_HOST, ({ port }) => {
    log(`dns responder for *.${DOMAIN} on ${PROXY_HOST}:${port}`);
  });
}
