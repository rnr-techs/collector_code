// collector/index.js
// Main entry point. Runs once per GitHub Actions invocation.
//
// Flow:
//   1. Load tracked games from Supabase
//   2. For each game: hit Twitch Helix, write category + stream snapshots
//   3. Prune snapshots older than 35 days
//   4. Log a summary and exit

import { getCategorySnapshot } from './twitch.js'
import {
  getTrackedGames,
  insertCategorySnapshot,
  insertStreamSnapshots,
  pruneOldSnapshots,
} from './db.js'

// ── validateEnv ───────────────────────────────────────────────
function validateEnv() {
  const required = [
    'TWITCH_CLIENT_ID',
    'TWITCH_CLIENT_SECRET',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
  ]
  const missing = required.filter(k => !process.env[k])
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`)
  }
}

// ── collectGame ───────────────────────────────────────────────
// Collects one game and writes both snapshot tables.
// Returns a result object for the summary log.
async function collectGame(game, capturedAt) {
  const start = Date.now()

  try {
    const { viewer_count, channel_count, ranked } =
      await getCategorySnapshot(game.twitch_game_id)

    await insertCategorySnapshot({
      game_id:       game.id,
      captured_at:   capturedAt,
      viewer_count,
      channel_count,
    })

    await insertStreamSnapshots({
      game_id:     game.id,
      captured_at: capturedAt,
      ranked,
    })

    const density = channel_count > 0
      ? (viewer_count / channel_count).toFixed(1)
      : '0'

    return {
      name:     game.name,
      ok:       true,
      viewers:  viewer_count,
      channels: channel_count,
      density,
      streams:  ranked.length,
      ms:       Date.now() - start,
    }
  } catch (err) {
    return {
      name: game.name,
      ok:   false,
      err:  err.message,
      ms:   Date.now() - start,
    }
  }
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  console.log('=== CipherStream Collector ===')
  console.log(`Started: ${new Date().toISOString()}`)

  validateEnv()

  // Shared timestamp for this collection cycle — all rows in the same
  // run share the same captured_at so time-range queries are clean.
  const capturedAt = new Date().toISOString()

  // Load games to track
  const games = await getTrackedGames()
  console.log(`Tracking ${games.length} game(s): ${games.map(g => g.name).join(', ')}`)

  // Collect sequentially to avoid hammering Twitch rate limits.
  // Twitch allows 800 req/min on App tokens — sequential is safe
  // and simpler to debug than parallel.
  const results = []
  for (const game of games) {
    const result = await collectGame(game, capturedAt)
    results.push(result)

    if (result.ok) {
      console.log(
        `  ✓ ${result.name.padEnd(20)} ` +
        `viewers=${String(result.viewers).padStart(6)}  ` +
        `channels=${String(result.channels).padStart(4)}  ` +
        `density=${String(result.density).padStart(6)}  ` +
        `top_streams=${result.streams}  ` +
        `(${result.ms}ms)`
      )
    } else {
      console.error(`  ✗ ${result.name}: ${result.err}`)
    }
  }

  // Prune old data once per run
  console.log('Pruning snapshots older than 35 days...')
  await pruneOldSnapshots()

  // Summary
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`\nDone — ${passed} succeeded, ${failed} failed`)
  console.log(`Finished: ${new Date().toISOString()}`)

  // Exit with error code if any game failed — makes GitHub Actions
  // mark the run as failed so you get notified.
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Fatal collector error:', err)
  process.exit(1)
})
