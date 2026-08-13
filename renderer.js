const { ipcRenderer } = require('electron')
const { Terminal } = require('@xterm/xterm')
const { FitAddon } = require('@xterm/addon-fit')
const path = require('path')
const os = require('os')
const fs = require('fs')

const PROJECTS_DIR = path.join(os.homedir(), 'Desktop', 'projects')
const HUB_DIR = path.join(PROJECTS_DIR, '_hub')

const BOOKMARKS_FILE = path.join(__dirname, 'bookmarks.json')
const loadBookmarks = () => { try { return JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8')) } catch { return [] } }
const saveBookmarks = b => fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(b, null, 2) + '\n')

const lucide = name => {
  try {
    return fs.readFileSync(path.join(__dirname, 'node_modules/lucide-static/icons', name + '.svg'), 'utf8')
      .replace('width="24"', 'width="13"').replace('height="24"', 'height="13"')
  } catch { return '' }
}

const tabbar = document.getElementById('tabbar')
const terms = document.getElementById('terms')
const projlist = document.getElementById('projlist')
const divider = document.getElementById('divider')

const tabs = new Map() // id -> { kind, term, fit, holder, tabEl, dot, title, dead, pinned, status }
let nextId = 1
let hubId = null

// ---------- pane layout ----------
// Tabs live as absolutely-positioned holders inside #terms; panes are pure
// geometry (never reparent holders — a moved <webview> reloads its page).

let split = null // null | 'row' (side by side) | 'col' (top/bottom)
let ratio = 0.5
let paneTab = [null, null] // tabId shown in each pane (pane 1 unused when !split)
let focusedPane = 0
let mru = [] // most-recently-shown tab ids

const pct = f => (f * 100).toFixed(2) + '%'

function rectFor(pane) {
  if (!split) return { left: '0', top: '0', width: '100%', height: '100%' }
  if (split === 'row') {
    return pane === 0
      ? { left: '0', top: '0', width: pct(ratio), height: '100%' }
      : { left: pct(ratio), top: '0', width: pct(1 - ratio), height: '100%' }
  }
  return pane === 0
    ? { left: '0', top: '0', width: '100%', height: pct(ratio) }
    : { left: '0', top: pct(ratio), width: '100%', height: pct(1 - ratio) }
}

function visiblePaneOf(id) {
  const i = paneTab.indexOf(id)
  return i === 1 && !split ? -1 : i
}

function applyLayout() {
  for (const [id, t] of tabs) {
    const pane = visiblePaneOf(id)
    if (pane === -1) {
      t.holder.style.display = 'none'
      t.tabEl.classList.remove('active')
      continue
    }
    const r = rectFor(pane)
    Object.assign(t.holder.style, {
      display: t.kind === 'web' ? 'flex' : 'block',
      left: r.left, top: r.top, width: r.width, height: r.height
    })
    t.holder.classList.toggle('holder-focused', !!split && pane === focusedPane)
    t.tabEl.classList.add('active')
    if (t.kind === 'term') requestAnimationFrame(() => t.fit.fit())
  }
  if (split) {
    divider.style.display = 'block'
    divider.className = split
    if (split === 'row') { divider.style.left = pct(ratio); divider.style.top = '0' }
    else { divider.style.top = pct(ratio); divider.style.left = '0' }
  } else {
    divider.style.display = 'none'
  }
  for (const [mode, btn] of Object.entries(splitBtns)) {
    btn.classList.toggle('on', (split || 'single') === mode)
  }
}

function showInPane(pane, id) {
  const t = tabs.get(id)
  if (!t) return
  if (!split) pane = 0
  const otherPane = 1 - pane
  if (split && paneTab[otherPane] === id) {
    focusedPane = otherPane // already visible there — just focus it
  } else {
    paneTab[pane] = id
    focusedPane = pane
  }
  mru = [id, ...mru.filter(x => x !== id)]
  if (t.status === 'done') setStatus(id, null) // seen it
  applyLayout()
  if (t.kind === 'term') t.term.focus()
}

function activate(id) { showInPane(focusedPane, id) }

function setSplit(mode) {
  if (mode === 'single') {
    if (split) paneTab = [paneTab[focusedPane] ?? paneTab[0], null]
    split = null
    focusedPane = 0
  } else {
    const enabling = !split
    split = mode
    if (enabling) {
      // fill the second pane with the most recent other tab, if any
      if (paneTab[1] == null) {
        paneTab[1] = mru.find(x => tabs.has(x) && x !== paneTab[0]) ?? null
      }
    }
  }
  applyLayout()
}

// divider dragging (suspend pointer events so the webview doesn't eat the drag)
divider.addEventListener('mousedown', e => {
  e.preventDefault()
  for (const t of tabs.values()) t.holder.style.pointerEvents = 'none'
  const move = ev => {
    const r = terms.getBoundingClientRect()
    ratio = split === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height
    ratio = Math.min(0.85, Math.max(0.15, ratio))
    applyLayout()
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    for (const t of tabs.values()) t.holder.style.pointerEvents = ''
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
})

// split mode buttons in the tab bar
const splitBtns = {}
{
  const box = document.createElement('div')
  box.className = 'splitbtns'
  for (const [mode, glyph, tip] of [
    ['single', '□', 'Single pane'],
    ['row', '◫', 'Split side by side'],
    ['col', '⊟', 'Split top / bottom']
  ]) {
    const b = document.createElement('span')
    b.className = 'sbtn'
    b.textContent = glyph
    b.title = tip
    b.onclick = () => setSplit(mode)
    splitBtns[mode] = b
    box.appendChild(b)
  }
  tabbar.appendChild(box)
}

// ---------- status / notifications ----------

function updateBadge() {
  let n = 0
  for (const t of tabs.values()) if (t.status === 'attention') n++
  ipcRenderer.send('badge', n)
}

function setStatus(id, status) {
  const t = tabs.get(id)
  if (!t) return
  t.status = status
  t.dot.className = 'dot' + (status ? ' ' + status : '')
  updateBadge()
}

ipcRenderer.on('claude-event', (e, id, event, message) => {
  const t = tabs.get(id)
  if (!t || t.dead) return
  if (event === 'notification') {
    setStatus(id, 'attention')
    ipcRenderer.send('notify', id, `${t.title} needs you`, message || 'Claude is waiting for input')
  } else if (event === 'stop') {
    // finishing a turn while that tab is on screen isn't news
    if (visiblePaneOf(id) !== -1 && document.hasFocus()) { setStatus(id, null); return }
    setStatus(id, 'done')
    ipcRenderer.send('notify', id, `${t.title} finished`, message || 'Claude is done and idle')
  }
})

ipcRenderer.on('activate-tab', (e, id) => activate(id))

// ---------- tab creation ----------

function makeTabEl(id, initialLabel, { pinned = false } = {}) {
  const tabEl = document.createElement('div')
  tabEl.className = 'tab'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const label = document.createElement('span')
  label.textContent = initialLabel
  tabEl.append(dot, label)
  if (!pinned) {
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '✕'
    tabEl.append(x)
    x.onclick = e => { e.stopPropagation(); closeTab(id) }
  }
  tabEl.onclick = () => activate(id)
  tabbar.insertBefore(tabEl, tabbar.querySelector('.splitbtns'))
  return { tabEl, dot, label }
}

function openTab(title, cwd, opts = {}) {
  const id = nextId++

  const holder = document.createElement('div')
  holder.className = 'term-holder'
  holder.addEventListener('mousedown', () => {
    const p = visiblePaneOf(id)
    if (p !== -1) { focusedPane = p; applyLayout() }
  }, true)
  terms.appendChild(holder)

  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, monospace',
    theme: { background: '#111214', foreground: '#d6d6d6', cursor: '#e8b04b' },
    cursorBlink: true,
    macOptionIsMeta: true,
    scrollback: 20000
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(holder)

  const { tabEl, dot } = makeTabEl(id, title, { pinned: opts.pinned })
  tabs.set(id, { kind: 'term', term, fit, holder, tabEl, dot, title, dead: false, pinned: !!opts.pinned, status: null })

  showInPane(focusedPane, id)
  fit.fit()

  ipcRenderer.invoke('spawn', id, cwd, term.cols, term.rows, opts.shell ? 'shell' : 'claude')
  term.onData(d => {
    if (d.includes('\r')) setStatus(id, 'working')
    ipcRenderer.send('pty-input', id, d)
  })
  term.onResize(({ cols, rows }) => ipcRenderer.send('pty-resize', id, cols, rows))
  return id
}

function openBrowserTab(startUrl) {
  const id = nextId++

  const holder = document.createElement('div')
  holder.className = 'browser-holder'
  holder.addEventListener('mousedown', () => {
    const p = visiblePaneOf(id)
    if (p !== -1) { focusedPane = p; applyLayout() }
  }, true)
  terms.appendChild(holder)

  const bar = document.createElement('div')
  bar.className = 'btoolbar'
  const mkBtn = (txt, fn) => {
    const b = document.createElement('button')
    b.className = 'bbtn'
    b.textContent = txt
    b.onclick = fn
    return b
  }
  const urlInput = document.createElement('input')
  urlInput.className = 'urlbar'
  urlInput.placeholder = 'localhost:3000 or any url — Enter to go'
  urlInput.spellcheck = false

  const wv = document.createElement('webview')
  wv.setAttribute('allowpopups', 'true')
  wv.style.display = 'none'

  const startPanel = document.createElement('div')
  startPanel.className = 'startpanel'
  const portsWrap = document.createElement('div')
  portsWrap.className = 'spsec'
  const bmWrap = document.createElement('div')
  bmWrap.className = 'spsec'
  startPanel.append(portsWrap, bmWrap)

  const navigate = u => {
    startPanel.style.display = 'none'
    wv.style.display = 'flex'
    wv.src = u
    urlInput.value = u
  }

  const renderBookmarks = () => {
    bmWrap.innerHTML = ''
    const bms = loadBookmarks()
    if (!bms.length) return
    const head = document.createElement('div')
    head.className = 'sp-head'
    head.textContent = 'Bookmarks'
    bmWrap.appendChild(head)
    for (const bm of bms) {
      const b = document.createElement('button')
      b.className = 'portbtn bmbtn'
      b.textContent = bm.name
      b.title = `${bm.url}\n(right-click to remove)`
      b.onclick = () => navigate(bm.url)
      b.oncontextmenu = e => {
        e.preventDefault()
        saveBookmarks(loadBookmarks().filter(x => x.url !== bm.url))
        renderBookmarks()
      }
      bmWrap.appendChild(b)
    }
  }

  const starBtn = mkBtn('☆', () => {
    const u = wv.getURL && wv.getURL()
    if (!u || u === 'about:blank') return
    const bms = loadBookmarks()
    if (!bms.some(b => b.url === u)) {
      let name
      try { name = tabs.get(id)?.title || new URL(u).hostname } catch { name = u }
      bms.push({ name: String(name).slice(0, 30), url: u })
      saveBookmarks(bms)
    }
    starBtn.textContent = '★'
    setTimeout(() => { starBtn.textContent = '☆' }, 900)
  })
  starBtn.title = 'Bookmark current page'

  bar.append(mkBtn('‹', () => wv.goBack()), mkBtn('›', () => wv.goForward()), mkBtn('⟳', () => wv.reload()), starBtn, urlInput)
  holder.append(bar, startPanel, wv)

  if (startUrl) {
    navigate(startUrl)
  } else {
    renderBookmarks()
    ipcRenderer.invoke('list-ports').then(ports => {
      if (!tabs.has(id)) return
      const head = document.createElement('div')
      head.className = 'sp-head'
      head.textContent = ports.length ? 'Running on localhost' : 'Nothing listening on localhost'
      portsWrap.appendChild(head)
      for (const port of ports) {
        const b = document.createElement('button')
        b.className = 'portbtn'
        b.textContent = `localhost:${port}`
        b.onclick = () => navigate(`http://localhost:${port}`)
        portsWrap.appendChild(b)
      }
      if (!ports.length) {
        const hint = document.createElement('div')
        hint.className = 'sp-hint'
        hint.textContent = 'start a dev server, or type a url above'
        portsWrap.appendChild(hint)
      }
    })
  }

  const { tabEl, dot, label } = makeTabEl(id, 'Browser')
  tabs.set(id, { kind: 'web', holder, tabEl, dot, title: 'Browser', dead: false, pinned: false, status: null })

  urlInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return
    let u = urlInput.value.trim()
    if (!u) return
    if (/^\d{2,5}$/.test(u)) u = 'localhost:' + u // just a port number
    if (!/^[a-z]+:\/\//i.test(u)) {
      u = (/^(localhost|127\.|0\.0\.0\.0|192\.168\.|\[::1\])/.test(u) ? 'http://' : 'https://') + u
    }
    navigate(u)
  })
  wv.addEventListener('page-title-updated', ev => {
    const t = tabs.get(id)
    if (!t) return
    t.title = ev.title
    label.textContent = ev.title.length > 24 ? ev.title.slice(0, 24) + '…' : ev.title
  })
  wv.addEventListener('focus', () => {
    const p = visiblePaneOf(id)
    if (p !== -1 && p !== focusedPane) { focusedPane = p; applyLayout() }
  })
  const syncUrl = ev => { if (ev.url && ev.url !== 'about:blank') urlInput.value = ev.url }
  wv.addEventListener('did-navigate', syncUrl)
  wv.addEventListener('did-navigate-in-page', syncUrl)

  showInPane(focusedPane, id)
  requestAnimationFrame(() => urlInput.focus())
  return id
}

