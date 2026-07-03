// collector/streamer-poll.js
// High-frequency streamer live check — runs every 2 minutes.
// Now polls the global streamers table (not streamer_profile)
// and writes streamer_id (not user_id) to streamer_snapshots.
// Auto-detects new games and adds them to the games table.

import { getStreamerLiveStatus, getCategorySnapshot } from './twitch.js'
import {
  getTrackedStreamers,
  insertStreamerSnapshot,
  getGameByTwitchId,
  ensureGameExists,
} from './db.js'

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

    let category_density   = null
    let category_channels  = null
    let estimated_position = null

    if (live.game_id) {
      // Auto-detect: ensure game exists in games table even if not in owned_games
      // This builds the catalogue so users can add it later
      if (live.game_name) {
        await ensureGameExists({
          twitch_game_id: live.game_id,
          name: live.game_name,
          box_art_url: live.box_art_url ?? null,
        })
      }

      // Only fetch category snapshot if game is tracked (in games table)
      const game = await getGameByTwitchId(live.game_id)

      if (game) {
        const { channel_count, viewer_count, allRanked } = await getCategorySnapshot(live.game_id)

        category_density  = channel_count > 0 ? Math.round(viewer_count / channel_count * 10) / 10 : null
        category_channels = channel_count

        const streamIdx = allRanked.findIndex(s => s.stream_id === live.stream_id)

        if (streamIdx !== -1) {
          estimated_position = streamIdx + 1
        } else {
          const above = allRanked.filter(s => s.viewer_count > live.viewer_count).length
          const rank20viewers = allRanked.length >= 20 ? allRanked[19].viewer_count : 0

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

    // Write using streamer_id (global) not user_id (per-user)
    await insertStreamerSnapshot({
      streamer_id:        streamer.id,
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
