const { ipcRenderer, shell: electronShell } = require('electron')
const { Terminal } = require('@xterm/xterm')
const { FitAddon } = require('@xterm/addon-fit')
const os = require('os')
const path = require('path')
const fs = require('fs')

// hub folder: config.json `hub`, else `_hub/` inside the first group (falls back to next to the repo).
// Read synchronously here so HUB_DIR is a plain constant; main.js owns the parsing (see loadConfig there).
const HUB_DIR = (() => {
  const expandHome = p => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
    if (typeof cfg.hub === 'string' && cfg.hub.trim()) return expandHome(cfg.hub)
    const first = Array.isArray(cfg.groups) ? cfg.groups.find(g => g && g.path)?.path
                : Array.isArray(cfg.roots) ? cfg.roots[0] : null
    if (first) return path.join(expandHome(first), '_hub')
  } catch {}
  return path.join(__dirname, '..', '_hub')
})()

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
let harness = 'claude'
const harnessName = () => harness === 'crush' ? 'Crush' : 'Claude'

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
  syncSidebar()
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
    ipcRenderer.send('notify', id, `${t.title} needs you`, message || `${harnessName()} is waiting for input`)
  } else if (event === 'stop') {
    // finishing a turn while that tab is on screen isn't news
    if (visiblePaneOf(id) !== -1 && document.hasFocus()) { setStatus(id, null); return }
    setStatus(id, 'done')
    ipcRenderer.send('notify', id, `${t.title} finished`, message || `${harnessName()} is done and idle`)
  }
})

ipcRenderer.on('activate-tab', (e, id) => activate(id))

// Open request from a hub session (hub-open.sh → main /open endpoint).
// Reuses a live tab for the same project instead of stacking duplicates.
ipcRenderer.on('open-project', (e, name, dir, resume) => {
  for (const [id, t] of tabs) {
    if (t.kind === 'term' && !t.dead && t.title === name) return activate(id)
  }
  openTab(name, dir, { resume, group: name })
})

// ---------- tab bar order & groups ----------
// Tab bar children are draggable "units": the pinned hub tab (always first,
// never draggable), standalone tabs, and .tabgroup containers — one per
// project, holding that project's claude tab plus any terminals opened for it.
// Tabs inside a group are glued together: the whole group drags as one unit.

let dragUnit = null

function makeDraggable(el) {
  el.draggable = true
  el.addEventListener('dragstart', e => {
    dragUnit = el
    el.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', ' ')
  })
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragUnit = null })
}

// Reorder live while dragging: place the dragged unit before the first unit
// whose midpoint is right of the cursor. Hub (pintab) and the split buttons
// are excluded, so nothing can ever land left of the hub.
tabbar.addEventListener('dragover', e => {
  if (!dragUnit) return
  e.preventDefault()
  const units = [...tabbar.children].filter(el =>
    el !== dragUnit && !el.classList.contains('pintab') && !el.classList.contains('splitbtns'))
  const next = units.find(u => {
    const r = u.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2
  })
  tabbar.insertBefore(dragUnit, next ?? tabbar.querySelector('.splitbtns'))
})
tabbar.addEventListener('drop', e => e.preventDefault())

function groupContainerFor(name) {
  for (const g of tabbar.querySelectorAll('.tabgroup')) {
    if (g.dataset.group === name) return g
  }
  const g = document.createElement('div')
  g.className = 'tabgroup'
  g.dataset.group = name
  makeDraggable(g)
  tabbar.insertBefore(g, tabbar.querySelector('.splitbtns'))
  return g
}

// ---------- tab creation ----------