function closeTab(id, force = false) {
  const t = tabs.get(id)
  if (!t || (t.pinned && !force)) return
  if (t.kind === 'term') {
    ipcRenderer.send('pty-kill', id)
    t.term.dispose()
  }
  t.holder.remove()
  t.tabEl.remove()
  tabs.delete(id)
  mru = mru.filter(x => x !== id)
  const pane = paneTab.indexOf(id)
  if (pane !== -1) {
    paneTab[pane] = mru.find(x => tabs.has(x) && !paneTab.includes(x)) ?? null
  }
  if (split && paneTab[0] == null && paneTab[1] != null) { paneTab = [paneTab[1], null]; setSplit('single'); updateBadge(); return }
  if (paneTab[0] == null && paneTab[1] == null) { split = null; focusedPane = 0 }
  updateBadge()
  applyLayout()
}

ipcRenderer.on('pty-data', (e, id, data) => tabs.get(id)?.term?.write(data))
ipcRenderer.on('pty-exit', (e, id, code) => {
  const t = tabs.get(id)
  if (!t) return
  t.dead = true
  t.tabEl.classList.add('dead')
  setStatus(id, null)
  t.term.write(`\r\n\x1b[90m[session ended (${code})] — close the tab or open a new one\x1b[0m\r\n`)
})

