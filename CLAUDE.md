# X and O for Lagos Life

A two-player X and O (tic-tac-toe) game that runs inside the Lagos Life Games app via the Vatar Games SDK.
The owner (Tosin) is not a developer: explain steps in plain language, one at a time, with exact clicks.

## Files
- `index.html`: the game page. Loads the Vatar SDK, shows lobby / invite code / board / leaderboard, sells one item (`gold_marks`, NGN 100).
- `server.js`: Node 18+ server, no dependencies. Serves the page, runs the rules, verifies sessions and purchases, posts signed match results.
- `package.json`: `npm start` runs `node server.js`; `npm run local` runs `local.js`.
- `local.js`: local test mode. Fake Lagos Life (SDK + API, checks result signatures) on :8080, real server.js behind it on :8090.
  Open http://localhost:8080/?as=Ada and ?as=Tunde in two tabs. Never used on Render.
- `listing/`: icon and five screenshots already uploaded to the Vatar dashboard listing.

## Where things live
- Docs: https://lagoslife.app/developers/docs
- Dashboard: https://lagoslife.app/developers/dashboard (game "X and O", studio "Studio47", status In review since 11 Oct 2026 19:40)
- GitHub repo: tosinsmallz/x-and-o (branch main). Render auto-deploys from it.
- Hosting: Render free web service, https://x-and-o-u492.onrender.com
- Secrets are Render environment variables: VATAR_SECRET, VATAR_RESULTS_SECRET, VATAR_WEBHOOK_SECRET,
  UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN. Never put them in files or chat.
- Database: Upstash Redis (free), called over its REST API with fetch, so still no packages. Without the two UPSTASH
  variables the server falls back to memory only and says so in the log. local.js includes a pretend Upstash.

## Status (11 Oct 2026)
Working in the real sandbox: SDK init, test purchase, server-side purchase verify, mark delivered.

Fixed (11 Oct 2026): match results were rejected with `401 bad_signature` because of the VATAR_RESULTS_SECRET value on Render.
After correcting it, the checklist item "Multiplayer: a test match created, joined and its result posted by your server" is ticked.
"Webhook answered 2xx" is optional and still unticked (webhook URL would be https://x-and-o-u492.onrender.com/vatar-webhook).
If a failed result ever happens again, server.js logs a "settle check:" line with safe clues (never the secret), and retries
unsettled results every 30 seconds. While a result is unsettled, Lagos Life answers match calls with error `busy`.

## Notes
- Submitted for review 11 Oct 2026. On the dashboard, "Save (takes it out of review)" withdraws it: don't save listing edits while in review.
- Gold marks is cosmetic: the buyer's marks show gold on both players' boards.
- Ads for outside businesses look disallowed (review rule: no "ads for paying anywhere else"); ask Lagos Life before building any.

## Known gaps
- Database: done (11 Oct 2026). Upstash Redis "x-and-o", free tier, us-west-2 (Oregon, same as Render).
  Render log shows "database connected". Wins, owned items, games and unsettled results survive restarts.
- Keep-awake: done (11 Oct 2026). cron-job.org job "X and O keep awake" calls /health every 5 minutes so the free
  Render instance never sleeps (one always-on free service fits in Render's 750 free hours a month).
- After "Back to lobby" while a match is still unsettled, new matches fail with `busy` until the server's retry succeeds.
- Matches are friendlies only (`stake: 0`). Matches and stakes each need separate approval from the platform.

## Testing locally
The server was tested against a small stand-in for the Vatar API (set VATAR_ORIGIN to point at it). The real SDK only works
inside the Lagos Life game frame, so page behaviour must be checked in the sandbox.
