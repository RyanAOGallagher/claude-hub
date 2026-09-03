const { app, BrowserWindow, ipcMain, Notification } = require('electron')
const { execFile } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const http = require('http')
const pty = require('node-pty')

// Sidebar groups, user-editable via config.json in the repo root (auto-created on first launch):
//   { "groups": [{ "title": "Projects", "path": "~/Desktop/projects" }, ...], "hub": "~/Desktop/projects/_hub" }
// Each group's subfolders are listed as projects under its title. `hub` (optional) is the folder
// the pinned Hub session opens in; defaults to `_hub/` inside the first group.
// Legacy shape `{ "roots": ["~/Desktop/projects"] }` still works (title = folder name).
const CONFIG_FILE = path.join(__dirname, 'config.json')
const DEFAULT_CONFIG = {
  harness: 'claude',
  groups: [
    { title: 'Projects', path: '~/Desktop/projects' },
    { title: 'Work', path: '~/Desktop/work' }
  ]
}

const expandHome = p => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

function loadConfig() {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch {}
  let groups = []
  if (Array.isArray(cfg.groups)) {
    groups = cfg.groups
      .filter(g => g && typeof g.path === 'string' && g.path.trim())
      .map(g => ({ title: g.title || path.basename(g.path), dir: expandHome(g.path) }))
  } else if (Array.isArray(cfg.roots)) {
    groups = cfg.roots.filter(r => typeof r === 'string').map(r => ({ title: path.basename(r), dir: expandHome(r) }))
  }
  if (!groups.length) groups = DEFAULT_CONFIG.groups.map(g => ({ title: g.title, dir: expandHome(g.path) }))
  const hub = typeof cfg.hub === 'string' && cfg.hub.trim() ? expandHome(cfg.hub) : path.join(groups[0].dir, '_hub')
  const harness = cfg.harness === 'crush' ? 'crush' : 'claude'
  return { groups, hub, harness }
}
const loadRoots = () => loadConfig().groups.map(g => g.dir)

if (!fs.existsSync(CONFIG_FILE)) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n') } catch {}
}
const SKIP = new Set(['_hub', 'builds', 'deprecated', 'node_modules', 'untitled folder', '__pycache__'])

const ptys = new Map()
let win
let hubPort = 43917

// ptys keep emitting while the window tears down on quit — sending to a
// destroyed window throws, so every renderer send goes through this guard
const sendToWin = (...args) => { if (win && !win.isDestroyed()) win.webContents.send(...args) }

// Case-insensitive lookup of a project folder by name across all configured roots
function findProject(name) {
  const want = name.toLowerCase()
  for (const root of loadRoots()) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.') || SKIP.has(d.name)) continue
      if (d.name.toLowerCase() === want) return { name: d.name, dir: path.join(root, d.name) }
    }
  }
  return null
}

// Receives events from Claude Code hooks (hub-notify.sh) and open requests
// from hub sessions (hub-open.sh); forwards both to the renderer
function startEventServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); return res.end() }
    let body = ''
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy() })
    req.on('end', () => {
      if (req.url === '/event') {
        try {
          const { tab, event, message } = JSON.parse(body)
          sendToWin('claude-event', Number(tab), String(event), String(message || ''))
        } catch {}
        res.writeHead(200); return res.end('ok')
      }
      if (req.url === '/open') {
        try {
          const { project, resume } = JSON.parse(body)
          const match = findProject(String(project || ''))
          if (!match) { res.writeHead(404); return res.end(`no project named "${project}"`) }
          sendToWin('open-project', match.name, match.dir, !!resume)
          res.writeHead(200); return res.end(`opening ${match.name}`)
        } catch {
          res.writeHead(400); return res.end('bad request')
        }
      }
      res.writeHead(404); res.end()
    })
  })
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') { hubPort++; server.listen(hubPort, '127.0.0.1') }
  })
  server.listen(hubPort, '127.0.0.1')
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 700,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111214',
    webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true }
  })
  win.loadFile('index.html')
  win.on('closed', () => { win = null })
}

