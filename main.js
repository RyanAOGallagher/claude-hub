const { app, BrowserWindow, ipcMain, Notification } = require('electron')
const { execFile } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const http = require('http')
const pty = require('node-pty')

// Folders whose subdirectories show up as projects in the sidebar,
// user-editable via config.json in the repo root (auto-created on first launch)
const CONFIG_FILE = path.join(__dirname, 'config.json')
const DEFAULT_ROOTS = ['~/Desktop/projects', '~/Desktop/work']

const expandHome = p => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

function loadRoots() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (Array.isArray(cfg.roots) && cfg.roots.length) return cfg.roots.map(expandHome)
  } catch {}
  return DEFAULT_ROOTS.map(expandHome)
}

if (!fs.existsSync(CONFIG_FILE)) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ roots: DEFAULT_ROOTS }, null, 2) + '\n') } catch {}
}
const SKIP = new Set(['_hub', 'builds', 'deprecated', 'node_modules', 'untitled folder', '__pycache__'])

const ptys = new Map()
let win
let hubPort = 43917

// Receives events from Claude Code hooks (hub-notify.sh) and forwards to the renderer
function startEventServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/event') { res.writeHead(404); return res.end() }
    let body = ''
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy() })
    req.on('end', () => {
      try {
        const { tab, event, message } = JSON.parse(body)
        if (win) win.webContents.send('claude-event', Number(tab), String(event), String(message || ''))
      } catch {}
      res.writeHead(200); res.end('ok')
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

ipcMain.handle('list-projects', () => {
  return loadRoots().filter(root => fs.existsSync(root)).map(root => ({
    root: path.basename(root),
    dir: root,
    projects: fs
      .readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name))
      .map(d => ({ name: d.name, type: detectType(path.join(root, d.name)), dir: path.join(root, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }))
})

ipcMain.handle('spawn', (e, id, cwd, cols, rows, cmd = 'claude') => {
  const shell = process.env.SHELL || '/bin/zsh'
  // login+interactive shell so PATH and aliases resolve even when launched from Finder
  const args =
    cmd === 'shell' ? ['-l']
    // resume the latest session in this cwd; falls back to a fresh one if there is none
    : cmd === 'claude-resume' ? ['-l', '-i', '-c', 'claude --continue || claude']
    : ['-l', '-i', '-c', 'claude']
  const p = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, CLAUDE_HUB_TAB: String(id), CLAUDE_HUB_PORT: String(hubPort) }
  })
  p.onData(data => win && win.webContents.send('pty-data', id, data))
  p.onExit(({ exitCode }) => win && win.webContents.send('pty-exit', id, exitCode))
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
    if (!win) return
    win.show()
    win.focus()
    win.webContents.send('activate-tab', id)
  })
  n.show()
})

app.whenReady().then(() => { startEventServer(); createWindow() })
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { for (const p of ptys.values()) { try { p.kill() } catch {} } })