function makeTabEl(id, initialLabel, { pinned = false, group = null } = {}) {
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
  if (pinned) {
    tabEl.classList.add('pintab')
    tabbar.insertBefore(tabEl, tabbar.firstChild) // hub: anchored first, not draggable
  } else if (group) {
    groupContainerFor(group).appendChild(tabEl)
  } else {
    makeDraggable(tabEl)
    tabbar.insertBefore(tabEl, tabbar.querySelector('.splitbtns'))
  }
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
  // Shift+Enter → newline in Claude Code: terminals send plain \r for both
  // Enter and Shift+Enter, so send ESC+\r instead (same mapping Claude Code's
  // /terminal-setup installs in iTerm/VS Code). Bypasses onData on purpose —
  // a newline isn't a submit, so it shouldn't flip the status dot to "working".
  // must swallow keypress too, not just keydown — xterm otherwise still emits
  // its own \r for the keypress event and submits right after our newline
  term.attachCustomKeyEventHandler(ev => {
    if (ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (ev.type === 'keydown') ipcRenderer.send('pty-input', id, '\x1b\r')
      return false
    }
    return true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(holder)

  // inside a project group the project name is already on the claude tab, so
  // extra terminals just show the shell glyph (full name stays in the tooltip)
  const shortLabel = opts.group && opts.shell ? '❯_' : title
  const { tabEl, dot } = makeTabEl(id, shortLabel, { pinned: opts.pinned, group: opts.group })
  if (shortLabel !== title) tabEl.title = title
  tabs.set(id, { kind: 'term', term, fit, holder, tabEl, dot, title, dead: false, pinned: !!opts.pinned, status: null,
    cwd, project: opts.group || null, shell: !!opts.shell })

  showInPane(focusedPane, id)
  fit.fit()

  ipcRenderer.invoke('spawn', id, cwd, term.cols, term.rows, opts.shell ? 'shell' : opts.resume ? 'resume' : 'agent')
  term.onData(d => {
    // Enter submits a prompt; any keypress while "attention" answers the prompt
    // (permission dialogs take a single key, no Enter) — either way Claude is working again.
    // Plain shell tabs get no status: nothing ever clears it (no Stop hook without claude).
    if (!opts.shell && (d.includes('\r') || tabs.get(id)?.status === 'attention')) setStatus(id, 'working')
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
  // browser tabs never get a status dot, so its slot holds the page icon:
  // Lucide globe until the site's real favicon loads
  const icon = document.createElement('span')
  icon.className = 'tabic'
  icon.innerHTML = lucide('globe-2')
  dot.replaceWith(icon)
  wv.addEventListener('page-favicon-updated', ev => {
    const u = ev.favicons && ev.favicons[0]
    if (!u) return
    const img = new Image()
    img.onload = () => icon.replaceChildren(img)
    img.src = u // on error the globe (or previous favicon) just stays
  })
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
  // leaving a site: drop its favicon back to the globe (a favicon-less next site
  // would otherwise keep showing the previous one's icon)
  let iconHost = null
  wv.addEventListener('did-navigate', ev => {
    syncUrl(ev)
    let host = null
    try { host = new URL(ev.url).host } catch {}
    if (host !== iconHost) { iconHost = host; icon.innerHTML = lucide('globe-2') }
  })
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
  const groupEl = t.tabEl.parentElement
  t.holder.remove()
  t.tabEl.remove()
  if (groupEl?.classList.contains('tabgroup') && !groupEl.childElementCount) groupEl.remove()
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
  t.term.write(`\r\n\x1b[90m[session ended (${code})] - close the tab or open a new one\x1b[0m\r\n`)
})

window.addEventListener('resize', applyLayout)

// ---------- sidebar ----------

// Clicking a project asks resume-vs-new via a tiny popover anchored to the row
let menuEl = null
function closeMenu() { menuEl?.remove(); menuEl = null }
window.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu() }, true)
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu() })

function sessionMenu(anchorEl, name, dir) {
  closeMenu()
  menuEl = document.createElement('div')
  menuEl.className = 'sessmenu'
  const mk = (txt, resume) => {
    const b = document.createElement('div')
    b.className = 'smitem'
    b.textContent = txt
    b.onclick = e => { e.stopPropagation(); closeMenu(); openTab(name, dir, { group: name, resume }) }
    menuEl.appendChild(b)
  }
  mk('Resume last session', true)
  mk('New session', false)
  const r = anchorEl.getBoundingClientRect()
  menuEl.style.left = (r.left + 14) + 'px'
  menuEl.style.top = Math.min(r.bottom + 2, window.innerHeight - 72) + 'px'
  document.body.appendChild(menuEl)
}

