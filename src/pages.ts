// HTML for the dashboard and proxy error pages. Self-contained: no build
// step, no assets, no webfonts (a tool page must render instantly).
// Visual system per DESIGN.md: committed dark, neutral charcoal, amber owns
// URLs and links, mint marks healthy/success. The dashboard renders each
// repo as a terminal window (the docs site's hero component) with its
// worktrees as rows, and updates in place — no page refresh.

import { proxyUrl, PROXY_PORT, DOMAIN, HTTPS_ENABLED, type Route } from './shared';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const STYLES = `
  :root {
    --bg: oklch(0.13 0 0);
    --terminal: oklch(0.085 0 0);
    --surface: oklch(0.17 0 0);
    --ink: oklch(0.93 0.005 75);
    --muted: oklch(0.70 0.012 75);
    --faint: oklch(0.52 0.008 75);
    --line: oklch(0.27 0 0);
    --amber: oklch(0.80 0.155 75);
    --mint: oklch(0.80 0.12 170);
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 1.25rem 4rem;
    background: var(--bg); color: var(--ink);
    font: 400 15px/1.6 ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 58rem; margin: 0 auto; }
  a { color: var(--amber); text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: 3px; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; border-radius: 4px; }
  code { font-family: var(--mono); font-size: .9em; }

  header { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; padding: 1.5rem 0 1.75rem; }
  .mark { font: 500 1rem var(--mono); color: var(--ink); white-space: nowrap; }
  .mark b { color: var(--amber); font-weight: 500; }
  .meta { display: flex; gap: .45rem; flex-wrap: wrap; margin-left: auto; }
  .chip {
    font: 400 .72rem var(--mono); color: var(--muted);
    border: 1px solid var(--line); border-radius: 99px; padding: .12rem .6rem;
    white-space: nowrap;
  }
  .chip.on { color: var(--mint); border-color: color-mix(in oklch, var(--mint) 35%, var(--line)); }
  header .docs { font-size: .85rem; color: var(--faint); }

  .repo {
    background: var(--terminal); border: 1px solid var(--line); border-radius: 12px;
    overflow: hidden; margin-bottom: 1.1rem;
    box-shadow: 0 1px 0 oklch(1 0 0 / .04) inset, 0 18px 44px -20px oklch(0 0 0 / .5);
  }
  .repo-bar {
    display: flex; align-items: center; gap: .45rem;
    padding: .6rem .95rem; border-bottom: 1px solid var(--line);
  }
  .repo-bar i { width: .66rem; height: .66rem; border-radius: 50%; }
  .repo-bar i:nth-child(1) { background: oklch(0.62 0.17 25); }
  .repo-bar i:nth-child(2) { background: oklch(0.75 0.14 90); }
  .repo-bar i:nth-child(3) { background: oklch(0.68 0.14 150); }
  .repo-bar b { margin: 0 auto; transform: translateX(-1.1rem); font: 400 .76rem var(--mono); color: var(--faint); font-weight: 400; }
  .repo-bar .count { font: 400 .72rem var(--mono); color: var(--faint); }

  .row { display: flex; align-items: center; gap: .9rem; padding: .85rem 1rem; }
  .row + .row { border-top: 1px solid color-mix(in oklch, var(--line) 55%, transparent); }
  .dot { width: .55rem; height: .55rem; border-radius: 50%; flex: none; background: var(--faint); }
  .dot.ok { background: var(--mint); animation: pulse 2.4s ease-out infinite; }
  .dot.down { background: var(--amber); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--mint) 45%, transparent); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  @media (prefers-reduced-motion: reduce) { .dot.ok { animation: none; } }

  .who { min-width: 0; flex: 1; }
  .who .url { font: 500 .92rem var(--mono); overflow-wrap: anywhere; }
  .who .sub { font: 400 .76rem var(--mono); color: var(--faint); margin-top: .1rem; overflow-wrap: anywhere; }
  .who .sub .sep { opacity: .5; margin: 0 .3rem; }

  .stats { text-align: right; flex: none; font: 400 .76rem/1.7 var(--mono); color: var(--muted); }
  .stats .down-note { color: var(--amber); }
  .stats .quiet { color: var(--faint); }

  .copy {
    flex: none; font: 400 .72rem var(--mono); color: var(--faint);
    background: none; border: 1px solid var(--line); border-radius: 6px;
    padding: .22rem .55rem; cursor: pointer; transition: color .15s, border-color .15s;
  }
  .copy:hover { color: var(--ink); border-color: var(--faint); }
  .copy.done { color: var(--mint); border-color: color-mix(in oklch, var(--mint) 40%, var(--line)); }

  .empty {
    background: var(--terminal); border: 1px dashed var(--line); border-radius: 12px;
    padding: 2.2rem 1.5rem; text-align: center; color: var(--muted);
  }
  .empty code { display: inline-block; margin-top: .8rem; background: var(--surface); padding: .45rem .9rem; border-radius: 8px; color: var(--ink); font-size: .85rem; }

  @media (max-width: 620px) {
    .stats { display: none; }
    .row { padding: .75rem .85rem; }
  }

  .err h1 { font-size: 1.3rem; margin: 2.5rem 0 .4rem; letter-spacing: -.01em; }
  .err .sub { color: var(--muted); max-width: 60ch; }
  .err .back { display: inline-block; margin-top: 1.75rem; font-size: .85rem; color: var(--muted); }
`;

