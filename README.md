# localhost-proxy

**Docs: [localhost-proxy.vercel.app](https://localhost-proxy.vercel.app)**

Stable per-worktree dev URLs. Stop juggling `localhost:3000` vs `:3001` vs `:3002` across git worktrees — each worktree gets a named URL that never changes:

```
http://main.my-repo.test
http://feature-auth.my-repo.test
http://main.web.my-monorepo.test
```

By default URLs are `http://<branch>.<repo>.test` — and in a monorepo, `http://<branch>.<app>.<repo>.test` per package — no port (the proxy listens on 80, which needs no root on modern macOS) and grouped by repo. The `.test` domain needs a one-time `lhp setup` (sudo); if you'd rather have zero setup, `lhp config domain localhost` gives `*.localhost` URLs that resolve natively in every browser.

## How it works

`lhp` wraps your dev command. It detects the branch, repo, and (in monorepos) the app package, allocates a free port, exports it as `PORT`, registers `name → port` with a tiny reverse-proxy daemon (auto-started on first use), and runs your command. When the command exits, the route is removed.

The daemon listens on `localhost:7777`, routes by hostname, passes WebSockets through (HMR works), and serves a dashboard of everything running at [http://localhost:7777](http://localhost:7777).

## Install

```sh
bun add -d @smarchetti/localhost-proxy    # per project, or:
bun add -g @smarchetti/localhost-proxy    # global `lhp` on PATH
```

Or run it without installing:

```sh
bunx @smarchetti/localhost-proxy -- next dev
```

(Works identically with npm/npx — the runtime is plain Node ≥ 20; Bun is only the dev toolchain.)

Then the one-time resolver step for the default `.test` domain:

```sh
lhp setup       # sudo: writes /etc/resolver/test pointing at lhp's DNS responder
```

From a checkout: `bun link` makes `lhp` available globally.

## Use

In each worktree's `package.json`:

```jsonc
{
  "scripts": {
    "dev": "lhp -- next dev"          // Next.js, CRA, Remix, Astro… (they read PORT)
  }
}
```

For servers that ignore the `PORT` env var, use the `{port}` placeholder:

```jsonc
{
  "scripts": {
    "dev": "lhp -- vite --port {port}",
    "dev:nuxt": "lhp -- nuxt dev --port {port}"
  }
}
```

Then `npm run dev` in any worktree prints its stable URL:

```
  ┌ localhost-proxy
  │ worktree   feature-auth.my-repo  (feature/auth)
  │ proxied    http://feature-auth.my-repo.localhost:7777
  │ upstream   http://localhost:52341
  └ running    next dev
```

### Commands

| Command | What it does |
| --- | --- |
| `lhp -- <cmd…>` | Wrap a dev command (register, run, unregister on exit) |
| `lhp list` | List registered worktrees and their URLs |
| `lhp status` | Daemon status |
| `lhp stop` | Stop the proxy daemon |
| `lhp config` | Show configuration (`~/.lhp/config.json`) |
| `lhp config port <n>` | Set the proxy's listen port |
| `lhp config domain <tld>` | Use a custom domain instead of `.localhost` |
| `lhp config scheme <tokens>` | URL labels: a dot-list of `branch`, `app`, `worktree`, `repo` |
| `lhp setup` | One-time sudo step a custom domain needs |

### Options

- `--name <name>` — override the auto-detected worktree name
- `--port <port>` — pin the upstream port instead of auto-allocating (also respects an existing `PORT` env var)
- Env overrides (beat the config file): `LHP_PROXY_PORT`, `LHP_DOMAIN`, `LHP_DNS_PORT`

## Configuration

Defaults: `port 80`, `domain test`, `scheme branch.app.repo` — i.e. `http://<branch>.<repo>.test`, with an `<app>` label added in monorepos. Overrides live in `~/.lhp/config.json`, managed by `lhp config`. After changing them, run `lhp stop` — the daemon restarts with the new settings on your next dev run.

### Proxy port

```sh
lhp config port 7777     # http://feature-auth.my-repo.test:7777
```

The default (80) gives port-free URLs; macOS (10.14+) allows unprivileged binding of port 80, so this needs no sudo.

### Domain

```sh
lhp config domain localhost   # zero-setup: *.localhost resolves natively
lhp config domain orca        # anything made up works after `lhp setup`
```

Only `.localhost` resolves to loopback natively. For any other domain (including the default `.test`) the daemon runs a tiny DNS responder (loopback-only, UDP port `5354`) that answers `*.<domain> → 127.0.0.1`, and `lhp setup` writes `/etc/resolver/<domain>` telling macOS to send lookups for that TLD there. That resolver file is the single sudo-requiring step; delete it to undo. `.localhost` URLs always work as a fallback alongside a custom domain.

Domains that can't work are refused: `.dev` and `.app` (real TLDs, HSTS-preloaded — browsers force `https://`), and `.local` (taken by Bonjour). `.test` is IETF-reserved and safe, as is anything made up.

### HTTPS

```sh
lhp config https on
lhp setup            # sudo: adds the local CA to the system trust store
```

Worktree URLs become `https://feature-auth.my-repo.test` (port 443, no suffix; http on port 80 keeps working alongside). Public CAs can't issue for `.test`, so the daemon runs its own CA (`~/.lhp/ca`) — **name-constrained to your configured domain and `.localhost`**, so even if the key leaked it cannot sign for real websites (verifiably: such a cert fails validation with a permitted-subtree violation). The daemon maintains one multi-SAN certificate covering every registered host plus a `*.<repo>.<domain>` wildcard per repo, re-minting automatically as routes appear. `X-Forwarded-Proto: https` is set and injected URLs (`LHP_URL`, `AUTH_URL`, …) switch to https.

Why you'd want it: OAuth wildcard redirect URIs (e.g. Okta only wildcard-matches `https://` URIs, so `https://*.my-repo.test/api/auth/callback/okta` covers every worktree), `Secure` cookies, and calling https APIs without mixed-content errors. Firefox users: enable `security.enterprise_roots.enabled` so Firefox honors the system trust store.

### Naming scheme

The scheme is a dot-list of label tokens composed left-to-right into the hostname. The default `branch.app.repo` gives `feature-auth.my-repo.test` — and `feature-auth.web.my-repo.test` for the `web` package of a monorepo. Tokens that resolve to nothing are skipped: `app` outside monorepos, `branch` outside git (the sanitized short SHA stands in on a detached HEAD).

- `branch` — the checked-out branch, sanitized to DNS labels (`feature/auth` → `feature-auth`)
- `app` — monorepos only: the nearest `package.json` walking up from where `lhp` runs (scope stripped: `@acme/web` → `web`); a `package.json` at the worktree root doesn't count, so single-package repos keep their shorter names
- `worktree` — the worktree directory's basename
- `repo` — the main repository's directory name (all worktrees share it via the common `.git` dir), falling back to the `origin` remote

Repo scoping means worktrees of different repos never collide (`feature-auth.my-repo.test` vs `feature-auth.other-repo.test`), and the dashboard groups by repo. Adjacent duplicate labels collapse — under `worktree.repo`, a repo checked out at `~/dev/my-repo` is just `my-repo.test`, not `my-repo.my-repo.test`.

```sh
lhp config scheme worktree.repo   # the pre-0.2 default: http://feature-auth.my-repo.test
lhp config scheme worktree        # flat: http://feature-auth.test
```

The wrapped command also receives `LHP_URL` and `LHP_NAME` in its environment, in case the app wants to print or use its public dev URL.

### Monorepos

Each app wraps its own dev script, and your task runner (turbo, nx, pnpm `-r`) stays the orchestrator — run the whole stack or one app with the filters you already use:

```jsonc
// apps/web/package.json — falls back cleanly where lhp isn't installed
{ "scripts": { "dev": "if command -v lhp >/dev/null 2>&1; then exec lhp -- next dev; else exec next dev --port 3000; fi" } }
```

```sh
turbo run dev                        # whole stack: main.web.my-repo.test, main.api.my-repo.test, …
turbo run dev --filter=@acme/web     # just one app
```

Every app gets its own route (the app label keeps them from colliding), each on an auto-allocated port — so drop hardcoded `--port` flags from the lhp branch of the script. Because the names are stable, apps can reference each other by URL (`http://main.api.my-repo.test`) instead of `localhost:<port>`.

## Telling the app its public URL

Apps that build absolute URLs (auth flows, OAuth callbacks, share links) must build them on the proxy origin, not the upstream port — otherwise cookies and CSRF break the moment a form posts to `localhost:<port>`. Forwarded headers aren't enough in dev (the Next dev server rewrites them), so lhp injects the URL as environment variables:

- **Always**: `PORT`, `LHP_URL`, `LHP_NAME`.
- **Built-in defaults** (only when not already set in your shell): `AUTH_URL`, `NEXTAUTH_URL`, and `AUTH_TRUST_HOST=true` for Auth.js/NextAuth — the most common case, harmless for apps that don't use them.
- **Project config** for everything else: an `"lhp"` key in a `package.json`, or a `.lhp.json` next to it, declaring the env vars *your* framework reads, with `{url}`, `{port}`, `{name}` placeholders:

```jsonc
// package.json
{
  "lhp": {
    "app": "web",             // optional: override the app label in the URL
    "env": {
      "VITE_PUBLIC_URL": "{url}",
      "APP_HOST": "{url}",
      "AUTH_URL": null        // opt out of a built-in default
    }
  }
}
```

Project config is hierarchical: every `package.json` `"lhp"` key and `.lhp.json` from the worktree root down to the directory `lhp` runs in is merged, closer-to-the-app winning per key (within one directory, `.lhp.json` beats `package.json`). In a monorepo, put stack-wide env in a `.lhp.json` at the worktree root and per-app overrides in each app's `package.json`.

Precedence: shell env > project config > built-in defaults — an explicitly exported variable is never overridden. Shell env also beats `.env` files in Next, so injected values win over a stale `NEXTAUTH_URL=http://localhost:3000` in `.env.local`. The `{url}`/`{name}` placeholders also work in the wrapped command itself, alongside `{port}`.

For OAuth providers (Okta, Google, …) the provider's app config must whitelist each worktree's callback URL, e.g. `http://feature-auth.my-repo.test/api/auth/callback/okta` — or turn on [HTTPS](#https) and register one wildcard (`https://*.my-repo.test/api/auth/callback/okta`) where the provider supports it (Okta wildcard-matches https URIs only).

## Details worth knowing

- **Name collisions** (two repos with a worktree dir named `main`): the second registration gets `main-2`; the printed banner and `lhp list` always show the real URL.
- **Crashed processes**: the daemon prunes routes whose registering process is gone, so stale entries clean themselves up.
- **Daemon restarts**: routes are persisted to `~/.lhp/routes.json` and reloaded (still pruned by liveness). Daemon logs go to `~/.lhp/daemon.log`.
- **Zero runtime dependencies**: TypeScript source bundled with `bun build --target=node` into two self-contained files (`dist/lhp.js` CLI + `dist/daemon.js`). Runs on Node ≥ 20; Bun is the dev toolchain (build, install, CI), not the runtime — Bun 1.3's `node:http`/`node:tls` gaps (dropped upgrade-socket writes, missing `SNICallback`) rule it out for a proxy.

## Develop

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run test        # builds dist/, then runs the end-to-end smoke test against it
```

The smoke test exercises the real thing: daemon boot, registration, a proxied `*.localhost` request, the 404 page, the dashboard, and cleanup on exit. Hermetic — throwaway `$HOME` and a dedicated port, so it never touches a live daemon. Releases: bump `version` in `package.json`, add a `CHANGELOG.md` entry, tag `v<version>`, push — CI publishes to npm (trusted publishing with provenance) and creates the GitHub release.