function openHub(resume = false) {
  const t = tabs.get(hubId)
  if (t && !t.dead) return activate(hubId)
  // hub session ended — exiting it is how you ask for a fresh one, so no resume here
  if (t) closeTab(hubId, true)
  hubId = openTab('⌂ Hub', HUB_DIR, { pinned: true, resume })
}

// collapsed sidebar groups, keyed by group dir so renames in config.json don't reset them
const COLLAPSED_KEY = 'hub.collapsedGroups'
const loadCollapsed = () => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []) } catch { return new Set() } }
const saveCollapsed = set => { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])) } catch {} }

function renderProjects(sections) {
  projlist.innerHTML = ''
  const collapsed = loadCollapsed()
  for (const { root, dir, projects } of sections) {
    const head = document.createElement('div')
    head.className = 'roothead'
    const chev = document.createElement('span')
    chev.className = 'chev'
    chev.innerHTML = lucide('chevron-down')
    const hlbl = document.createElement('span')
    hlbl.className = 'name'
    hlbl.textContent = root
    const hsh = document.createElement('span')
    hsh.className = 'sh'
    hsh.textContent = '❯_'
    hsh.title = `Open plain terminal in ${dir}`
    hsh.onclick = e => { e.stopPropagation(); openTab(root + ' ❯', dir, { shell: true }) }
    head.append(chev, hlbl, hsh)
    projlist.appendChild(head)
    const body = document.createElement('div')
    body.className = 'rootbody'
    projlist.appendChild(body)
    const setOpen = open => {
      head.classList.toggle('collapsed', !open)
      body.hidden = !open
      head.title = open ? 'Collapse group' : `${projects.length} projects — click to expand`
    }
    setOpen(!collapsed.has(dir))
    head.onclick = () => {
      const set = loadCollapsed()
      const nowOpen = set.has(dir)
      nowOpen ? set.delete(dir) : set.add(dir)
      saveCollapsed(set)
      setOpen(nowOpen)
    }
    // most recently opened/edited first (mtime of folder + immediate children, incl. .git)
    for (const p of [...projects].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))) {
      const el = document.createElement('div')
      el.className = 'proj'
      el.title = p.name
      const lbl = document.createElement('span')
      lbl.className = 'name'
      lbl.textContent = p.name
      const sh = document.createElement('span')
      sh.className = 'sh'
      sh.textContent = '❯_'
      sh.title = 'Open plain terminal here'
      sh.onclick = e => { e.stopPropagation(); openTab(p.name + ' ❯', p.dir, { shell: true, group: p.name }) }
      el.append(lbl, sh)
      el.onclick = () => sessionMenu(el, p.name, p.dir)
      body.appendChild(el)
    }
  }
}


// ---------- sidebar: project view ----------
// While a project tab (claude or its ❯_ shell) is in the focused pane, the
// sidebar swaps the project list for that project's hub brief + a file tree.
// Hub / root shells / home terminal bring the list back; browser tabs leave it alone.
const TREE_SKIP = new Set(['.git', '.DS_Store', 'node_modules', '__pycache__'])
const TREE_MAX = 200 // entries shown per folder
const PV_KEY = 'hub.pvCollapsed'
const loadPv = () => { try { return new Set(JSON.parse(localStorage.getItem(PV_KEY)) || []) } catch { return new Set() } }
const savePv = set => { try { localStorage.setItem(PV_KEY, JSON.stringify([...set])) } catch {} }
const expandedDirs = new Map() // project dir -> Set of expanded relative paths (survives re-renders)
let sidebarKey = null // 'list' | 'proj:<dir>' — what #projlist currently shows
let lastSections = [] // last list-projects result, so we can redraw the list without another IPC
let pvRefresh = null // re-reads brief + tree of the current project view in place

