# Product

## Register

brand

## Users

Developers who run several git worktrees of the same project at once — usually mid-task, terminal and editor open, often at night. They arrive at the docs from a README link or a colleague's message, decide within seconds whether the tool is worth `bun add -g`, and leave. Their ambient environment is dark: terminals, editors, dashboards.

## Product Purpose

localhost-proxy (`lhp`) gives every git worktree a stable named URL (`http://feature-auth.my-repo.test`) behind a tiny local reverse proxy, instead of a rotating cast of `localhost:3000/3001/3002`. The docs site exists to make that value obvious in one glance and to get a developer from landing to a working setup in under two minutes. Success: the visitor recognizes their own daily annoyance in the hero, and the quick start works verbatim.

## Brand Personality

Calm, exact, terminal-native. The tool's own output IS the brand: the banner, the URLs, the dashboard are the imagery. Confidence expressed through accuracy — every terminal block on the page is something the tool really prints, never an idealized mockup. Zero marketing gloss.

## Anti-references

- Generic SaaS landing: gradient heroes, feature card grids, badge pills, testimonial rhythm.
- Hacker-terminal cliché: green-on-black phosphor, scanlines, glitch effects — terminal aesthetics worn as costume.
- Editorial magazine: display serifs, italic headlines, ruled columns.
- Docs-site template: the Docusaurus/Mintlify sidebar-search-content shell.

## Design Principles

1. **The terminal is the hero.** Real session output, faithfully reproduced, carries the page. Prose annotates it, never the reverse.
2. **Never fake output.** Every command and response shown must match what the tool actually prints. Accuracy is the brand's proof of quality.
3. **URLs are the product.** The stable URL is the payoff; it gets the accent color and the typographic emphasis, everywhere.
4. **One orchestrated moment.** The hero terminal types itself once, beautifully. Everything after it is still. Reduced motion gets the finished transcript instantly.
5. **Quiet confidence.** No superlatives, no exclamation points, no persuasion theater. State what it does; show it doing it.

## Accessibility & Inclusion

WCAG 2.1 AA. Body text ≥4.5:1 against the dark background. The page commits to a single dark theme (matching the audience's ambient environment) — contrast is tuned for it rather than relying on a light fallback. Full `prefers-reduced-motion` alternative: the typing animation is replaced by the complete transcript, visible immediately. Terminal blocks are real text (selectable, screen-reader readable), never images.
