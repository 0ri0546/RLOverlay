const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')

require('dotenv').config({
  path: app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '..', '.env')
})

const RLS_KEY = process.env.RLS_KEY || ''
console.log('RLS_KEY:', RLS_KEY ? 'OK' : 'MISSING')
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
let myPlayerId = null

let preMatchMMR = null
let postMatchMMR = null

let previousMatchId = null
let notifWindow = null
let silenceTimer = null

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

const MMR_THRESHOLDS = {
  '1v1': {
    'Bronze I': -100, 'Bronze II': 147, 'Bronze III': 214,
    'Silver I': 273, 'Silver II': 335, 'Silver III': 395,
    'Gold I': 455, 'Gold II': 515, 'Gold III': 575,
    'Platinum I': 635, 'Platinum II': 695, 'Platinum III': 755,
    'Diamond I': 815, 'Diamond II': 874, 'Diamond III': 935,
    'Champion I': 995, 'Champion II': 1055, 'Champion III': 1106,
    'Grand Champion I': 1175, 'Grand Champion II': 1227, 'Grand Champion III': 1282,
    'Supersonic Legend': 1345
  },
  '2v2': {
    'Bronze I': -100, 'Bronze II': 168, 'Bronze III': 229,
    'Silver I': 291, 'Silver II': 351, 'Silver III': 412,
    'Gold I': 471, 'Gold II': 532, 'Gold III': 593,
    'Platinum I': 652, 'Platinum II': 712, 'Platinum III': 767,
    'Diamond I': 835, 'Diamond II': 914, 'Diamond III': 994,
    'Champion I': 1075, 'Champion II': 1195, 'Champion III': 1314,
    'Grand Champion I': 1435, 'Grand Champion II': 1575, 'Grand Champion III': 1715,
    'Supersonic Legend': 1860
  },
  '3v3': {
    'Bronze I': -100, 'Bronze II': 173, 'Bronze III': 229,
    'Silver I': 295, 'Silver II': 355, 'Silver III': 415,
    'Gold I': 475, 'Gold II': 535, 'Gold III': 595,
    'Platinum I': 655, 'Platinum II': 715, 'Platinum III': 775,
    'Diamond I': 835, 'Diamond II': 915, 'Diamond III': 995,
    'Champion I': 1075, 'Champion II': 1195, 'Champion III': 1315,
    'Grand Champion I': 1435, 'Grand Champion II': 1575, 'Grand Champion III': 1704,
    'Supersonic Legend': 1866
  }
}

function getPlaylistLabel(playlistId) {
  return { 10: '1v1', 11: '2v2', 13: '3v3' }[playlistId] || '2v2'
}

function mmrToNextRank(currentMmr, rankName, playlistId) {
  const label = getPlaylistLabel(playlistId)
  const thresholds = MMR_THRESHOLDS[label]
  const entries = Object.entries(thresholds)
  const idx = entries.findIndex(([name]) => name === rankName)
  if (idx === -1 || idx === entries.length - 1) return null
  const nextThreshold = entries[idx + 1][1]
  return Math.max(0, nextThreshold - currentMmr)
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
  mainWindow.setSize(400, Math.max(height, 200))
}

function showNotifWindow(data) {
  if (notifWindow && !notifWindow.isDestroyed()) {
    notifWindow.webContents.send('notify-data', data)
    notifWindow.showInactive()
    return
  }

  const { width } = screen.getPrimaryDisplay().workAreaSize

  notifWindow = new BrowserWindow({
    width: 420, height: 120,
    x: Math.floor((width - 420) / 2),
    y: 20,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })
  notifWindow.setAlwaysOnTop(true, 'screen-saver')
  notifWindow.setIgnoreMouseEvents(true)
  notifWindow.loadFile(path.join(__dirname, 'notif.html'))

  notifWindow.webContents.once('did-finish-load', () => {
    notifWindow.webContents.send('notify-data', data)
  })

  notifWindow.on('closed', () => { notifWindow = null })
}

function mmrProgressInRank(currentMmr, rankName, playlistId) {
  const label = getPlaylistLabel(playlistId)
  const thresholds = MMR_THRESHOLDS[label]
  const entries = Object.entries(thresholds)
  const idx = entries.findIndex(([name]) => name === rankName)
  if (idx === -1) return 0

  const low = entries[idx][1]
  const high = idx < entries.length - 1 ? entries[idx + 1][1] : low + 100

  return Math.round(Math.min(100, Math.max(0, (currentMmr - low) / (high - low) * 100)))
}

// ─── MMR fetch — fallback chain : RLS backend → TRN API → Scraping tracker.gg → RLStats.net ─
const TRN_KEY = process.env.TRN_KEY || ''
const TRN_BASE = 'https://api.tracker.gg/api/v2/rocket-league/standard/profile'