function syncSidebar() {
  const t = tabs.get(paneTab[focusedPane])
  if (t && t.kind === 'web') return
  const key = t?.project ? 'proj:' + t.cwd : 'list'
  if (key === sidebarKey) return
  sidebarKey = key
  if (t?.project) renderProjectView(t.project, t.cwd)
  else { pvRefresh = null; renderProjects(lastSections) }
}

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const inlineMd = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')

// tiny markdown renderer — briefs only use headings, bold labels, bullets and code spans
function renderBrief(container, name) {
  container.innerHTML = ''
  let md
  try { md = fs.readFileSync(path.join(HUB_DIR, name + '.md'), 'utf8') } catch {
    container.innerHTML = '<div class="bnone">No brief yet — ask the Hub to create one.</div>'
    return
  }
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim() || /^# /.test(line)) continue // title is already the header
    const el = document.createElement('div')
    const indent = line.match(/^\s*/)[0].length
    const body = line.trim()
    if (/^#{2,} /.test(body)) { el.className = 'bh'; el.textContent = body.replace(/^#+ /, '') }
    else if (/^[-*] /.test(body)) { el.className = 'bli'; el.innerHTML = inlineMd(body.slice(2)); el.style.marginLeft = Math.floor(indent / 2) * 10 + 'px' }
    else { el.className = 'bp'; el.innerHTML = inlineMd(body) }
    container.appendChild(el)
  }
}

// click on a file → type its path into the focused terminal: `@rel/path ` for claude
// (file mention), bare path for shells. Sent as a bracketed paste when the app has
// asked for it so claude's @-autocomplete doesn't grab the keystrokes.
function mentionFile(absPath, projDir) {
  const id = paneTab[focusedPane]
  const t = tabs.get(id)
  if (!t || t.kind !== 'term' || t.dead) return
  const rel = path.relative(projDir, absPath)
  const text = t.shell ? (/\s/.test(rel) ? `'${rel}' ` : rel + ' ') : '@' + rel + ' '
  const data = t.term.modes?.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text
  ipcRenderer.send('pty-input', id, data)
  t.term.focus()
}

function listDir(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter(d => !TREE_SKIP.has(d.name))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
  } catch { return [] }
}

function renderDirInto(container, rootDir, abs, depth) {
  const exp = expandedDirs.get(rootDir)
  const entries = listDir(abs)
  for (const d of entries.slice(0, TREE_MAX)) {
    const full = path.join(abs, d.name)
    const rel = path.relative(rootDir, full)
    const row = document.createElement('div')
    row.className = 'tnode' + (d.isDirectory() ? ' dir' : '')
    row.style.paddingLeft = (14 + depth * 12) + 'px'
    row.title = d.isDirectory() ? rel : `${rel} — click to mention in the session, right-click to reveal in Finder`
    const ic = document.createElement('span')
    ic.className = 'tic'
    ic.innerHTML = d.isDirectory() ? lucide('chevron-right') : ''
    const nm = document.createElement('span')
    nm.className = 'name'
    nm.textContent = d.name
    row.append(ic, nm)
    container.appendChild(row)
    row.oncontextmenu = e => { e.preventDefault(); electronShell.showItemInFolder(full) }
    if (d.isDirectory()) {
      let kids = null
      const setOpen = open => {
        row.classList.toggle('open', open)
        if (open && !kids) {
          kids = document.createElement('div')
          kids.className = 'tkids'
          row.after(kids)
          renderDirInto(kids, rootDir, full, depth + 1)
        } else if (!open && kids) { kids.remove(); kids = null }
      }
      if (exp.has(rel)) setOpen(true)
      row.onclick = () => { exp.has(rel) ? exp.delete(rel) : exp.add(rel); setOpen(exp.has(rel)) }
    } else {
      row.onclick = () => mentionFile(full, rootDir)
    }
  }
  if (entries.length > TREE_MAX) {
    const more = document.createElement('div')
    more.className = 'tmore'
    more.style.paddingLeft = (14 + depth * 12) + 'px'
    more.textContent = `+${entries.length - TREE_MAX} more`
    container.appendChild(more)
  }
}

