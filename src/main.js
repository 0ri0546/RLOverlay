require('dotenv').config()
const RLS_KEY = process.env.RLS_KEY || ''

const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const net = require('net')
const axios = require('axios')

let mainWindow = null
let rlSocket = null
let reconnectTimer = null
let lastMatchId = null
let lastData = null
let forcedFormat = null
let dashWindow = null
let activeModules = {
  mmr: true, rank: true, winchance: true,
  demos: true, platform: true, avg: true
}
let demoData = {}

const lastKnownMMR = new Map()

const mmrCache = new Map()

const RL_HOST = '127.0.0.1'
const RL_PORT = 49123

const RLS_BASE = 'http://vps-5d4cfceb.vps.ovh.net:6102'

// 13=Standard 3v3, 11=Doubles, 10=Duel
const PLAYLIST_PRIO = [11, 13, 10]

const TIER_NAMES = [
  'Unranked', 'Bronze I', 'Bronze II', 'Bronze III',
  'Silver I', 'Silver II', 'Silver III',
  'Gold I', 'Gold II', 'Gold III',
  'Platinum I', 'Platinum II', 'Platinum III',
  'Diamond I', 'Diamond II', 'Diamond III',
  'Champion I', 'Champion II', 'Champion III',
  'Grand Champion I', 'Grand Champion II', 'Grand Champion III',
  'Supersonic Legend'
]

const PLATFORM_ALIASES = {
  epic: 'epic', epicgames: 'epic', eos: 'epic',
  steam: 'steam', steamworks: 'steam',
  xbox: 'xbl', xboxlive: 'xbl', xbl: 'xbl', xboxone: 'xbl', xbox360: 'xbl',
  ps4: 'psn', playstation: 'psn', psn: 'psn',
  switch: 'switch',
}

function parsePrimaryId(primaryId) {
  if (!primaryId || primaryId.startsWith('Unknown')) return [null, null]
  const parts = primaryId.split('|')
  if (parts.length < 2 || !parts[1]) return [null, null]
  const raw = parts[0].toLowerCase().replace('onlineplatform_', '')
  const platform = PLATFORM_ALIASES[raw] || raw
  return [platform, parts[1]]
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: 400, height: 400,
    x: width - 416, y: 16,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
}

function createDashboard() {
  const displays = screen.getAllDisplays()
  const secondary = displays.find(d => d.id !== screen.getPrimaryDisplay().id) || displays[0]

  dashWindow = new BrowserWindow({
    width: 600, height: 500,
    x: secondary.bounds.x + 20,
    y: secondary.bounds.y + 20,
    frame: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })
  dashWindow.loadFile(path.join(__dirname, 'dashboard.html'))
  dashWindow.on('closed', () => { dashWindow = null })
}

function resizeWindow(playerCount) {
  if (!mainWindow) return
  const headerHeight = 36
  const formatBarHeight = 37
  const teamHeaderHeight = 40
  const playerRowHeight = 40
  const winChanceHeight = 40
  const settingsBarHeight = 40
  const padding = 16
  const teams = playerCount <= 2 ? 1 : 2
  const height = headerHeight + formatBarHeight + (teams * teamHeaderHeight) + (playerCount * playerRowHeight) + winChanceHeight + settingsBarHeight + padding
  mainWindow.setSize(400, Math.max(height, 120))
}

// ─── RLS fetch ────────────────────────────────────────────────────────────────

function fetchMMR(primaryId, playlistId) {
  const cacheKey = `${primaryId}|${playlistId}`
  if (mmrCache.has(cacheKey)) return mmrCache.get(cacheKey)

  const [platform, cleanId] = parsePrimaryId(primaryId)
  if (!platform || !cleanId) {
    return Promise.resolve({ mmr: null, rank: null })
  }

  const promise = axios.get(`${RLS_BASE}/player/${platform}/${cleanId}`, {
    headers: { 'X-API-Key': RLS_KEY, 'Accept': 'application/json', 'User-Agent': 'RL-Overlay/1.0' },
    timeout: 8000
  }).then(res => {
    const data = res.data
    if (!data?.ok) return { mmr: null, rank: null }

    const ranks = data?.data?.ranks || []
    const best = ranks.find(r => parseInt(r.playlistId) === playlistId) || ranks[0]
    if (!best) return { mmr: null, rank: null }

    const mmr = parseInt(best.mmr) || null
    const rank = best.tier || null
    return { mmr, rank }
  }).catch(e => {
    const status = e.response?.status
    if (status === 429) setTimeout(() => mmrCache.delete(cacheKey), 60000)
    return { mmr: null, rank: null }
  })

  mmrCache.set(cacheKey, promise)
  return promise
}

