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
    stream_id:    s.id,           // Twitch stream ID for exact position matching
    viewer_count: s.viewer_count,
  }))

  // Paginate further — accumulate viewers AND channel count
  // Also track position of any stream found by ID (for exact position matching)
  let cursor   = page1.pagination?.cursor
  let pages    = 0
  let pageRank = streams.length  // rank offset for subsequent pages

  // Store additional ranked entries for position matching (beyond top-20)
  const allRanked = [...ranked]

  while (cursor && pages < MAX_CHANNEL_PAGES) {
    const next = await twitchGet('/streams', {
      game_id: twitchGameId,
      first:   100,
      after:   cursor,
    })

    const batch = next.data ?? []
    channel_count += batch.length
    viewer_count  += batch.reduce((sum, s) => sum + s.viewer_count, 0)

    // Add to ranked for position matching (store all, not just top-20)
    batch.forEach((s, i) => {
      allRanked.push({
        rank:         pageRank + i + 1,
        stream_id:    s.id,
        viewer_count: s.viewer_count,
      })
    })
    pageRank += batch.length

    cursor = next.pagination?.cursor
    pages++
    if (!batch.length) break
  }

  return {
    viewer_count,
    channel_count,
    ranked:     ranked,      // top-N only (storeTop) — for DB insertion
    allRanked:  allRanked,   // up to 1,600 — for in-memory position matching
  }
}

// ── getStreamerProfile ────────────────────────────────────────
// ── getStreamerLiveStatus ──────────────────────────────────────
// Returns live stream data if the streamer is currently live,
// null if they're offline.
// Used by the Phase 2 streamer polling in the collector.
export async function getStreamerLiveStatus(twitchUserId) {
  const data = await twitchGet('/streams', { user_id: twitchUserId, first: '1' })
  const stream = data.data?.[0]
  if (!stream) return null  // offline

  // Resolve game name if there's a game_id
  let game_name = null
  if (stream.game_id) {
    const gameData = await twitchGet('/games', { id: stream.game_id })
    game_name = gameData.data?.[0]?.name ?? null
  }

  return {
    stream_id:    stream.id,
    viewer_count: stream.viewer_count,
    game_id:      stream.game_id || null,
    game_name,
    stream_title: stream.title,
    started_at:   stream.started_at,
  }
}
