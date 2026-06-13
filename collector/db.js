// collector/db.js
// Supabase writes. Uses the service role key so it bypasses RLS.
// This module must NEVER run in the browser — service key is server-only.

import { createClient } from '@supabase/supabase-js'

let _client = null

function getClient() {
  if (_client) return _client

  const key = process.env.SUPABASE_SERVICE_KEY
  const url = process.env.SUPABASE_URL

  if (!key || !url) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')

  _client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionFromUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    },
  })

  return _client
}

// ── getTrackedGames ────────────────────────────────────────────
export async function getTrackedGames() {
  const { data, error } = await getClient()
    .from('games')
    .select('id, twitch_game_id, name')
  if (error) throw new Error(`getTrackedGames: ${error.message}`)
  return data
}

// ── getTrackedStreamers ────────────────────────────────────────
// Returns all users who have a streamer_profile row (Twitch linked).
// The collector polls these every run to check if they're live.
export async function getTrackedStreamers() {
  const { data, error } = await getClient()
    .from('streamer_profile')
    .select('user_id, twitch_user_id, twitch_login, display_name')
  if (error) throw new Error(`getTrackedStreamers: ${error.message}`)
  return data ?? []
}

// ── insertCategorySnapshot ─────────────────────────────────────
export async function insertCategorySnapshot({ game_id, captured_at, viewer_count, channel_count }) {
  const { error } = await getClient()
    .from('category_snapshots')
    .insert({ game_id, captured_at, viewer_count, channel_count })
  if (error) throw new Error(`insertCategorySnapshot (${game_id}): ${error.message}`)
}

// ── insertStreamSnapshots ──────────────────────────────────────
export async function insertStreamSnapshots({ game_id, captured_at, ranked }) {
  if (!ranked?.length) return
  const rows = ranked.map(({ rank, viewer_count }) => ({ game_id, captured_at, rank, viewer_count }))
  const { error } = await getClient().from('stream_snapshots').insert(rows)
  if (error) throw new Error(`insertStreamSnapshots (${game_id}): ${error.message}`)
}

// ── insertStreamerSnapshot ─────────────────────────────────────
// Writes one row when a tracked streamer is live.
// Also stores category context (density, position) at that moment.
export async function insertStreamerSnapshot({
  user_id, captured_at, stream_id, viewer_count,
  game_id, game_name, stream_title,
  category_density, category_channels, estimated_position,
}) {
  const { error } = await getClient()
    .from('streamer_snapshots')
    .upsert({
      user_id, captured_at, stream_id, viewer_count,
      game_id, game_name, stream_title,
      category_density, category_channels, estimated_position,
    }, { onConflict: 'user_id,captured_at' })
  if (error) throw new Error(`insertStreamerSnapshot: ${error.message}`)
}

// ── getGameByTwitchId ────────────────────────────────────────────
// Returns the internal game UUID + name for a given Twitch game ID,
// or null if that game isn't tracked. Used by streamer-poll.js to
// check whether the streamer's current game is one we collect data for.
export async function getGameByTwitchId(twitchGameId) {
  const { data, error } = await getClient()
    .from('games')
    .select('id, name')
    .eq('twitch_game_id', twitchGameId)
    .maybeSingle()

  if (error) throw new Error(`getGameByTwitchId: ${error.message}`)
  return data
}

// ── pruneOldSnapshots ──────────────────────────────────────────
export async function pruneOldSnapshots() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [cat, str, snap] = await Promise.all([
    getClient().from('category_snapshots').delete().lt('captured_at', cutoff),
    getClient().from('stream_snapshots').delete().lt('captured_at', cutoff),
    getClient().from('streamer_snapshots').delete().lt('captured_at', cutoff),
  ])

  if (cat.error)  console.warn('Prune category_snapshots:', cat.error.message)
  if (str.error)  console.warn('Prune stream_snapshots:', str.error.message)
  if (snap.error) console.warn('Prune streamer_snapshots:', snap.error.message)
}
