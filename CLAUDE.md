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
- Dashboard: https://lagoslife.app/developers/dashboard (game "X and O", studio "Studio47", status Draft/sandbox)
- GitHub repo: tosinsmallz/x-and-o (branch main). Render auto-deploys from it.
- Hosting: Render free web service, https://x-and-o-u492.onrender.com
- Secrets are Render environment variables: VATAR_SECRET, VATAR_RESULTS_SECRET, VATAR_WEBHOOK_SECRET. Never put them in files or chat.

## Status (11 Oct 2026)
Working in the real sandbox: SDK init, test purchase, server-side purchase verify, mark delivered.

Open problem: posting a match result returns `401 bad_signature` (Render logs: "settle failed, will retry: 401 bad_signature").
So the checklist item "Multiplayer: a test match created, joined and its result posted by your server" is unticked and
"Submit for review" stays disabled. A sandbox match is stuck in "playing" until a result is accepted (or it times out after 2 hours).

Suspects, in order:
1. VATAR_RESULTS_SECRET on Render is wrong: swapped with the webhook secret, a typo in the name, or stray whitespace.
2. The signature in `settle()` differs from what the API expects. It follows the docs: HMAC-SHA256 with the results secret over
   `["POST", path, timestamp, match.nonce, sha256hex(body)].join("\n")`, header `X-Vatar-Signature: v1=<hex>`,
   path `/api/games/v1/matches/{id}/result`. Check that `nonce` actually comes back from `GET /matches/{id}`.
   Safe debugging: log whether the nonce is present and the secret's length, never the secret itself.
   Update: settle() passes the signature check in local test mode, so suspect 1 is most likely. server.js now trims the
   secrets and, on a failed settle, logs a "settle check:" line (length, prefix kind, extra spaces, same as webhook/game secret, nonce present).

## Known gaps before submitting for review
- All state (games, wins, purchases) is in memory and is lost on restart: needs a database.
- Free Render instances sleep when idle; review checks the game loads quickly on mobile data.
- index.html shows a generic "Something went wrong" for unknown SDK error codes: show the code to make debugging easier.
- After "Back to lobby" while a match is still unsettled, "Play a friend" fails because the player is still in that match.
- Matches are friendlies only (`stake: 0`). Matches and stakes each need separate approval from the platform.

## Testing locally
The server was tested against a small stand-in for the Vatar API (set VATAR_ORIGIN to point at it). The real SDK only works
inside the Lagos Life game frame, so page behaviour must be checked in the sandbox.
