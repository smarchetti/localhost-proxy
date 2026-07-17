// End-to-end smoke test: wraps a dummy dev server with `lhp`, verifies the
// daemon routes <name>.localhost to it, then verifies cleanup on exit.
// Runs against the BUILT bundle (dist/) — `bun run test` builds first.
// Uses a dedicated proxy port so it never touches a real daemon.

import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Route } from '../src/shared';

const TEST_PORT = 7799;
const TEST_HTTPS_PORT = 7798;
const root = fileURLToPath(new URL('..', import.meta.url));
// Isolated HOME so the test never reads or writes the user's real ~/.lhp
// (config, routes, daemon log) — it must be hermetic even while a real
// daemon is serving traffic.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lhp-test-'));
// Pin every setting explicitly — assertions must not depend on shipped defaults.
const env: Record<string, string | undefined> = {
  ...process.env,
  HOME: home,
  LHP_PROXY_PORT: String(TEST_PORT),
  LHP_HTTPS: '1',
  LHP_HTTPS_PORT: String(TEST_HTTPS_PORT),
  LHP_DOMAIN: 'localhost',
  LHP_SCHEME: 'worktree',
};
delete env.PORT;

const get = async (pathname: string, host = `127.0.0.1:${TEST_PORT}`) => {
  const res = await fetch(`http://${host}${pathname}`, { signal: AbortSignal.timeout(3000) });
  return { status: res.status, text: await res.text() };
};

const until = async <T>(
  fn: () => Promise<T | null | undefined | false>,
  what: string,
  tries = 40
): Promise<T> => {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
};

let failed = false;
const step = (name: string) => console.log(`— ${name}`);

// The fixture plays the dev server. Real dev servers run under Node — and
// Bun 1.3's node:http drops writes to upgraded sockets, so running the
// fixture under Bun would break the ws leg from the upstream side.
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim() || process.execPath;

const lhp = spawn(
  process.execPath,
  [`${root}dist/lhp.js`, '--name', 'smoke', '--', nodeBin, `${root}test/fixtures/echo.ts`],
  { env, stdio: ['ignore', 'pipe', 'pipe'] }
);
lhp.stdout.on('data', () => {});
lhp.stderr.on('data', (d) => process.stderr.write(d));

try {
  step('daemon starts and route registers');
  const route = await until(async () => {
    const { text } = await get('/api/routes');
    const { routes } = JSON.parse(text) as { routes: Route[] };
    return routes.find((r) => r.name === 'smoke');
  }, 'route registration');
  assert.ok(route.port > 0);

  step('request is proxied by Host header');
  const proxied = await until(async () => {
    const r = await get('/hello?x=1', `smoke.localhost:${TEST_PORT}`);
    return r.status === 200 ? r : null;
  }, 'proxied response');
  const body = JSON.parse(proxied.text);
  assert.equal(body.echo, true);
  assert.equal(body.url, '/hello?x=1');
  assert.equal(body.port, route.port);
  assert.equal(body.host, `smoke.localhost:${TEST_PORT}`, 'Host header forwarded intact');

  step('unknown worktree gets a 404 page');
  const missing = await get('/', `nope.localhost:${TEST_PORT}`);
  assert.equal(missing.status, 404);
  assert.match(missing.text, /No worktree named/);

  step('dashboard lists the route');
  const dash = await get('/');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /smoke\.localhost/);

  step('websocket upgrade is piped through (the path Bun 1.3 breaks)');
  const wsTranscript = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(TEST_PORT, '127.0.0.1');
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('ws upgrade timed out')); }, 4000);
    let buf = '';
    let pinged = false;
    sock.on('data', (d) => {
      buf += d.toString();
      if (!pinged && buf.includes('hello-from-upstream')) { pinged = true; sock.write('ping-123'); }
      if (buf.includes('ping-123')) { clearTimeout(timer); sock.end(); resolve(buf); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.write(
      `GET /hmr HTTP/1.1\r\nHost: smoke.localhost:${TEST_PORT}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
    );
  });
  assert.match(wsTranscript, /101 Switching Protocols/, 'upgrade response reached the client');
  assert.match(wsTranscript, /ping-123/, 'bytes echoed back through the piped socket');

  step('https serves the same route with a CA-signed cert');
  // fetch can't pin a custom CA portably across runtimes; curl can.
  const curl = spawnSync('curl', [
    '-sS', '--cacert', path.join(home, '.lhp', 'ca', 'ca.pem'),
    '--resolve', `smoke.localhost:${TEST_HTTPS_PORT}:127.0.0.1`,
    `https://smoke.localhost:${TEST_HTTPS_PORT}/via-tls`,
  ], { encoding: 'utf8' });
  assert.equal(curl.status, 0, `curl failed: ${curl.stderr}`);
  const tlsBody = JSON.parse(curl.stdout);
  assert.equal(tlsBody.url, '/via-tls');
  assert.equal(tlsBody.proto, 'https', 'x-forwarded-proto should be https over TLS');

  step('route is removed when the wrapper exits');
  lhp.kill('SIGTERM');
  await until(async () => {
    const { text } = await get('/api/routes');
    const { routes } = JSON.parse(text) as { routes: Route[] };
    return routes.every((r) => r.name !== 'smoke') ? true : null;
  }, 'route cleanup');

  console.log('\nsmoke test passed ✔');
} catch (err) {
  failed = true;
  console.error(`\nsmoke test FAILED: ${err instanceof Error ? err.message : err}`);
} finally {
  lhp.kill('SIGKILL');
  await fetch(`http://127.0.0.1:${TEST_PORT}/api/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