function renderTree(container, dir) {
  container.innerHTML = ''
  if (!expandedDirs.has(dir)) expandedDirs.set(dir, new Set())
  renderDirInto(container, dir, dir, 0)
  if (!container.childElementCount) container.innerHTML = '<div class="bnone">Empty folder</div>'
}

function renderProjectView(name, dir) {
  projlist.innerHTML = ''
  const collapsed = loadPv()
  const head = document.createElement('div')
  head.className = 'pvhead'
  head.textContent = name
  head.title = `${dir} — right-click to reveal in Finder`
  head.oncontextmenu = e => { e.preventDefault(); electronShell.showItemInFolder(dir) }
  projlist.appendChild(head)

  const section = (key, label, fill) => {
    const h = document.createElement('div')
    h.className = 'roothead'
    const chev = document.createElement('span')
    chev.className = 'chev'
    chev.innerHTML = lucide('chevron-down')
    const lbl = document.createElement('span')
    lbl.className = 'name'
    lbl.textContent = label
    h.append(chev, lbl)
    const body = document.createElement('div')
    body.className = 'rootbody ' + key
    projlist.append(h, body)
    const setOpen = open => { h.classList.toggle('collapsed', !open); body.hidden = !open }
    setOpen(!collapsed.has(key))
    h.onclick = () => {
      const s = loadPv()
      const nowOpen = s.has(key)
      nowOpen ? s.delete(key) : s.add(key)
      savePv(s)
      setOpen(nowOpen)
    }
    fill(body)
    return body
  }
  const briefBody = section('brief', 'Brief', b => renderBrief(b, name))
  const treeBody = section('files', 'Files', b => renderTree(b, dir))
  pvRefresh = () => { renderBrief(briefBody, name); renderTree(treeBody, dir) }
}

async function init() {
  const cfg = await ipcRenderer.invoke('app-config')
  harness = cfg.harness
  document.title = `${harnessName()} Hub`
  const fixedrows = document.getElementById('fixedrows')

  const hubEl = document.createElement('div')
  hubEl.className = 'proj hub'
  const hlbl = document.createElement('span')
  hlbl.className = 'name'
  hlbl.textContent = '⌂ Hub'
  const rf = document.createElement('span')
  rf.className = 'rfsh'
  rf.innerHTML = lucide('refresh-cw')
  rf.title = 'Restart hub — end this session, start a fresh one'
  rf.onclick = e => {
    e.stopPropagation()
    if (tabs.has(hubId)) closeTab(hubId, true)
    hubId = openTab('⌂ Hub', HUB_DIR, { pinned: true })
  }
  hubEl.append(hlbl, rf)
  // note: not `onclick = openHub` — that would pass the MouseEvent as the resume flag
  hubEl.onclick = () => openHub()
  fixedrows.appendChild(hubEl)

  const termEl = document.createElement('div')
  termEl.className = 'proj shellrow'
  termEl.innerHTML = `<span class="ic">${lucide('terminal')}</span>Terminal`
  termEl.title = 'Open a plain terminal in your home directory'
  termEl.onclick = () => openTab('❯ Terminal', os.homedir(), { shell: true })
  fixedrows.appendChild(termEl)

  const browserEl = document.createElement('div')
  browserEl.className = 'proj shellrow'
  browserEl.innerHTML = `<span class="ic">${lucide('globe-2')}</span>Browser`
  browserEl.title = 'Open a browser tab'
  browserEl.onclick = () => openBrowserTab()
  fixedrows.appendChild(browserEl)

  await refreshProjects()

  // auto-open the hub session on launch, resuming the latest hub conversation
  openHub(true)
}

async function refreshProjects() {
  lastSections = await ipcRenderer.invoke('list-projects')
  // project view: re-read the brief + tree instead (the hub may have edited the brief)
  if (pvRefresh) pvRefresh()
  else { sidebarKey = 'list'; renderProjects(lastSections) }
}

// pick up config.json edits (and new/removed project folders) on refocus
window.addEventListener('focus', refreshProjects)

init()
