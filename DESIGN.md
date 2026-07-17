# Design

The visual system of the localhost-proxy docs site (`site/index.html`). Register: brand — "the living terminal." The tool's real output is the imagery; prose annotates it.

## Theme

Single committed dark theme (no light variant). The audience lives in dark terminals and editors; the page matches their ambient environment. Mood: a dark desk at 1am, one warm lamp, the prompt waiting — warm amber on neutral charcoal, the historical amber-phosphor register, never green-Matrix.

## Color (OKLCH)

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `oklch(0.13 0 0)` | Page background — pure neutral, no hue tint |
| `--terminal` | `oklch(0.085 0 0)` | Terminal/snippet background — the darkest, glowing object |
| `--surface` | `oklch(0.17 0 0)` | Inline-code chips |
| `--ink` | `oklch(0.93 0.005 75)` | Headings, primary text (warm off-white) |
| `--muted` | `oklch(0.70 0.012 75)` | Body prose, terminal output |
| `--faint` | `oklch(0.52 0.008 75)` | Prompts, annotations, footer |
| `--line` | `oklch(0.27 0 0)` | Borders, section rules |
| `--amber` | `oklch(0.80 0.155 75)` | URLs, links, cursor, emphasis — URLs are the product, amber is theirs |
| `--mint` | `oklch(0.80 0.12 170)` | Success lines (`✓ Ready`, `✓ copied`) only |

Strategy: committed dark with one owned accent. Amber never decorates — it marks URLs, links, and the single `em` in the h1. Mint appears only where the real tool prints success.

## Typography

- **Voice**: Schibsted Grotesk (400 / 500 / 700), Google Fonts. Headings 700 at `letter-spacing: -.02 to -.025em`, `text-wrap: balance`.
- **Terminal**: `ui-monospace, "SF Mono", Menlo, Consolas` — deliberately the visitor's own terminal font, no mono webfont.
- Scale: h1 `clamp(2.4rem, 6.5vw, 4.4rem)` / h2 `clamp(1.5rem, 3vw, 2.1rem)` / body 16.5px / terminal .86rem (.78rem ≤640px).

## Components

- **`.termwin`** — the hero artifact: macOS chrome (traffic lights, `zsh — <dir>` title), `--terminal` bg, 12px radius, deep soft shadow. Content is a real session transcript; classes `t-cmd/t-dim/t-out/t-url/t-ok` map to believable ANSI roles.
- **`.snippet`** — chromeless mini-terminal for quick-start steps. Long real output wraps onto a second line (terminals wrap; never clip, never paraphrase).
- **`.duo`** — 2:3 prose/terminal split, stacks ≤880px. Steps are numbered because setup genuinely is a sequence.
- **`.ref`** — man-page-style command reference: hairline-ruled rows, code left, description right.
- **`.install`** — copy-on-click command styled as a prompt line, never a filled button.

## Motion

One orchestrated moment: the hero terminal replays its session on load (commands type char-by-char with jitter, output arrives in quick batches, cursor blinks). The full transcript lives in the DOM — reduced-motion, no-JS, and crawlers get the finished session; JS only animates when motion is welcome. Everything else on the page is still.

## Rules

- Every terminal block must match what the tool actually prints. Accuracy is the brand.
- Example identity: repo `my-repo`, worktrees `auth` (branch `feature/auth`) and `main` — short names chosen so real output fits unclipped at desktop widths.
- No cards, no eyebrows, no gradients, no filled CTAs, no light theme, no green phosphor.
- Terminal blocks may scroll horizontally on small screens (authentic); page chrome must never overflow.
