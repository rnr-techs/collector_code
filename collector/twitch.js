// collector/twitch.js
// Thin wrapper around Twitch Helix API.
// Uses client credentials flow (App Access Token) — no user login needed.

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const API_BASE  = 'https://api.twitch.tv/helix'

let _token     = null
let _expiresAt = 0

// ── getAppToken ───────────────────────────────────────────────
// Fetches a new App Access Token when the cached one expires.
async function getAppToken() {
  if (_token && Date.now() < _expiresAt) return _token

  const params = new URLSearchParams({
    client_id:     process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type:    'client_credentials',
  })

  const res  = await fetch(`${TOKEN_URL}?${params}`, { method: 'POST' })
  const data = await res.json()

  if (!res.ok) throw new Error(`Twitch token error: ${JSON.stringify(data)}`)

  _token     = data.access_token
  _expiresAt = Date.now() + (data.expires_in - 300) * 1000  // 5-min buffer
  return _token
}

// ── twitchGet ─────────────────────────────────────────────────
// Authenticated GET helper.
async function twitchGet(path, params = {}) {
  const token  = await getAppToken()
  const qs     = new URLSearchParams(params).toString()
  const url    = `${API_BASE}${path}${qs ? '?' + qs : ''}`

  const res = await fetch(url, {
    headers: {
      'Client-ID':     process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
    },
  })

  const data = await res.json()
  if (!res.ok) throw new Error(`Twitch API error on ${path}: ${JSON.stringify(data)}`)
  return data
}

// ── getGameById ───────────────────────────────────────────────
// Look up a single game by Twitch game ID.
export async function getGameById(twitchGameId) {
  const data = await twitchGet('/games', { id: twitchGameId })
  return data.data?.[0] ?? null
}

// ── getCategorySnapshot ───────────────────────────────────────
// Returns { viewer_count, channel_count, ranked } for a game category.
//
// Strategy:
//   - Fetch up to 100 streams in one API call (one page)
//   - Use ALL of them to compute total viewer_count and channel_count
//     so concentration ratio is accurate (top10 / real_total)
//   - Store only the top `storeTop` streams in stream_snapshots
//     to keep DB size manageable
//
// This gives accurate category-level metrics without storing
// hundreds of rows per snapshot.
export async function getCategorySnapshot(twitchGameId, storeTop = 20) {
  // Fetch up to 100 streams in one page — Twitch's max per request
  const data = await twitchGet('/streams', { game_id: twitchGameId, first: 100 })
  const streams = data.data ?? []

  // Total viewers and channels from the full page (up to 100)
  const viewer_count  = streams.reduce((sum, s) => sum + s.viewer_count, 0)
  const channel_count = streams.length

  // Only store top N for stream_snapshots (concentration + browse position)
  const ranked = streams.slice(0, storeTop).map((s, i) => ({
    rank:         i + 1,
    viewer_count: s.viewer_count,
  }))

  return { viewer_count, channel_count, ranked }
}
