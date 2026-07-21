# Changelog

## 0.2.0 (2026-07-20)

Monorepo support: per-app routes, branch-based names, hierarchical project config.

- **Default URL shape changed** to `http://<branch>.<repo>.test` (`http://<branch>.<app>.<repo>.test` in monorepos). The scheme is now any dot-list of `branch`, `app`, `worktree`, `repo` tokens; `lhp config scheme worktree.repo` restores the old shape, and existing configs keep working
- App detection: the nearest `package.json` above where `lhp` runs (below the worktree root) names an `app` label, so every package in a monorepo gets its own route — `turbo run dev` with each app wrapping itself in `lhp --` registers the whole stack, filters run one app
- Route identity is the app directory, not the worktree root — two monorepo apps in one worktree no longer steal each other's names
- Project config is hierarchical: `"lhp"` keys in `package.json` and `.lhp.json` files merge from the worktree root down to the app, closer wins per key; new `"app"` key overrides the URL's app label
- Branch detection works in fresh repos with no commits (unborn HEAD)
- **Fixed: registering a route no longer takes HTTPS down.** The daemon used to close the 443 listener and wait for every open connection (HMR websockets included) to drain before restarting with the re-minted cert — an outage of a minute or more, and concurrent registrations could be skipped from the cert entirely. New certs now apply to the live listener via `setSecureContext`: zero downtime, nothing disconnected

## 0.1.0 (2026-07-17)

Initial release.

- Reverse-proxy daemon with per-worktree hostname routing, WebSocket/HMR passthrough, and a dashboard grouped by repo at `http://localhost/`
- `lhp -- <dev command>` wrapper: detects the worktree and repo, allocates a port, registers with the daemon (auto-started), unregisters on exit
- Default URLs `http://<worktree>.<repo>.test` — port-free (proxy on 80) and repo-scoped; built-in DNS responder plus one-time `lhp setup` for the `/etc/resolver` entry
- `lhp config` for port, domain, and naming scheme; `.dev`/`.app`/`.local` refused with explanations
- Env injection so apps build absolute URLs on the proxy origin: `PORT`, `LHP_URL`, `LHP_NAME`, Auth.js/NextAuth defaults (`AUTH_URL`, `NEXTAUTH_URL`, `AUTH_TRUST_HOST`), and per-project mappings via an `"lhp"` key in `package.json` with `{url}`/`{port}`/`{name}` templates
- Optional HTTPS (`lhp config https on`): a name-constrained local CA (trusted via `lhp setup`), one auto-maintained multi-SAN cert with per-repo wildcards, a 443 listener beside 80, and https injected URLs — enables OAuth wildcard redirect URIs like `https://*.my-repo.test/...`
- Runtime is Node (≥ 20): Bun 1.3's `node:http` drops writes to upgraded sockets (breaking WebSocket/HMR passthrough, covered by the smoke test's upgrade leg) and its `node:tls` lacks `SNICallback` — Bun remains the dev toolchain only