window.addEventListener('resize', applyLayout)

// ---------- sidebar ----------

function openHub() {
  const t = tabs.get(hubId)
  if (t && !t.dead) return activate(hubId)
  if (t) closeTab(hubId, true) // hub session died — replace it with a fresh one
  hubId = openTab('⌂ Hub', HUB_DIR, { pinned: true })
}

function renderProjects(projects) {
  projlist.innerHTML = ''
  for (const { name } of projects) {
    const el = document.createElement('div')
    el.className = 'proj'
    el.title = name
    const lbl = document.createElement('span')
    lbl.className = 'name'
    lbl.textContent = name
    const sh = document.createElement('span')
    sh.className = 'sh'
    sh.textContent = '❯_'
    sh.title = 'Open plain terminal here'
    sh.onclick = e => { e.stopPropagation(); openTab(name + ' ❯', path.join(PROJECTS_DIR, name), { shell: true }) }
    el.append(lbl, sh)
    el.onclick = () => openTab(name, path.join(PROJECTS_DIR, name))
    projlist.appendChild(el)
  }
}

async function init() {
  const fixedrows = document.getElementById('fixedrows')

  const hubEl = document.createElement('div')
  hubEl.className = 'proj hub'
  hubEl.textContent = '⌂ Hub'
  hubEl.onclick = openHub
  fixedrows.appendChild(hubEl)

  const rootTermEl = document.createElement('div')
  rootTermEl.className = 'proj shellrow'
  rootTermEl.textContent = '❯_ Terminal'
  rootTermEl.title = 'Plain shell in ~/Desktop/projects'
  rootTermEl.onclick = () => openTab('projects ❯', PROJECTS_DIR, { shell: true })
  fixedrows.appendChild(rootTermEl)

  const browserEl = document.createElement('div')
  browserEl.className = 'proj shellrow'
  browserEl.innerHTML = `<span class="ic">${lucide('globe-2')}</span>Browser`
  browserEl.title = 'Open a browser tab'
  browserEl.onclick = () => openBrowserTab()
  fixedrows.appendChild(browserEl)

  const projects = await ipcRenderer.invoke('list-projects')
  renderProjects(projects)

  // auto-open the hub session on launch
  openHub()
}

init()