// Source 1 : RLS backend privé (BoostBoard)
async function fetchFromRLS(platform, cleanId, playlistId) {
  console.log('[RLS REQUEST]', platform, cleanId)
  const res = await axios.get(`${RLS_BASE}/player/${platform}/${cleanId}`, {
    headers: { 'X-API-Key': RLS_KEY, 'Accept': 'application/json', 'User-Agent': 'RL-Overlay/1.0' },
    timeout: 5000
  })
  const data = res.data
  if (!data?.ok) throw new Error('RLS: ok=false')
  const ranks = data?.data?.ranks || []
  const best = ranks.find(r => parseInt(r.playlistId) === playlistId) || ranks[0]
  if (!best) throw new Error('RLS: no rank')
  return { mmr: parseInt(best.mmr) || null, rank: best.tier || null }
}

// Source 2 : TRN API officielle (nécessite clé)
async function fetchFromTRN(platform, name, playlistId) {
  if (!TRN_KEY) throw new Error('TRN: no key')
  const res = await axios.get(`${TRN_BASE}/${platform}/${encodeURIComponent(name)}`, {
    headers: { 'TRN-Api-Key': TRN_KEY, 'User-Agent': 'RL-Overlay/1.0' },
    timeout: 8000
  })
  const segments = res.data?.data?.segments || []
  const seg = segments.find(s => s.type === 'playlist' && s.attributes?.playlistId === playlistId)
    || segments.find(s => s.type === 'playlist')
  if (!seg) throw new Error('TRN: no segment')
  return {
    mmr: Math.round(seg.stats?.rating?.value ?? 0) || null,
    rank: seg.stats?.tier?.metadata?.name || null
  }
}

//Source 3 : Scraping tracker.gg (pas de clé, page HTML)
async function fetchFromTrackerGG(platform, name, playlistId) {
  const url = `https://rocketleague.tracker.network/rocket-league/profile/${platform}/${encodeURIComponent(name)}/overview`
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
    timeout: 10000
  })

  const html = res.data

  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});?\s*<\/script>/s)
    || html.match(/"segments"\s*:\s*(\[.+?"type"\s*:\s*"playlist".+?\])/s)

  if (!match) throw new Error('TrackerGG: no data in HTML')

  const playlistNames = { 10: 'Duel', 11: 'Doubles', 13: 'Standard' }
  const targetName = playlistNames[playlistId]

  if (!targetName) throw new Error('TrackerGG: unknown playlist')

  const playlistRegex = new RegExp(
    `"${targetName}"[\s\S]{0,500}?"rating"\s*:\s*\{\s*"value"\s*:\s*(\d+(?:\.\d+)?)`,
    'i'
  )
  const playlistMatch = html.match(playlistRegex)
  if (!playlistMatch) throw new Error(`TrackerGG: playlist ${targetName} not found`)
  const mmr = Math.round(parseFloat(playlistMatch[1]))

  const tierRegex = new RegExp(
    `"${targetName}"[\s\S]{0,500}?"tierName"\s*:\s*"([^"]+)"`,
    'i'
  )
  const tierMatch = html.match(tierRegex)
  const rank = tierMatch ? tierMatch[1] : null

  return { mmr: mmr || null, rank }
}

// Source 4 : RLStats.net (pas de clé, API publique mais parfois instable)
async function fetchFromRLStats(platform, name, playlistId) {
  const platformMap = { epic: 'epic', steam: 'steam', psn: 'ps4', xbl: 'xboxone', switch: 'switch' }
  const p = platformMap[platform] || platform
  const res = await axios.get(`https://rlstats.net/api/1/player/info`, {
    params: { platform: p, player: name },
    headers: { 'User-Agent': 'RL-Overlay/1.0' },
    timeout: 8000
  })
  const data = res.data
  if (!data || data.error) throw new Error('RLStats: ' + (data?.error || 'no data'))

  const playlists = data.rankedSeasons
  const seasonKeys = Object.keys(playlists || {}).map(Number).sort((a, b) => b - a)
  if (!seasonKeys.length) throw new Error('RLStats: no seasons')

  const latest = playlists[seasonKeys[0]]
  const playlist = latest[playlistId] || Object.values(latest)[0]
  if (!playlist) throw new Error('RLStats: no playlist')

  return {
    mmr: Math.round(playlist.rankPoints) || null,
    rank: TIER_NAMES[playlist.tier] || null
  }
}

