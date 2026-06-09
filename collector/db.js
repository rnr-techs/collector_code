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
        // Explicitly set the Authorization header so the service role
        // key is sent on every request and never downgraded to anon.
        Authorization: `Bearer ${key}`,
      },
    },
  })

  return _client
}

// ── getTrackedGames ────────────────────────────────────────────
// Returns all rows from the games table.
// The collector only tracks games that exist in this table.
export async function getTrackedGames() {
  const { data, error } = await getClient()
    .from('games')
    .select('id, twitch_game_id, name')

  if (error) throw new Error(`getTrackedGames: ${error.message}`)
  return data
}

// ── insertCategorySnapshot ─────────────────────────────────────
// Writes one row to category_snapshots.
export async function insertCategorySnapshot({ game_id, captured_at, viewer_count, channel_count }) {
  const { error } = await getClient()
    .from('category_snapshots')
    .insert({ game_id, captured_at, viewer_count, channel_count })

  if (error) throw new Error(`insertCategorySnapshot (${game_id}): ${error.message}`)
}

// ── insertStreamSnapshots ──────────────────────────────────────
// Bulk-inserts the top-N stream rows for a game snapshot.
// `ranked` is [{ rank, viewer_count }]
export async function insertStreamSnapshots({ game_id, captured_at, ranked }) {
  if (!ranked?.length) return

  const rows = ranked.map(({ rank, viewer_count }) => ({
    game_id,
    captured_at,
    rank,
    viewer_count,
  }))

  const { error } = await getClient()
    .from('stream_snapshots')
    .insert(rows)

  if (error) throw new Error(`insertStreamSnapshots (${game_id}): ${error.message}`)
}

// ── pruneOldSnapshots ──────────────────────────────────────────
// Deletes snapshots older than 35 days to keep the DB lean.
// Runs once per collector execution (cheap — indexed on captured_at).
// 30 days gives full momentum + stability history while keeping
// DB size manageable with top-20 stream snapshots.
export async function pruneOldSnapshots() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [cat, str] = await Promise.all([
    getClient().from('category_snapshots').delete().lt('captured_at', cutoff),
    getClient().from('stream_snapshots').delete().lt('captured_at', cutoff),
  ])

  if (cat.error) console.warn('Prune category_snapshots warning:', cat.error.message)
  if (str.error) console.warn('Prune stream_snapshots warning:', str.error.message)
}
