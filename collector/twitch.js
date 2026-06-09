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
// Returns { viewer_count, channel_count } for a game category.
// We fetch top-20 streams:
//   - top-5  → Effective Density
//   - top-10 → Concentration Ratio
//   - top-20 → Browse Position (more accurate rank estimate)
export async function getCategorySnapshot(twitchGameId, maxStreams = 20) {
  const streams = []
  let cursor    = null
  let fetched   = 0

  while (fetched < maxStreams) {
    const limit  = Math.min(100, maxStreams - fetched)
    const params = { game_id: twitchGameId, first: limit }
    if (cursor) params.after = cursor

    const data = await twitchGet('/streams', params)

    if (!data.data?.length) break
    streams.push(...data.data)
    fetched += data.data.length

    cursor = data.pagination?.cursor
    if (!cursor) break
  }

  // Sum viewer counts from what we fetched
  const viewer_count  = streams.reduce((sum, s) => sum + s.viewer_count, 0)
  const channel_count = streams.length

  // Build ranked list (already sorted by viewer_count desc by Twitch)
  const ranked = streams.map((s, i) => ({
    rank:         i + 1,
    viewer_count: s.viewer_count,
  }))

  return { viewer_count, channel_count, ranked }
}
