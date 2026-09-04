# claude-hub

Tiny Electron GUI for running Claude Code sessions across projects: pinned Hub PM tab (this session), per-project Claude tabs, plain terminals, localhost browser tabs, split panes, and notification hooks.

## State (2026-08-13)

- v0.1 committed (`e5989dc`): working multi-project GUI, ~600 lines of vanilla Electron/JS.
- `_hub/` now lives INSIDE the claude-hub repo (self-contained, per Ryan's preference), not as a sibling of the projects folder. `HUB_DIR` in `main.js`/`renderer.js` points at `__dirname/_hub`. Uncommitted.
- Notification/Stop hooks for `hub-notify.sh` installed in `~/.claude/settings.json` (alongside existing orca hooks).
- Multi-root sidebar: `ROOTS` in `main.js` lists `~/Desktop/projects` and `~/Desktop/work`; each renders as a section with a `❯_` shell button on the header (replaced the fixed Terminal row).
- Hub tab resumes the latest hub session on app launch (`claude --continue || claude`); exiting the hub session and clicking Hub starts a fresh one.
- Fixed bottom row of terminals being clipped: xterm fit addon only subtracts the terminal element's own padding, so holder padding moved onto `.xterm`.
- Roots are now user config (2026-08-13): `config.json` in the repo root (gitignored, auto-created with `{ "roots": ["~/Desktop/projects", "~/Desktop/work"] }` on first launch), `~` expanded; `main.js` re-reads it on every `list-projects`, and the sidebar refreshes on window focus. No in-app settings UI — Ryan edits the file outside the app. Repo stays in `~/Desktop/projects/` — location no longer matters.
- Fixed Terminal row restored at the top of the sidebar (opens a shell in `~`); per-root `❯_` header buttons kept.
- Standalone launch (2026-08-13): `make-app.sh` generates `builds/Claude Hub.app` (gitignored), a plist+shell launcher that execs the repo's own Electron — no terminal window, no packaging. Deliberately NOT electron-builder: a packaged bundle is read-only, and the app writes into its own folder (`_hub/`, config, bookmarks). Re-run the script if the repo moves.
- Harness selection (claude vs crush) already exists as a config key: `harness` in `config.json` (default `claude`; value `crush` accepted, anything else falls back to claude — `main.js:38`). `main.js:181` re-reads it on every spawn: new sessions run the bare `harness`, resume sessions run `harness --continue || harness`. Renderer uses it for the window title (`Claude Hub`/`Crush Hub`, `renderer.js:815`) and notification copy (`harnessName()`, `renderer.js:39,199,204`). Today it's set by hand-editing `config.json` — no in-app UI (per the "no settings UI" convention, superseded by the toggle below, 2026-09-03).
- In-app harness toggle (2026-09-03, uncommitted): sidebar row at the bottom of the fixed rows (below Browser) shows the active CLI — `bot` icon + "Claude" or `zap` + "Crush", amber, `↔` affordance on hover; clicking flips it. New `set-harness` IPC in `main.js` read-modify-writes `harness` into `config.json` (preserves `groups`/`hub`, rejects values other than `claude`/`crush`). Affects new/resumed sessions only; running tabs keep their CLI (resume is per-harness: `harness --continue || harness`). Window title + notification copy follow the toggle via `harnessName()`; `refreshProjects` (on window focus) re-syncs the row from config, so hand-editing `config.json` still works. Icons from lucide-static (`bot`, `zap`). README documents it.
- Harness theming (2026-09-03, uncommitted): the accent color follows the harness. `--accent` / `--accent-grad` CSS vars on `:root`, flipped by a `data-harness` attribute on `<html>` set in `paintHarnessRow` (renderer.js). Claude: flat `#e8b04b` (gradient with identical stops = zero visual change vs before). Crush: its actual logo colors — Dolly `#ff60ff` (pink) → Charple `#6b50ff` (purple), the Dolly→Charple gradient of Crush's own logo (charmbracelet/crush default Pantera theme, via the charmtone palette in charmbracelet/x). Gradient text on the Hub row name, harness row name, and project-view header; solid accent for the active split button and the xterm cursor (read via `accent()` at tab creation, so existing tabs keep their creation-time cursor). Functional status dots (attention `#ff9f43`, done green) deliberately untouched — status, not brand.
- Sidebar shell rows retinted (2026-09-03, uncommitted): Terminal + Browser rows went blue `#7fa8d9` → `#ddd` (the app's text white) per "blue doesn't fit"; icons follow via `currentColor`. Other blues left as-is: `.brief code` spans and the browser start-page `.portbtn` localhost buttons (separate affordances, not flagged).
- Committed & pushed (2026-08-13, `eea9b14`): all modified files (`.gitignore`, `CLAUDE.md`, `README.md`, `index.html`, `main.js`, `renderer.js`) + `make-app.sh`. `_hub/` deliberately left untracked per Ryan. Git remote switched from SSH to HTTPS: the default SSH key maps to the wrong GitHub account (ryanagallagher), pushes now auth via `gh` CLI (RyanAOGallagher).

## Conventions

- App expects projects as siblings under `~/Desktop/projects`; briefs and the daily log live in this `_hub/` folder inside the repo.
- The GUI stays dumb; all conventions (briefs, daily log, PM behavior) live in `_hub/` markdown.

## Open items

- Restart the app to pick up the in-app harness toggle (and the earlier sidebar/config changes if not already picked up). Changes from 2026-09-03 are uncommitted.
- Decide whether `_hub/` should ever be committed, or added to `.gitignore` (currently just untracked).
