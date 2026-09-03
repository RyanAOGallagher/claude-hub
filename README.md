# claude-hub

A tiny personal GUI for running Claude Code or Crush across many projects: one pinned **Hub** session that acts as a project manager with cross-project context, plus per-project session tabs, plain terminals, a localhost-oriented browser, and split panes.

The app is deliberately dumb (~600 lines of vanilla Electron/JS). All the intelligence lives in markdown conventions in the `_hub/` folder inside this repo.

## What it does

- **⌂ Hub tab** (pinned, always running) — a Claude session opened in `_hub/`, which holds one brief markdown file per project plus a daily log. Its `CLAUDE.md` tells it to act as a PM: answer cross-project questions, update briefs when you tell it news, dispatch work into project folders.
- **Project tabs** — click a project in the sidebar to open a Claude session in that folder. Each project's `CLAUDE.md` points at its hub brief, so sessions start pre-briefed and write back what they did.
- **Terminals** — hover any project for a `❯_` button (plain shell there), or use the Terminal row for the projects root.
- **Browser tabs** — url bar plus a start page that detects dev servers listening on localhost (ports 3000–9999) as one-click buttons, and simple bookmarks (`bookmarks.json`, ☆ to add, right-click to remove).
- **Split panes** — side-by-side or top/bottom (`◫` / `⊟` buttons), draggable divider. Browser next to the Claude session that's running the dev server.
- **Notifications** — via Claude Code hooks: per-tab status dots (working / needs-input / finished), a dock badge counting sessions waiting on you, and native macOS notifications that focus the right tab when clicked.

## Setup

Sidebar groups and the hub folder are set in `config.json` (auto-created on first launch, re-read whenever the window regains focus):

```json
{
  "harness": "crush",
  "groups": [
    { "title": "Projects", "path": "~/Desktop/projects" },
    { "title": "Work", "path": "~/Desktop/work" }
  ],
  "hub": "~/Desktop/projects/_hub"
}
```

Each group's subfolders are listed as projects under its title. Set `harness` to `"crush"` or `"claude"` (the default). `hub` is where the pinned Hub session runs (briefs + daily log live there); leave it out to default to `_hub/` inside the first group. Crush reads the existing `CLAUDE.md` project and hub instructions, so both harnesses share the same brief conventions.

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

Built for Claude Code and Crush.
