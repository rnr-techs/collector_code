// collector/index.js
// Main entry point. Runs once per cron-job.org invocation (every 10 min).
//
// Flow:
//   1. Load tracked games from Supabase
//   2. For each game: hit Twitch Helix, write category + stream snapshots
//   3. Load tracked streamers from Supabase
//   4. For each streamer: check if live, if so write a streamer_snapshot
//      with viewer count + category context at that moment
//   5. Prune old snapshots
//   6. Log summary and exit

import { getCategorySnapshot, getStreamerLiveStatus } from './twitch.js'
import {
  getTrackedGames,
  getTrackedStreamers,
  insertCategorySnapshot,
  insertStreamSnapshots,
  insertStreamerSnapshot,
  pruneOldSnapshots,
} from './db.js'

function validateEnv() {
  const required = [
    'TWITCH_CLIENT_ID',
    'TWITCH_CLIENT_SECRET',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
  ]
  const missing = required.filter(k => !process.env[k])
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`)
}

// ── collectGame ───────────────────────────────────────────────
async function collectGame(game, capturedAt) {
  const start = Date.now()
  try {
    const { viewer_count, channel_count, ranked } =
      await getCategorySnapshot(game.twitch_game_id)

    await insertCategorySnapshot({ game_id: game.id, captured_at: capturedAt, viewer_count, channel_count })
    await insertStreamSnapshots({ game_id: game.id, captured_at: capturedAt, ranked })

    const density = channel_count > 0 ? (viewer_count / channel_count).toFixed(1) : '0'
    return { name: game.name, ok: true, viewers: viewer_count, channels: channel_count, density, streams: ranked.length, ms: Date.now() - start }
  } catch (err) {
    return { name: game.name, ok: false, err: err.message, ms: Date.now() - start }
  }
}

// ── collectStreamer ────────────────────────────────────────────
// Checks if a streamer is live. If so, captures their viewer count
// and cross-references with the category snapshot from this same run
// to calculate their density context and estimated browse position.
async function collectStreamer(streamer, capturedAt, categorySnapshotMap) {
  const start = Date.now()
  try {
    const live = await getStreamerLiveStatus(streamer.twitch_user_id)

    if (!live) {
      console.log(`  ○ ${streamer.twitch_login.padEnd(20)} offline`)
      return { name: streamer.twitch_login, ok: true, live: false, ms: Date.now() - start }
    }

    // Cross-reference with category snapshot from this run
    const catSnap = live.game_id ? categorySnapshotMap[live.game_id] : null
    let category_density    = null
    let category_channels   = null
    let estimated_position  = null

    if (catSnap) {
      category_density  = catSnap.channel_count > 0
        ? Math.round(catSnap.viewer_count / catSnap.channel_count * 10) / 10
        : null
      category_channels = catSnap.channel_count

      // Estimate browse position: count ranked streams with more viewers
      const ranked = catSnap.ranked ?? []
      const above  = ranked.filter(s => s.viewer_count > live.viewer_count).length
      estimated_position = above + 1
    }

    await insertStreamerSnapshot({
      user_id:            streamer.user_id,
      captured_at:        capturedAt,
      stream_id:          live.stream_id,
      viewer_count:       live.viewer_count,
      game_id:            live.game_id,
      game_name:          live.game_name,
      stream_title:       live.stream_title,
      category_density,
      category_channels,
      estimated_position,
    })

    console.log(
      `  ✓ ${streamer.twitch_login.padEnd(20)} LIVE  ` +
      `viewers=${String(live.viewer_count).padStart(4)}  ` +
      `game=${live.game_name ?? 'unknown'}  ` +
      `pos=${estimated_position ?? '?'}  ` +
      `(${Date.now() - start}ms)`
    )

    return { name: streamer.twitch_login, ok: true, live: true, ms: Date.now() - start }
  } catch (err) {
    console.error(`  ✗ ${streamer.twitch_login}: ${err.message}`)
    return { name: streamer.twitch_login, ok: false, err: err.message, ms: Date.now() - start }
  }
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  console.log('=== DeCipher Collector ===')
  console.log(`Started: ${new Date().toISOString()}`)

  validateEnv()

  const capturedAt = new Date().toISOString()

  // ── Phase 1: Category snapshots ──────────────────────────────
  const games = await getTrackedGames()
  console.log(`\nTracking ${games.length} game(s): ${games.map(g => g.name).join(', ')}`)

  // Build a map of twitch_game_id -> snapshot data for streamer cross-referencing
  const categorySnapshotMap = {}
  const gameResults = []

  for (const game of games) {
    const result = await collectGame(game, capturedAt)
    gameResults.push(result)

    if (result.ok) {
      // Store snapshot data for streamer position estimation
      categorySnapshotMap[game.twitch_game_id] = {
        viewer_count:  result.viewers,
        channel_count: result.channels,
        ranked:        result.ranked ?? [],
      }
      console.log(
        `  ✓ ${result.name.padEnd(20)} ` +
        `viewers=${String(result.viewers).padStart(6)}  ` +
        `channels=${String(result.channels).padStart(4)}  ` +
        `density=${String(result.density).padStart(6)}  ` +
        `(${result.ms}ms)`
      )
    } else {
      console.error(`  ✗ ${result.name}: ${result.err}`)
    }
  }

  // ── Phase 2: Streamer live polling ────────────────────────────
  const streamers = await getTrackedStreamers()
  if (streamers.length > 0) {
    console.log(`\nPolling ${streamers.length} streamer(s)...`)
    for (const streamer of streamers) {
      await collectStreamer(streamer, capturedAt, categorySnapshotMap)
    }
  }

  // ── Prune old data ────────────────────────────────────────────
  console.log('\nPruning old snapshots...')
  await pruneOldSnapshots()

  // ── Summary ───────────────────────────────────────────────────
  const passed = gameResults.filter(r => r.ok).length
  const failed = gameResults.filter(r => !r.ok).length
  console.log(`\nDone — ${passed} games succeeded, ${failed} failed`)
  console.log(`Finished: ${new Date().toISOString()}`)

  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Fatal collector error:', err)
  process.exit(1)
})
