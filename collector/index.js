// collector/index.js
// Main entry point. Runs every 10 minutes via GitHub Actions.
//
// Flow:
//   1. Load tracked games from Supabase
//   2. For each game: hit Twitch Helix, write category + stream snapshots
//   3. Prune old snapshots
//   4. Log summary and exit
//
// NOTE: Streamer live-status polling is handled separately by
// streamer-poll.js, which runs every 2 minutes for a smoother
// viewer-count curve. This collector no longer writes to
// streamer_snapshots.

import { getCategorySnapshot } from './twitch.js'
import {
  getTrackedGames,
  insertCategorySnapshot,
  insertStreamSnapshots,
  pruneOldSnapshots,
  refreshMaterialisedViews,
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
    return { name: game.name, ok: true, viewers: viewer_count, channels: channel_count, density, ranked, streams: ranked.length, ms: Date.now() - start }
  } catch (err) {
    return { name: game.name, ok: false, err: err.message, ms: Date.now() - start }
  }
}

// ── collectStreamer ────────────────────────────────────────────
// Checks if a streamer is live. If so, captures their viewer count
// and cross-references with the category snapshot from this same run
// to calculate their density context and estimated browse position.
// ── main ──────────────────────────────────────────────────────
async function main() {
  console.log('=== DeCipher Collector ===')
  console.log(`Started: ${new Date().toISOString()}`)

  validateEnv()

  const capturedAt = new Date().toISOString()

  // ── Category snapshots ────────────────────────────────────────
  const games = await getTrackedGames()
  console.log(`\nTracking ${games.length} game(s): ${games.map(g => g.name).join(', ')}`)

  const gameResults = []

  for (const game of games) {
    const result = await collectGame(game, capturedAt)
    gameResults.push(result)

    if (result.ok) {
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
