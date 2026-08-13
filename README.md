# claude-hub

A tiny personal GUI for running [Claude Code](https://claude.com/claude-code) across many projects: one pinned **Hub** session that acts as a project manager with cross-project context, plus per-project session tabs, plain terminals, a localhost-oriented browser, and split panes.

The app is deliberately dumb (~600 lines of vanilla Electron/JS). All the intelligence lives in markdown conventions in a `_hub/` folder next to your projects.

## What it does

- **⌂ Hub tab** (pinned, always running) — a Claude session opened in `_hub/`, which holds one brief markdown file per project plus a daily log. Its `CLAUDE.md` tells it to act as a PM: answer cross-project questions, update briefs when you tell it news, dispatch work into project folders.
- **Project tabs** — click a project in the sidebar to open a Claude session in that folder. Each project's `CLAUDE.md` points at its hub brief, so sessions start pre-briefed and write back what they did.
- **Terminals** — hover any project for a `❯_` button (plain shell there), or use the Terminal row for the projects root.
- **Browser tabs** — url bar plus a start page that detects dev servers listening on localhost (ports 3000–9999) as one-click buttons, and simple bookmarks (`bookmarks.json`, ☆ to add, right-click to remove).
- **Split panes** — side-by-side or top/bottom (`◫` / `⊟` buttons), draggable divider. Browser next to the Claude session that's running the dev server.
- **Notifications** — via Claude Code hooks: per-tab status dots (working / needs-input / finished), a dock badge counting sessions waiting on you, and native macOS notifications that focus the right tab when clicked.

## Setup

Expects your projects as sibling folders under `~/Desktop/projects` (edit `PROJECTS_DIR` in `main.js`/`renderer.js` to change), with a `_hub/` folder alongside them for briefs.

```sh
npm install
npx electron-rebuild -f -w node-pty
npm start
```

For notifications, add these hooks to `~/.claude/settings.json` (adjust the path):

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "/path/to/claude-hub/hub-notify.sh notification", "timeout": 5, "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "/path/to/claude-hub/hub-notify.sh stop", "timeout": 5, "async": true }] }
    ]
  }
}
```

The relay script is a no-op for Claude sessions not spawned by the app, so it's safe globally.

## Design rules

- The GUI stays dumb; conventions (briefs, daily log, PM behavior) live in `_hub/` markdown.
- Vanilla JS on purpose — xterm and webview are imperative DOM instances; a `<webview>` reloads its page if reparented, so panes are pure geometry over absolutely-positioned holders.
- No emoji in the UI; icons are [Lucide](https://lucide.dev) SVGs.

Built with Claude Code, for Claude Code.
