// collector/twitch.js
// Thin wrapper around Twitch Helix API.
// Uses client credentials flow (App Access Token) — no user login needed.

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const API_BASE  = 'https://api.twitch.tv/helix'

let _token     = null
let _expiresAt = 0

// ── getAppToken ───────────────────────────────────────────────
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
  _expiresAt = Date.now() + (data.expires_in - 300) * 1000
  return _token
}

// ── twitchGet ─────────────────────────────────────────────────
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
export async function getGameById(twitchGameId) {
  const data = await twitchGet('/games', { id: twitchGameId })
  return data.data?.[0] ?? null
}

// ── getCategorySnapshot ───────────────────────────────────────
// Returns { viewer_count, channel_count, ranked } for a game category.
//
// Strategy:
//   Page 1 (100 streams):
//     - top 20 stored in stream_snapshots (concentration + browse position)
//     - viewers and channel count accumulated from all pages
//
//   If Twitch returns a pagination cursor (more streams exist):
//     Paginate further in batches of 100, accumulating both viewer counts
//     and channel counts across all pages.
//     Capped at MAX_CHANNEL_PAGES to avoid rate limit issues.
//
//   viewer_count = sum of all fetched streams' viewers (up to 1,600 channels)
//   channel_count = total streams fetched (up to 1,600)
//   Both are consistent — density = viewer_count / channel_count accurately
//   reflects real competition across the full sampled population.
//
export async function getCategorySnapshot(twitchGameId, storeTop = 20) {
  const MAX_CHANNEL_PAGES = 15  // max 1,500 additional channels (1,600 total)

  // Page 1 — fetch top 100 streams
  const page1 = await twitchGet('/streams', { game_id: twitchGameId, first: 100 })
  const streams = page1.data ?? []

  // Accumulate viewer count and channel count from page 1
  let viewer_count  = streams.reduce((sum, s) => sum + s.viewer_count, 0)
  let channel_count = streams.length

  // Only store top N for stream_snapshots
  const ranked = streams.slice(0, storeTop).map((s, i) => ({
    rank:         i + 1,
    viewer_count: s.viewer_count,
  }))

  // Paginate further — accumulate viewers AND channel count
  let cursor = page1.pagination?.cursor
  let pages  = 0

  while (cursor && pages < MAX_CHANNEL_PAGES) {
    const next = await twitchGet('/streams', {
      game_id: twitchGameId,
      first:   100,
      after:   cursor,
    })

    const batch = next.data ?? []
    channel_count += batch.length
    viewer_count  += batch.reduce((sum, s) => sum + s.viewer_count, 0)
    cursor = next.pagination?.cursor
    pages++

    // Stop early if this page came back empty
    if (!batch.length) break
  }

  return { viewer_count, channel_count, ranked }
}
