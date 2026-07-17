// HTML for the dashboard and proxy error pages. No build step, no assets.

import { proxyUrl, PROXY_PORT, type Route } from './shared';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const shell = (title: string, body: string, { refresh = false } = {}): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="3">' : ''}
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 15px/1.5 ui-sans-serif, system-ui, sans-serif;
    max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem;
    background: light-dark(#fafafa, #111);
    color: light-dark(#1a1a1a, #e8e8e8);
  }
  h1 { font-size: 1.15rem; display: flex; align-items: baseline; gap: .6rem; }
  h1 .tag { font-size: .75rem; font-weight: 500; opacity: .5; }
  p.sub { opacity: .65; margin-top: -.4rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
  th { text-align: left; font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; opacity: .5; padding: 0 .75rem .4rem 0; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; opacity: .6; margin: 2rem 0 .25rem; }
  h2 .count { font-weight: 400; opacity: .7; }
  td { padding: .55rem .75rem .55rem 0; border-top: 1px solid light-dark(#e5e5e5, #2a2a2a); vertical-align: top; }
  a { color: light-dark(#0969da, #58a6ff); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, .mono { font: .85em ui-monospace, monospace; }
  .dim { opacity: .55; font-size: .85rem; }
  .dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%; background: #2da44e; margin-right: .5rem; }
  .empty { margin-top: 2rem; padding: 2rem; text-align: center; border: 1px dashed light-dark(#d0d0d0, #3a3a3a); border-radius: 8px; opacity: .7; }
</style>
</head>
<body>${body}</body>
</html>`;

const ago = (ts: number): string => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

const routeRows = (routes: Route[]): string =>
  routes
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (r) => `<tr>
        <td><span class="dot"></span><a href="${proxyUrl(esc(r.name))}/">${esc(proxyUrl(r.name).replace('http://', ''))}</a>
          ${r.branch ? `<div class="dim mono">${esc(r.branch)}</div>` : ''}</td>
        <td class="mono">:${esc(r.port)}</td>
        <td class="dim">${ago(r.since)}</td>
        <td class="dim mono" title="${esc(r.dir)}">${esc(r.cmd || '')}</td>
      </tr>`
    )
    .join('');

// Grouping key: the registered repo, falling back to the subdomain labels
// after the worktree for routes registered by older clients.
const repoOf = (r: Route): string => r.repo || r.name.split('.').slice(1).join('.') || r.name;

const routesTable = (routes: Route[]): string => `<table>
  <tr><th>Worktree</th><th>Port</th><th>Up</th><th>Command</th></tr>
  ${routeRows(routes)}
</table>`;

export function dashboardHtml(routes: Route[], started: number): string {
  const repos = [...new Set(routes.map(repoOf))].sort();
  const grouped = repos
    .map((repo) => {
      const members = routes.filter((r) => repoOf(r) === repo);
      return `<h2>${esc(repo)} <span class="count">· ${members.length}</span></h2>${routesTable(members)}`;
    })
    .join('');
  const body = `
  <h1>localhost-proxy <span class="tag">daemon up ${ago(started)} · port ${PROXY_PORT}</span></h1>
  <p class="sub">Each git worktree's dev server, one stable URL each.</p>
  ${
    routes.length
      ? grouped
      : `<div class="empty">No dev servers registered.<br>Run <code>lhp -- &lt;your dev command&gt;</code> inside a worktree.</div>`
  }`;
  return shell('localhost-proxy', body, { refresh: true });
}

export function errorHtml(title: string, message: string, routes: Route[]): string {
  const body = `
  <h1>${esc(title)}</h1>
  <p class="sub">${message}</p>
  ${routes.length ? routesTable(routes) : ''}
  <p class="dim" style="margin-top:2rem"><a href="http://localhost:${PROXY_PORT}/">← dashboard</a></p>`;
  return shell(title, body, { refresh: true });
}