const shell = (title: string, body: string, script = ''): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='18' fill='%23131313'/><text x='50' y='68' font-size='52' text-anchor='middle' fill='%23eeb64b' font-family='monospace'>~$</text></svg>">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body><div class="wrap">${body}</div>${script}</body>
</html>`;

interface DaemonMeta {
  started: number;
  port: number;
  domain: string;
  https: boolean;
}

export function dashboardHtml(routes: Route[], started: number): string {
  const initial = {
    routes: routes.map((r) => ({ ...r, url: proxyUrl(r.name) })),
    daemon: { started, port: PROXY_PORT, domain: DOMAIN, https: HTTPS_ENABLED } satisfies DaemonMeta,
  };
  const body = `
  <header>
    <span class="mark"><b>~$</b> localhost-proxy</span>
    <span class="meta">
      <span class="chip">:${PROXY_PORT}</span>
      <span class="chip">.${esc(DOMAIN)}</span>
      ${HTTPS_ENABLED ? '<span class="chip on">https</span>' : ''}
      <span class="chip" id="up"></span>
    </span>
    <a class="docs" href="https://localhost-proxy.vercel.app">docs</a>
  </header>
  <main id="app" aria-live="polite"></main>`;

  // The client owns rendering: poll /api/routes every 2s, re-render every
  // second so uptimes and "active …s ago" tick. Rows are built with
  // escaping; motion is limited to the health-dot pulse (state, not
  // decoration) and it respects prefers-reduced-motion via CSS.
  const script = `<script>
(function () {
  var state = ${JSON.stringify(initial)};
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var ago = function (ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd';
  };
  var hitsFmt = function (n) { return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n); };
  var repoOf = function (r) { return r.repo || r.name.split('.').slice(1).join('.') || r.name; };

  function rowHtml(r) {
    var stateCls = r.healthy === true ? 'ok' : r.healthy === false ? 'down' : '';
    var port = Number(r.port) || 0;
    var stats = r.healthy === false
      ? '<span class="down-note">not answering on :' + port + '</span>'
      : (r.hits
          ? hitsFmt(Number(r.hits) || 0) + ' req \\u00b7 active ' + ago(Number(r.lastHit) || Date.now()) + ' ago'
          : '<span class="quiet">no requests yet</span>');
    return '<div class="row">' +
      '<span class="dot ' + stateCls + '" title="' + (r.healthy === false ? 'upstream not answering' : 'live') + '"></span>' +
      '<div class="who">' +
        '<div class="url"><a href="' + esc(r.url) + '/">' + esc(String(r.url).replace(/^https?:\\/\\//, '')) + '</a></div>' +
        '<div class="sub">' + esc(r.branch || '') + '<span class="sep">\\u00b7</span>:' + port +
          '<span class="sep">\\u00b7</span>up ' + ago(Number(r.since) || Date.now()) +
          (r.cmd ? '<span class="sep">\\u00b7</span>' + esc(r.cmd) : '') + '</div>' +
      '</div>' +
      '<div class="stats">' + stats + '</div>' +
      '<button class="copy" data-url="' + esc(r.url) + '">copy</button>' +
    '</div>';
  }

  function render() {
    document.getElementById('up').textContent = 'up ' + ago(state.daemon.started);
    var app = document.getElementById('app');
    if (!state.routes.length) {
      app.innerHTML = '<div class="empty">No dev servers registered.' +
        '<br><span style="font-size:.85rem;color:var(--faint)">Wrap a dev command in any worktree and it appears here.</span>' +
        '<br><code>"dev": "lhp -- next dev"</code></div>';
      return;
    }
    var repos = {};
    state.routes.forEach(function (r) { (repos[repoOf(r)] = repos[repoOf(r)] || []).push(r); });
    app.innerHTML = Object.keys(repos).sort().map(function (repo) {
      var members = repos[repo].sort(function (a, b) { return a.name.localeCompare(b.name); });
      return '<section class="repo">' +
        '<div class="repo-bar"><i></i><i></i><i></i><b>' + esc(repo) + '</b>' +
        '<span class="count">' + members.length + '</span></div>' +
        members.map(rowHtml).join('') +
      '</section>';
    }).join('');
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.copy');
    if (!btn) return;
    navigator.clipboard.writeText(btn.getAttribute('data-url')).then(function () {
      btn.classList.add('done'); btn.textContent = '\\u2713';
      setTimeout(function () { btn.classList.remove('done'); btn.textContent = 'copy'; }, 1200);
    });
  });

  render();
  setInterval(render, 1000);
  setInterval(function () {
    fetch('/api/routes').then(function (r) { return r.json(); }).then(function (data) {
      state = data;
    }).catch(function () { /* daemon unreachable; keep last state */ });
  }, 2000);
})();
</script>`;

  return shell('localhost-proxy', body, script);
}

export function errorHtml(title: string, message: string, routes: Route[]): string {
  const rows = routes
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => {
      const url = proxyUrl(r.name);
      return `<div class="row">
        <span class="dot ok"></span>
        <div class="who">
          <div class="url"><a href="${esc(url)}/">${esc(url.replace(/^https?:\/\//, ''))}</a></div>
          <div class="sub">${esc(r.branch || '')}<span class="sep">·</span>:${r.port}${r.cmd ? `<span class="sep">·</span>${esc(r.cmd)}` : ''}</div>
        </div>
      </div>`;
    })
    .join('');
  const body = `
  <div class="err">
    <h1>${esc(title)}</h1>
    <p class="sub">${message}</p>
    ${routes.length ? `<section class="repo" style="margin-top:1.5rem"><div class="repo-bar"><i></i><i></i><i></i><b>currently running</b><span class="count">${routes.length}</span></div>${rows}</section>` : ''}
    <a class="back" href="http://localhost${PROXY_PORT === 80 ? '' : `:${PROXY_PORT}`}/">← dashboard</a>
  </div>`;
  return shell(title, body);
}
