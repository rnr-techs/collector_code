# CipherStream — Twitch Collector

Runs every 15 minutes via GitHub Actions.
Writes to `category_snapshots` and `stream_snapshots` in Supabase.

---

## Setup (one-time)

### 1. Register a Twitch App

1. Go to https://dev.twitch.tv/console/apps
2. Click **Register Your Application**
3. Name: `CipherStream` (anything works)
4. OAuth Redirect URL: `http://localhost` (not used)
5. Category: **Analytics Tool**
6. Copy the **Client ID** and generate a **Client Secret**

---

### 2. Add GitHub Secrets

In your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

Add all four:

| Secret name            | Where to find it                              |
|------------------------|-----------------------------------------------|
| `TWITCH_CLIENT_ID`     | Twitch dev console → your app                 |
| `TWITCH_CLIENT_SECRET` | Twitch dev console → your app                 |
| `SUPABASE_URL`         | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → service_role key |

> ⚠️ Use the **service_role** key (not the anon key) — the collector needs to
> bypass Row Level Security to write snapshots. Never expose this key in the
> frontend or commit it to the repo.

---

### 3. Push to GitHub

The workflow file is at `.github/workflows/collect.yml`.
Once pushed to any branch, GitHub Actions will:
- Run immediately if you click **Run workflow** manually
- Run automatically every 15 minutes from then on

---

### 4. Verify it's working

After the first run:

```sql
-- In Supabase SQL Editor:
select * from category_snapshots order by captured_at desc limit 10;
select * from stream_snapshots   order by captured_at desc limit 10;
```

You should see rows with real viewer and channel counts.

---

## Local testing

```bash
cd collector
npm install

# Set env vars (never commit these)
export TWITCH_CLIENT_ID=xxx
export TWITCH_CLIENT_SECRET=xxx
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_KEY=your-service-role-key

node index.js
```

Expected output:
```
=== CipherStream Collector ===
Started: 2024-01-15T19:00:00.000Z
Tracking 5 game(s): Factorio, RimWorld, Stardew Valley, Valheim, Civilization VI
  ✓ Factorio              viewers=  8240  channels=  42  density= 196.2  top_streams=42  (312ms)
  ✓ RimWorld              viewers=  7890  channels=  36  density= 219.2  top_streams=36  (287ms)
  ✓ Stardew Valley        viewers=  9100  channels=  55  density= 165.5  top_streams=50  (301ms)
  ✓ Valheim               viewers=  9800  channels=  88  density= 111.4  top_streams=50  (294ms)
  ✓ Civilization VI       viewers=  8750  channels=  61  density= 143.4  top_streams=50  (278ms)
Pruning snapshots older than 35 days...
Done — 5 succeeded, 0 failed
Finished: 2024-01-15T19:00:02.341Z
```

---

## GitHub Actions usage estimate

Each run takes ~30s. At 4 runs/hour × 24h × 30 days = **2,880 minutes/month**.
GitHub free tier includes **2,000 minutes/month** for private repos.

**Options if you hit the limit:**
- Make the repo public (free Actions minutes are unlimited for public repos) ✅ recommended for a prototype
- Reduce to every 30 minutes (halves usage to ~1,440 min/month)
- Upgrade to GitHub Pro ($4/month, 3,000 minutes)

---

## Adding more games

Insert a row into the `games` table with the Twitch game ID:

```sql
-- Find the Twitch game ID by searching:
-- https://www.twitch.tv/directory/category/<game-slug>
-- or via the Helix API: GET /helix/games?name=Minecraft

insert into games (twitch_game_id, name) values ('27471', 'Minecraft');
```

The collector will automatically pick it up on the next run — no code changes needed.