// ─── Socket RL ────────────────────────────────────────────────────────────────

function connectToRL() {
  if (rlSocket) { try { rlSocket.destroy() } catch (_) { } rlSocket = null }
  send('status', { ok: false, msg: 'Connexion...' })

  rlSocket = new net.Socket()
  let buf = ''

  rlSocket.connect(RL_PORT, RL_HOST, () => {
    send('status', { ok: true, msg: 'Connecte' })
    clearTimeout(reconnectTimer)
    buf = ''
  })

  rlSocket.on('data', chunk => {
    buf += chunk.toString()
    while (true) {
      const s = buf.indexOf('{')
      if (s === -1) { buf = ''; break }
      let depth = 0, inStr = false, esc = false, end = -1
      for (let i = s; i < buf.length; i++) {
        const c = buf[i]
        if (esc) { esc = false; continue }
        if (c === '\\') { esc = true; continue }
        if (c === '"') inStr = !inStr
        if (inStr) continue
        if (c === '{') depth++
        if (c === '}' && --depth === 0) { end = i; break }
      }
      if (end === -1) break
      try { handleEvent(JSON.parse(buf.slice(s, end + 1))) } catch (_) { }
      buf = buf.slice(end + 1)
    }
  })

  rlSocket.on('error', () => { send('status', { ok: false, msg: 'RL non detecte' }); retry() })
  rlSocket.on('close', () => { send('status', { ok: false, msg: 'Deconnecte' }); retry() })
}

function retry() {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(connectToRL, 3000)
}

// ─── Events ───────────────────────────────────────────────────────────────────

let lastPlayerCount = 0

async function handleEvent(env) {
  const type = env.Event || env.event || ''
  if (type !== 'UpdateState') return

  let data = env.Data || env.data || {}
  if (typeof data === 'string') try { data = JSON.parse(data) } catch { return }

  const matchId = data.MatchGuid
  if (matchId !== lastMatchId) {
    lastMatchId = matchId
    mmrCache.clear()
    lastKnownMMR.clear()
    lastPlayerCount = 0
    send('players', [])
    resizeWindow(0)
  }

  lastData = data

  const teams = data.Game?.Teams || []
  if (teams.length >= 2) {
    send('score', {
      blue: teams.find(t => t.TeamNum === 0)?.Score ?? 0,
      orange: teams.find(t => t.TeamNum === 1)?.Score ?? 0,
      time: data.Game?.TimeSeconds ?? 0,
      overtime: data.Game?.bOvertime ?? false
    })
  }

  const raw = data.Players || []
  const demoData = {}

  for (const p of raw) {
    const id = p.PrimaryId || p.Name
    demoData[id] = {
      count: p.Demolitions ?? p.Demos ?? 0
    }
  }

  send('demos', demoData)
  if (!raw.length) return
  if (raw.length === lastPlayerCount) return

  lastPlayerCount = raw.length

  const players = raw.map(p => {
    const known = lastKnownMMR.get(p.PrimaryId || '')
    return {
      name: p.Name,
      team: p.TeamNum ?? 0,
      platform: (p.PrimaryId || '').split('|')[0] || 'Epic',
      primaryId: p.PrimaryId || '',
      mmr: known?.mmr ?? null,
      rank: known?.rank ?? null,
      demos: 0
    }
  })

  send('players', players)
  resizeWindow(players.length)

  const formatMap = { 2: { label: '1v1', playlistId: 10 }, 4: { label: '2v2', playlistId: 11 }, 6: { label: '3v3', playlistId: 13 } }
  const formatByCount = formatMap[raw.length] || { label: `${raw.length} joueurs`, playlistId: 13 }
  const manualMap = { '1v1': { label: '1v1', playlistId: 10 }, '2v2': { label: '2v2', playlistId: 11 }, '3v3': { label: '3v3', playlistId: 13 } }
  const format = (forcedFormat && manualMap[forcedFormat]) ? manualMap[forcedFormat] : formatByCount

  send('format', format.label)
  PLAYLIST_PRIO.length = 0
  PLAYLIST_PRIO.push(format.playlistId)

  const enriched = await Promise.all(players.map(async p => ({
    ...p, ...await fetchMMR(p.primaryId, PLAYLIST_PRIO[0])
  })))
  enriched.forEach(p => {
    if (p.mmr) lastKnownMMR.set(p.primaryId, { mmr: p.mmr, rank: p.rank })
  })
  send('players', enriched)
  send('winchance', null)
  resizeWindow(enriched.length)
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.on('set-format', (_, fmt) => {
  forcedFormat = fmt === 'auto' ? null : fmt

  if (lastData && lastPlayerCount > 0) {
    const manualMap = { '1v1': 10, '2v2': 11, '3v3': 13 }
    const pid = forcedFormat ? manualMap[forcedFormat] : null
    if (pid) {
      PLAYLIST_PRIO.length = 0
      PLAYLIST_PRIO.push(pid)
    } else {
      const autoMap = { 2: 10, 4: 11, 6: 13 }
      const autoPlaylist = autoMap[(lastData.Players || []).length] || 13
      PLAYLIST_PRIO.length = 0
      PLAYLIST_PRIO.push(autoPlaylist)
    }

    const players = (lastData.Players || []).map(p => ({
      name: p.Name, team: p.TeamNum ?? 0,
      platform: (p.PrimaryId || '').split('|')[0] || 'Epic',
      primaryId: p.PrimaryId || '', mmr: null, rank: null, demos: 0
    }))
    Promise.all(players.map(async p => ({ ...p, ...await fetchMMR(p.primaryId, PLAYLIST_PRIO[0]) })))
      .then(enriched => send('players', enriched))
  }
})

ipcMain.on('set-modules', (_, mods) => {
  activeModules = mods
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('modules', activeModules)
})

ipcMain.on('update-demos', (_, data) => {
  demoData = data
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('demos', demoData)
})

ipcMain.on('send-winchance', (_, chance) => {
  if (dashWindow && !dashWindow.isDestroyed()) dashWindow.webContents.send('winchance', chance)
})

ipcMain.on('close', () => { if (mainWindow) mainWindow.hide() })
ipcMain.on('reconnect', () => connectToRL())

function send(ch, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data)
  if (dashWindow && !dashWindow.isDestroyed()) dashWindow.webContents.send(ch, data)
}

