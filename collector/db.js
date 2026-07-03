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
// Returns all unique streamers from the global streamers table.
// The collector polls these every run to check if they're live.
// Now queries streamers table (not streamer_profile) so all
// tracked streamers across all users are included.
export async function getTrackedStreamers() {
  const { data, error } = await getClient()
    .from('streamers')
    .select('id, twitch_user_id, twitch_login, display_name')
  if (error) throw new Error(`getTrackedStreamers: ${error.message}`)
  return data ?? []
}

// ── upsertStreamer ─────────────────────────────────────────────
// Creates or updates a streamer in the global streamers table.
// Called by the API route when a user connects/refreshes a streamer.
export async function upsertStreamer({
  twitch_user_id, twitch_login, display_name,
  profile_image_url, broadcaster_type, account_created, description,
}) {
  const { data, error } = await getClient()
    .from('streamers')
    .upsert({
      twitch_user_id, twitch_login, display_name,
      profile_image_url, broadcaster_type, account_created, description,
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'twitch_user_id' })
    .select('id')
    .single()
  if (error) throw new Error(`upsertStreamer: ${error.message}`)
  return data
}

// ── linkUserStreamer ───────────────────────────────────────────
// Links a DeCipher user to a streamer in user_streamers.
// Safe to call multiple times — ON CONFLICT DO NOTHING.
export async function linkUserStreamer(userId, streamerId) {
  const { error } = await getClient()
    .from('user_streamers')
    .insert({ user_id: userId, streamer_id: streamerId })
    .throwOnError()
  // Ignore duplicate — user already tracks this streamer
  if (error && !error.message.includes('duplicate')) {
    throw new Error(`linkUserStreamer: ${error.message}`)
  }
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
// Now keyed by streamer_id (global) not user_id (per-user).
export async function insertStreamerSnapshot({
  streamer_id, captured_at, stream_id, viewer_count,
  game_id, game_name, stream_title,
  category_density, category_channels, estimated_position,
}) {
  const { error } = await getClient()
    .from('streamer_snapshots')
    .upsert({
      streamer_id, captured_at, stream_id, viewer_count,
      game_id, game_name, stream_title,
      category_density, category_channels, estimated_position,
    }, { onConflict: 'streamer_id,captured_at' })
  if (error) throw new Error(`insertStreamerSnapshot: ${error.message}`)
}

// ── getGameByTwitchId ──────────────────────────────────────────
// Returns the internal game UUID + name for a given Twitch game ID,
// or null if that game isn't tracked.
export async function getGameByTwitchId(twitchGameId) {
  const { data, error } = await getClient()
    .from('games')
    .select('id, name')
    .eq('twitch_game_id', twitchGameId)
    .maybeSingle()
  if (error) throw new Error(`getGameByTwitchId: ${error.message}`)
  return data
}

// ── ensureGameExists ───────────────────────────────────────────
// Auto-detects new games from streamer sessions.
// If a game isn't in the games table, inserts it so it can be
// tracked and optionally added to owned_games later.
// Returns the game's internal UUID.
export async function ensureGameExists({ twitch_game_id, name, box_art_url }) {
  // Check if already exists
  const existing = await getGameByTwitchId(twitch_game_id)
  if (existing) return existing.id

  // Insert new game
  const { data, error } = await getClient()
    .from('games')
    .insert({ twitch_game_id, name, box_art_url })
    .select('id')
    .single()

  if (error) {
    // Handle race condition — another process may have inserted it
    if (error.message.includes('duplicate') || error.message.includes('unique')) {
      const existing2 = await getGameByTwitchId(twitch_game_id)
      return existing2?.id ?? null
    }
    throw new Error(`ensureGameExists: ${error.message}`)
  }

  console.log(`  + New game detected and added: ${name} (${twitch_game_id})`)
  return data.id
}

// ── pruneOldSnapshots ──────────────────────────────────────────
export async function pruneOldSnapshots() {
  const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [cat, str, snap] = await Promise.all([
    getClient().from('category_snapshots').delete().lt('captured_at', cutoff90),
    getClient().from('stream_snapshots').delete().lt('captured_at', cutoff30),
    getClient().from('streamer_snapshots').delete().lt('captured_at', cutoff30),
  ])

  if (cat.error)  console.warn('Prune category_snapshots:', cat.error.message)
  if (str.error)  console.warn('Prune stream_snapshots:', str.error.message)
  if (snap.error) console.warn('Prune streamer_snapshots:', snap.error.message)
}

// ── refreshMaterialisedViews ───────────────────────────────────
export async function refreshMaterialisedViews() {
  const [r1, r2, r3, r4] = await Promise.all([
    getClient().rpc('refresh_mv_effective_density'),
    getClient().rpc('refresh_mv_slot_history'),
    getClient().rpc('refresh_mv_recommendations'),
    getClient().rpc('refresh_mv_weekly_schedule'),
  ])
  if (r1.error) console.warn('Refresh mv_hourly_effective_density:', r1.error.message)
  else console.log('  ✓ mv_hourly_effective_density refreshed')
  if (r2.error) console.warn('Refresh mv_slot_history:', r2.error.message)
  else console.log('  ✓ mv_slot_history refreshed')
  if (r3.error) console.warn('Refresh mv_recommendations:', r3.error.message)
  else console.log('  ✓ mv_recommendations refreshed')
  if (r4.error) console.warn('Refresh mv_weekly_schedule:', r4.error.message)
  else console.log('  ✓ mv_weekly_schedule refreshed')
}