function fetchMMR(primaryId, playlistId) {
  const cacheKey = `${primaryId}|${playlistId}`
  if (mmrCache.has(cacheKey)) return mmrCache.get(cacheKey)

  const [platform, cleanId] = parsePrimaryId(primaryId)
  if (!platform || !cleanId) return Promise.resolve({ mmr: null, rank: null })

  const promise = (async () => {
    // 1. RLS backend
    if (RLS_KEY) {
      try {
        const result = await fetchFromRLS(platform, cleanId, playlistId)
        if (result.mmr) { console.log('[MMR] RLS OK:', cleanId.slice(0, 8), result.mmr); return result }
      } catch (e) { console.log('[MMR] RLS KO:', e.message) }
    }

    // 2. TRN API (utilise le nom du joueur, pas l'UUID)
    const playerData = lastData?.Players?.find(p => p.PrimaryId === primaryId)
    const playerName = playerData?.Name || cleanId

    if (TRN_KEY) {
      try {
        const result = await fetchFromTRN(platform, playerName, playlistId)
        if (result.mmr) { console.log('[MMR] TRN OK:', playerName, result.mmr); return result }
      } catch (e) { console.log('[MMR] TRN KO:', e.message) }
    }

    // 3. RLStats.net
    try {
      const result = await fetchFromRLStats(platform, playerName, playlistId)
      if (result.mmr) { console.log('[MMR] RLStats OK:', playerName, result.mmr); return result }
    } catch (e) { console.log('[MMR] RLStats KO:', e.message) }

    // 4. Scraping tracker.gg
    try {
      const result = await fetchFromTrackerGG(platform, playerName, playlistId)
      if (result.mmr) { console.log('[MMR] Tracker.gg OK:', playerName, result.mmr); return result }
    } catch (e) { console.log('[MMR] Tracker.gg KO:', e.message) }

    return { mmr: null, rank: null }
  })()

  promise.then(r => {
    if (!r.mmr) setTimeout(() => mmrCache.delete(cacheKey), 30000)
  })

  mmrCache.set(cacheKey, promise)
  setTimeout(() => {
    mmrCache.delete(cacheKey)
  }, 600000)
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
let matchInProgress = false
let matchEndedSent = false

async function handleEvent(env) {
  const type = env.Event || env.event || ''
  if (type !== 'UpdateState') return

  let data = env.Data || env.data || {}
  if (typeof data === 'string') try { data = JSON.parse(data) } catch { return }

  const raw = data.Players || []

  const matchId = data.MatchGuid
  if (matchId !== lastMatchId) {
    clearTimeout(silenceTimer)
    lastMatchId = matchId
    matchInProgress = false
    matchEndedSent = false
    mmrCache.clear()
    lastKnownMMR.clear()
    lastPlayerCount = 0
    send('players', [])
    resizeWindow(0)
  }

  lastData = data

  if (matchInProgress && !matchEndedSent) {
    clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => {
      if (!matchEndedSent) {
        matchEndedSent = true
        matchInProgress = false
        send('players', [])
        resizeWindow(0)
        lastPlayerCount = 0
        handleMatchEnd()
      }
    }, 3000)
  }

  if (data.Game?.bHasWinner && !matchEndedSent) {
    clearTimeout(silenceTimer)
    matchEndedSent = true
    matchInProgress = false
    send('players', [])
    resizeWindow(0)
    lastPlayerCount = 0
    handleMatchEnd()
    return
  }

  if (raw.length > 1) matchInProgress = true

  const teams = data.Game?.Teams || []
  if (teams.length >= 2) {
    send('score', {
      blue: teams.find(t => t.TeamNum === 0)?.Score ?? 0,
      orange: teams.find(t => t.TeamNum === 1)?.Score ?? 0,
      time: data.Game?.TimeSeconds ?? 0,
      overtime: data.Game?.bOvertime ?? false
    })
  }

  const demoData = {}
  for (const p of raw) {
    const id = p.PrimaryId || p.Name
    demoData[id] = { count: p.Demolitions ?? p.Demos ?? 0 }
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

async function handleMatchEnd() {
  // Le joueur local = celui ciblé par défaut (Target dans Game State)
  const targetName = lastData?.Game?.Target?.Name
  const raw = lastData?.Players || []

  const myPlayer = raw.find(p => p.Name === targetName) || raw[0]
  if (!myPlayer) return

  const primaryId = myPlayer.PrimaryId || ''
  const playlistId = PLAYLIST_PRIO[0] || 13

  // Force refresh — vide le cache pour ce joueur
  const cacheKey = `${primaryId}|${playlistId}`
  mmrCache.delete(cacheKey)

  // Petit délai pour laisser les serveurs RL mettre à jour le MMR
  await new Promise(r => setTimeout(r, 5000))

  const result = await fetchMMR(primaryId, playlistId)
  if (!result?.mmr) return

  showNotifWindow({
    mmr: result.mmr,
    rank: result.rank,
    toNext: mmrToNextRank(result.mmr, result.rank, playlistId),
    progress: mmrProgressInRank(result.mmr, result.rank, playlistId)
  })
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
