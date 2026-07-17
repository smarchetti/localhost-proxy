# Changelog

## 0.1.0 (2026-07-17)

Initial release.

- Reverse-proxy daemon with per-worktree hostname routing, WebSocket/HMR passthrough, and a dashboard grouped by repo at `http://localhost/`
- `lhp -- <dev command>` wrapper: detects the worktree and repo, allocates a port, registers with the daemon (auto-started), unregisters on exit
- Default URLs `http://<worktree>.<repo>.test` — port-free (proxy on 80) and repo-scoped; built-in DNS responder plus one-time `lhp setup` for the `/etc/resolver` entry
- `lhp config` for port, domain, and naming scheme; `.dev`/`.app`/`.local` refused with explanations
- Env injection so apps build absolute URLs on the proxy origin: `PORT`, `LHP_URL`, `LHP_NAME`, Auth.js/NextAuth defaults (`AUTH_URL`, `NEXTAUTH_URL`, `AUTH_TRUST_HOST`), and per-project mappings via an `"lhp"` key in `package.json` with `{url}`/`{port}`/`{name}` templates
