// End-to-end smoke test: wraps a dummy dev server with `lhp`, verifies the
// daemon routes <name>.localhost to it, then verifies cleanup on exit.
// Runs against the BUILT bundle (dist/) — `bun run test` builds first.
// Uses a dedicated proxy port so it never touches a real daemon.

import { spawn } from 'node:child_process';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Route } from '../src/shared';

const TEST_PORT = 7799;
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

const lhp = spawn(
  process.execPath,
  [`${root}dist/lhp.js`, '--name', 'smoke', '--', process.execPath, `${root}test/fixtures/echo.ts`],
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
  await fetch(`http://127.0.0.1:${TEST_PORT}/api/shutdown`, { method: 'POST' }).catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
