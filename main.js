const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const http = require('http')

let mainWindow
let recentTracks = []
let lastTrackId = null
let lastTrackSnapshot = null

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', [])
    let out = '', err = ''
    proc.stdout.on('data', d => (out += d))
    proc.stderr.on('data', d => (err += d))
    proc.on('close', code =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim()))
    )
    proc.stdin.write(script)
    proc.stdin.end()
  })
}

async function getSpotifyData() {
  const script = `
tell application "System Events"
  if not (exists process "Spotify") then return "not_running"
end tell
tell application "Spotify"
  set pState to player state
  if pState is stopped then return "stopped"
  set t to current track
  set tName to name of t
  set tArtist to artist of t
  set tAlbum to album of t
  set tArt to artwork url of t
  set tDur to duration of t
  set tPos to player position
  set isPlay to (pState is playing)
  set tId to id of t
  return tId & "|||" & tName & "|||" & tArtist & "|||" & tAlbum & "|||" & tArt & "|||" & (tDur as text) & "|||" & (tPos as text) & "|||" & (isPlay as text)
end tell`

  try {
    const raw = await runAppleScript(script)
    if (raw === 'not_running') return { state: 'not_running' }
    if (raw === 'stopped') return { state: 'stopped' }

    const [trackId, name, artist, album, artUrl, durRaw, posRaw, playRaw] = raw.split('|||')
    const duration = parseFloat(durRaw) / 1000
    const position = parseFloat(posRaw)
    const isPlaying = playRaw.trim() === 'true'

    if (trackId !== lastTrackId && lastTrackSnapshot) {
      recentTracks.unshift(lastTrackSnapshot)
      if (recentTracks.length > 5) recentTracks.pop()
    }
    lastTrackId = trackId
    lastTrackSnapshot = { name, artist }

    return {
      state: isPlaying ? 'playing' : 'paused',
      name, artist, album, artUrl,
      duration, position,
      recent: [...recentTracks],
    }
  } catch {
    return { state: 'error' }
  }
}

function getClaudeUsage() {
  const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl')
  const projDir     = path.join(os.homedir(), '.claude', 'projects', os.homedir().replace(/\//g, '-'))

  const now       = new Date()
  const today     = new Date(now); today.setHours(0, 0, 0, 0)
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - (today.getDay() === 0 ? 6 : today.getDay() - 1))
  const nextReset = new Date(weekStart); nextReset.setDate(weekStart.getDate() + 7)

  const dayMs  = today.getTime()
  const weekMs = weekStart.getTime()

  // ── Prompts + sessions from history.jsonl ──
  let promptsToday = 0, promptsWeek = 0
  const sessionsToday = new Set(), sessionsWeek = new Set()
  try {
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const d = JSON.parse(line)
        const ts = d.timestamp || 0, sid = d.sessionId || ''
        if (ts >= weekMs) { promptsWeek++;  sessionsWeek.add(sid) }
        if (ts >= dayMs)  { promptsToday++; sessionsToday.add(sid) }
      } catch { /* skip */ }
    }
  } catch { /* missing */ }

  // ── Tokens from conversation JSONL files (only files touched this week) ──
  const tokens = { today: { out: 0, cacheRead: 0 }, week: { out: 0, cacheRead: 0 } }
  const weekMs7d = now.getTime() - 7 * 86400000

  try {
    const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'))
    for (const fname of files) {
      const fpath = path.join(projDir, fname)
      try {
        const stat = fs.statSync(fpath)
        if (stat.mtimeMs < weekMs7d) continue  // skip untouched files

        const lines = fs.readFileSync(fpath, 'utf8').split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const d = JSON.parse(line)
            if (d.type !== 'assistant') continue
            const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0
            if (ts < weekMs) continue
            const u = d.message?.usage || {}
            const out = (u.output_tokens || 0)
            const cr  = (u.cache_read_input_tokens || 0)
            if (ts >= weekMs) { tokens.week.out += out; tokens.week.cacheRead += cr }
            if (ts >= dayMs)  { tokens.today.out += out; tokens.today.cacheRead += cr }
          } catch { /* skip */ }
        }
      } catch { /* skip file */ }
    }
  } catch { /* projDir missing */ }

  const daysUntilReset = Math.ceil((nextReset - now) / 86400000)
  const resetLabel = nextReset.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

  return {
    promptsToday, promptsWeek,
    sessionsToday: sessionsToday.size,
    tokens,
    weekStartLabel: weekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    resetLabel, daysUntilReset,
    nextResetISO: nextReset.toISOString(),
  }
}

function getRateLimitState() {
  const stateFile = path.join(os.homedir(), '.claude', 'rate-limit-state.json')
  try {
    const d = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (!d.limited) return { limited: false }
    const resetAt = new Date(d.resetAt)
    if (resetAt <= new Date()) {
      // Expired — clear the file
      fs.writeFileSync(stateFile, JSON.stringify({ limited: false }))
      return { limited: false }
    }
    return { limited: true, resetAt: d.resetAt, message: d.message || '' }
  } catch {
    return { limited: false }
  }
}

