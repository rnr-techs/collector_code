// collector/streamer-poll.js
// High-frequency streamer live check — runs every 2 minutes via a
// separate GitHub Actions workflow.
//
// For each tracked streamer:
//   - Check live status via /helix/streams
//   - If live and playing a tracked game: fetch a fresh category
//     snapshot (same call as the main collector) to get the exact
//     stream_id ranking and calculate precise browse position
//   - Insert a streamer_snapshots row
//
// This is the SOLE writer of streamer_snapshots — the main 10-15min
// collector (index.js) no longer performs a redundant streamer check.
// Category data (category_snapshots, stream_snapshots tables) is
// still written only by the main collector, not this script.

import { getStreamerLiveStatus, getCategorySnapshot } from './twitch.js'
import { getTrackedStreamers, insertStreamerSnapshot, getGameByTwitchId } from './db.js'

function validateEnv() {
  const required = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
  const missing = required.filter(k => !process.env[k])
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`)
}

async function pollStreamer(streamer, capturedAt) {
  try {
    const live = await getStreamerLiveStatus(streamer.twitch_user_id)

    if (!live) {
      console.log(`  ○ ${streamer.twitch_login.padEnd(20)} offline`)
      return { ok: true, live: false }
    }

    // Fetch fresh category data for exact stream_id position matching
    let category_density   = null
    let category_channels  = null
    let estimated_position = null

    if (live.game_id) {
      const game = await getGameByTwitchId(live.game_id)

      if (game) {
        const { viewer_count, channel_count, ranked } = await getCategorySnapshot(live.game_id)

        category_density  = channel_count > 0 ? Math.round(viewer_count / channel_count * 10) / 10 : null
        category_channels = channel_count

        // Exact position via stream_id match (ranked includes stream_id up to 1,600 channels)
        const streamIdx = ranked.findIndex(s => s.stream_id === live.stream_id)

        if (streamIdx !== -1) {
          estimated_position = streamIdx + 1
        } else {
          const above = ranked.filter(s => s.viewer_count > live.viewer_count).length
          const rank20viewers = ranked.length >= 20 ? ranked[19].viewer_count : 0

          if (live.viewer_count >= rank20viewers || channel_count <= 20) {
            estimated_position = above + 1
          } else {
            const remaining = Math.max(channel_count - 20, 1)
            const ratio = Math.max(1.0 - (live.viewer_count / Math.max(rank20viewers, 1)), 0)
            estimated_position = Math.min(20 + Math.round(ratio * remaining), channel_count)
          }
        }
      }
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
      `  ✓ ${streamer.twitch_login.padEnd(20)} LIVE  viewers=${String(live.viewer_count).padStart(4)}  ` +
      `game=${live.game_name ?? 'unknown'}  pos=${estimated_position ?? '?'}`
    )

    return { ok: true, live: true }
  } catch (err) {
    console.error(`  ✗ ${streamer.twitch_login}: ${err.message}`)
    return { ok: false, err: err.message }
  }
}

async function main() {
  console.log('=== DeCipher Streamer Poll ===')
  console.log(`Started: ${new Date().toISOString()}`)

  validateEnv()

  const capturedAt = new Date().toISOString()
  const streamers = await getTrackedStreamers()

  if (streamers.length === 0) {
    console.log('No tracked streamers — exiting.')
    return
  }

  console.log(`Polling ${streamers.length} streamer(s)...`)
  for (const streamer of streamers) {
    await pollStreamer(streamer, capturedAt)
  }

  console.log(`Finished: ${new Date().toISOString()}`)
}

main().catch(err => {
  console.error('Fatal streamer-poll error:', err)
  process.exit(1)
})