function detectType(dir) {
  const has = f => fs.existsSync(path.join(dir, f))
  if (has('project.godot')) return 'godot'
  if (has('ProjectSettings') && has('Assets')) return 'unity'
  if (has('pubspec.yaml')) return 'flutter'
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      if (deps.expo || deps['react-native']) return 'expo'
      if (deps.next) return 'next'
      if (deps.electron) return 'electron'
      if (deps.react) return 'react'
      return 'node'
    } catch { return 'node' }
  }
  if (has('main.lua')) return 'love'
  if (has('pyproject.toml') || has('requirements.txt')) return 'python'
  try {
    const files = fs.readdirSync(dir)
    if (files.some(f => f.endsWith('.py'))) return 'python'
    if (files.some(f => f.endsWith('.tex'))) return 'latex'
    if (files.some(f => f.endsWith('.html'))) return 'web'
  } catch {}
  return 'other'
}

// Newest mtime among the folder and its immediate children — folder mtime alone
// only moves when a direct child is added/removed, but children (incl. .git,
// which moves on every commit) catch normal work
function lastTouched(dir) {
  let t = 0
  try { t = fs.statSync(dir).mtimeMs } catch {}
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules' || (d.name.startsWith('.') && d.name !== '.git')) continue
      try { t = Math.max(t, fs.statSync(path.join(dir, d.name)).mtimeMs) } catch {}
    }
  } catch {}
  return t
}

ipcMain.handle('list-projects', () => {
  return loadConfig().groups.filter(g => fs.existsSync(g.dir)).map(({ title, dir: root }) => ({
    root: title,
    dir: root,
    projects: fs
      .readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name))
      .map(d => ({
        name: d.name,
        type: detectType(path.join(root, d.name)),
        dir: path.join(root, d.name),
        mtime: lastTouched(path.join(root, d.name))
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }))
})

ipcMain.handle('app-config', () => loadConfig())

ipcMain.handle('spawn', (e, id, cwd, cols, rows, mode = 'agent') => {
  const shell = process.env.SHELL || '/bin/zsh'
  const harness = loadConfig().harness
  const command = mode === 'resume'
    ? harness === 'crush' ? 'crush --continue || crush' : 'claude --continue || claude'
    : harness
  // login+interactive shell so PATH and aliases resolve even when launched from Finder
  const args = mode === 'shell' ? ['-l'] : ['-l', '-i', '-c', command]
  const p = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      CLAUDE_HUB_TAB: String(id),
      CLAUDE_HUB_PORT: String(hubPort),
      CRUSH_HUB_TAB: String(id),
      CRUSH_HUB_PORT: String(hubPort)
    }
  })
  p.onData(data => sendToWin('pty-data', id, data))
  p.onExit(({ exitCode }) => sendToWin('pty-exit', id, exitCode))
  ptys.set(id, p)
})

ipcMain.on('pty-input', (e, id, data) => ptys.get(id)?.write(data))
ipcMain.on('pty-resize', (e, id, cols, rows) => {
  try { ptys.get(id)?.resize(cols, rows) } catch {}
})
ipcMain.on('pty-kill', (e, id) => {
  try { ptys.get(id)?.kill() } catch {}
  ptys.delete(id)
})

// Detect dev servers listening on localhost (typical dev port range)
ipcMain.handle('list-ports', () => new Promise(resolve => {
  execFile('/bin/sh', ['-c', "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '{print $9}' | grep -oE '[0-9]+$' | sort -un"], (err, out) => {
    if (err || !out) return resolve([])
    const ports = [...new Set(out.trim().split('\n').map(Number).filter(p => p >= 3000 && p <= 9999))]
    resolve(ports)
  })
}))

ipcMain.on('badge', (e, n) => {
  if (process.platform === 'darwin') app.dock.setBadge(n > 0 ? String(n) : '')
})

ipcMain.on('notify', (e, id, title, body) => {
  if (win && win.isFocused()) return // user is already looking at the app
  const n = new Notification({ title, body: body || '' })
  n.on('click', () => {
    if (!win || win.isDestroyed()) return
    win.show()
    win.focus()
    win.webContents.send('activate-tab', id)
  })
  n.show()
})

app.whenReady().then(() => { startEventServer(); createWindow() })
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { for (const p of ptys.values()) { try { p.kill() } catch {} } })