// ─── Raccourcis ──────────────────────────────────────────────────────────────────────

const { uIOhook, UiohookKey } = require('uiohook-napi')

const FORMATS = ['auto', '1v1', '2v2', '3v3']
let currentFormatIdx = 0

function startKeyboardHook() {
  uIOhook.on('keydown', e => {
    if (e.keycode === UiohookKey['1']) {
      currentFormatIdx = (currentFormatIdx + 1) % FORMATS.length
      const fmt = FORMATS[currentFormatIdx]
      forcedFormat = fmt === 'auto' ? null : fmt
      ipcMain.emit('set-format', null, fmt)
      send('format', fmt)
    }
  })
  uIOhook.start()
}

const { spawn } = require('child_process')

let gpProcess = null
let lastR3 = false

function startGamepadPolling() {
  const ps1 = app.isPackaged
    ? path.join(process.resourcesPath, 'xinput.ps1')
    : path.join(__dirname, 'xinput.ps1')
  gpProcess = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1
  ])

  let gpBuf = ''
  gpProcess.stdout.on('data', chunk => {
    gpBuf += chunk.toString()
    const lines = gpBuf.split('\n')
    gpBuf = lines.pop()
    for (const line of lines) {
      const [result, buttons] = line.trim().split(',').map(Number)
      if (isNaN(result) || isNaN(buttons)) continue
      if (result !== 0) continue

      const r3 = !!(buttons & 0x0080)
      const lb = !!(buttons & 0x0100)
      if (r3 && lb && !lastR3) {
        currentFormatIdx = (currentFormatIdx + 1) % FORMATS.length
        const fmt = FORMATS[currentFormatIdx]
        forcedFormat = fmt === 'auto' ? null : fmt
        ipcMain.emit('set-format', null, fmt)
        send('format', fmt)
      }
      lastR3 = r3 && lb
    }
  })

  gpProcess.stderr.on('data', d => console.log('[GP] stderr:', d.toString()))

  gpProcess.on('error', e => console.log('[GP] erreur:', e.message))
  gpProcess.on('close', () => console.log('[GP] processus terminé'))
}

// ─── App ──────────────────────────────────────────────────────────────────────

function cleanup() {
  if (rlSocket) {
    try { rlSocket.destroy() } catch { }
    rlSocket = null
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  if (gpProcess) {
    try { gpProcess.kill() } catch { }
    gpProcess = null
  }

  try { uIOhook.stop() } catch { }
}

app.whenReady().then(() => {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
  createWindow()
  createDashboard()
  connectToRL()
  startKeyboardHook()
  startGamepadPolling()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  cleanup()
})

app.on('will-quit', () => {
  cleanup()
})