// ── Spotify OAuth PKCE ──────────────────────────────────────────────────────
const OAUTH_PORT   = 8888
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/callback`

let oauthServer = null

function pkceVerifier()   { return crypto.randomBytes(32).toString('base64url') }
function pkceChallenge(v) { return crypto.createHash('sha256').update(v).digest('base64url') }

function spotifyOAuth(clientId) {
  if (oauthServer) { oauthServer.close(); oauthServer = null }
  const verifier  = pkceVerifier()
  const challenge = pkceChallenge(verifier)

  return new Promise((resolve, reject) => {
    const authTimeout = setTimeout(() => {
      if (oauthServer) { oauthServer.close(); oauthServer = null }
      reject(new Error('Auth timed out'))
    }, 5 * 60 * 1000)

    oauthServer = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/callback')) { res.end(); return }
      clearTimeout(authTimeout)
      const url   = new URL(req.url, `http://localhost:${OAUTH_PORT}`)
      const code  = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!DOCTYPE html><html><body style="background:#111;color:#fff;font-family:system-ui;text-align:center;padding:60px"><h2 style="color:#1db954">✓ Spotify connected!</h2><p style="color:#aaa">You can close this tab.</p></body></html>')
      oauthServer.close(); oauthServer = null
      if (error || !code) { reject(new Error(error || 'No code')); return }
      try {
        const r = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }).toString(),
        })
        const t = await r.json()
        if (t.error) { reject(new Error(t.error_description || t.error)); return }
        resolve(t)
      } catch (e) { reject(e) }
    })

    oauthServer.on('error', e => { clearTimeout(authTimeout); reject(new Error(`OAuth server: ${e.message}`)) })
    oauthServer.listen(OAUTH_PORT, '127.0.0.1', () => {
      const url = new URL('https://accounts.spotify.com/authorize')
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('redirect_uri', REDIRECT_URI)
      url.searchParams.set('scope', 'user-read-currently-playing user-read-playback-state')
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('code_challenge', challenge)
      shell.openExternal(url.toString())
    })
  })
}

async function getValidSpotifyToken() {
  const s = loadSettings()
  if (!s.spotifyClientId || !s.spotifyRefreshToken) return null
  if (s.spotifyAccessToken && s.spotifyTokenExpiry > Date.now() + 60000) return s.spotifyAccessToken
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.spotifyRefreshToken, client_id: s.spotifyClientId }).toString(),
    })
    const t = await r.json()
    if (!t.access_token) return null
    const updated = { ...s, spotifyAccessToken: t.access_token, spotifyTokenExpiry: Date.now() + t.expires_in * 1000 }
    if (t.refresh_token) updated.spotifyRefreshToken = t.refresh_token
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2))
    return t.access_token
  } catch { return null }
}

async function getSpotifyQueue() {
  const token = await getValidSpotifyToken()
  if (!token) return { error: 'no_token' }
  try {
    const r = await fetch('https://api.spotify.com/v1/me/player/queue', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.status === 204) return { queue: [] }
    if (r.status === 401) return { error: 'token_expired' }
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    return { queue: (d.queue || []).slice(0, 8).map(t => ({ name: t.name, artist: t.artists?.map(a => a.name).join(', ') || '' })) }
  } catch (e) { return { error: e.message } }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 340,
    height: 720,
    minWidth: 280,
    minHeight: 400,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.setAlwaysOnTop(true, 'floating')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  app.dock.hide()
  mainWindow.loadFile('index.html')
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.show()
    mainWindow.moveTop()
  })

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', false)
  })
}

const SETTINGS_FILE = path.join(__dirname, 'user-settings.json')

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } catch { return {} }
}

ipcMain.handle('get-spotify',    () => getSpotifyData())
ipcMain.handle('get-claude',     () => getClaudeUsage())
ipcMain.handle('get-rate-limit', () => getRateLimitState())
ipcMain.handle('get-settings',   () => loadSettings())

ipcMain.handle('save-settings', (_, settings) => {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
})

ipcMain.handle('pick-image', async () => {
  const { dialog } = require('electron')
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg','jpeg','png','gif','webp'] }],
  })
  if (result.canceled || !result.filePaths.length) return null
  const src  = result.filePaths[0]
  const dest = path.join(__dirname, 'user-bg' + path.extname(src).toLowerCase())
  fs.copyFileSync(src, dest)
  return path.basename(dest)
})

ipcMain.handle('clear-image', () => {
  ['jpg','jpeg','png','gif','webp'].forEach(ext => {
    const f = path.join(__dirname, `user-bg.${ext}`)
    try { fs.unlinkSync(f) } catch { /* ok */ }
  })
})

ipcMain.handle('spotify-control', (_, action) => {
  const scripts = {
    playpause: 'tell application "Spotify" to playpause',
    next:      'tell application "Spotify" to next track',
    prev:      'tell application "Spotify" to previous track',
  }
  if (scripts[action]) runAppleScript(scripts[action]).catch(() => {})
})

ipcMain.handle('toggle-fullscreen', () => {
  const next = !mainWindow.isFullScreen()
  mainWindow.setFullScreen(next)
  return next
})

ipcMain.handle('quit', () => app.quit())

ipcMain.handle('get-spotify-queue', () => getSpotifyQueue())

ipcMain.handle('spotify-connect', async () => {
  const s = loadSettings()
  if (!s.spotifyClientId) return { error: 'Enter your Spotify Client ID first' }
  try {
    const t = await spotifyOAuth(s.spotifyClientId)
    const updated = { ...s, spotifyAccessToken: t.access_token, spotifyRefreshToken: t.refresh_token, spotifyTokenExpiry: Date.now() + t.expires_in * 1000 }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2))
    return { ok: true }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('spotify-disconnect', () => {
  const s = loadSettings()
  const { spotifyAccessToken, spotifyRefreshToken, spotifyTokenExpiry, ...rest } = s
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(rest, null, 2))
  return { ok: true }
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
