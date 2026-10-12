// X and O for Lagos Life: one small server, no packages needed (Node 18+).
// It does three jobs:
//   1. serves the game page (index.html)
//   2. runs the X and O rules, so nobody can cheat from their phone
//   3. talks to the Lagos Life (Vatar) API using your secret keys

import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"

// ---- Settings. The three secrets come from the hosting dashboard, never from this file. ----
const ORIGIN = process.env.VATAR_ORIGIN || "https://lagoslife.app"
const API_PATH = "/api/games/v1"
// .trim() drops stray spaces or line breaks picked up when pasting a key into the dashboard.
const SECRET = process.env.VATAR_SECRET?.trim()                  // vtr_test_... then vtr_live_...
const RESULTS_SECRET = process.env.VATAR_RESULTS_SECRET?.trim()  // signs match results
const WEBHOOK_SECRET = process.env.VATAR_WEBHOOK_SECRET?.trim()  // checks webhooks really came from Vatar
const PORT = process.env.PORT || 8080
const GOLD = "gold_marks"                                // the product id you create in the dashboard
// The database (Upstash Redis). Without these two, everything lives in memory only and is lost on restart.
const DB_URL = process.env.UPSTASH_REDIS_REST_URL?.trim()
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()

const PAGE = fs.readFileSync(new URL("./index.html", import.meta.url))
// This header lets Lagos Life show the game inside its frame (docs: Quick start, step 2).
const FRAME = "frame-ancestors https://lagoslife.app https://www.lagoslife.app " +
  "https://naijalife.app https://www.naijalife.app https://lagoslife.eliysites.com"

// ---- Memory: a quick copy of what's in the database. Sessions are only kept here (they expire anyway). ----
const sessions = new Map()   // session token -> who it belongs to (so we don't re-check every second)
const games = new Map()      // match id -> the board and whose turn it is
const owned = new Map()      // player id -> set of product ids they bought
const wins = new Map()       // player id -> number of wins

// ---- The database: one command per call, e.g. db("HGET", "wins", playerId). Returns null if there is no database. ----
async function db(...command) {
  if (!DB_URL) return null
  const r = await fetch(DB_URL, { method: "POST", headers: { Authorization: `Bearer ${DB_TOKEN}` }, body: JSON.stringify(command) })
  const out = await r.json().catch(() => ({ error: "HTTP " + r.status }))
  if (out.error) throw new Error("database: " + out.error)
  return out.result
}

// What's stored:  wins (player -> count)   owned:<player> (product ids)   game:<match id> (board, 2 days)
//                 unsettled (match ids whose result Vatar hasn't accepted yet)
async function getWins(playerId) {
  if (!wins.has(playerId)) wins.set(playerId, Number(await db("HGET", "wins", playerId)) || 0)
  return wins.get(playerId)
}
async function addWin(playerId) {
  const n = await db("HINCRBY", "wins", playerId, 1)
  wins.set(playerId, n ?? (wins.get(playerId) || 0) + 1)
}
async function owns(playerId, productId) {
  if (owned.get(playerId)?.has(productId)) return true
  if ((await db("SISMEMBER", "owned:" + playerId, productId)) !== 1) return false
  if (!owned.has(playerId)) owned.set(playerId, new Set())
  owned.get(playerId).add(productId)
  return true
}
async function give(playerId, productId) {
  await db("SADD", "owned:" + playerId, productId)   // saved first, so nothing is marked delivered unless it's stored
  if (!owned.has(playerId)) owned.set(playerId, new Set())
  owned.get(playerId).add(productId)
}
async function saveGame(game) {
  const { settling, ...keep } = game
  await db("SET", "game:" + game.id, JSON.stringify(keep), "EX", 2 * 24 * 60 * 60)
  if (game.winner && !game.settled) await db("SADD", "unsettled", game.id)
  if (game.settled) await db("SREM", "unsettled", game.id)
}

// ---- Calling the Vatar API: every call carries the secret as a Bearer token. ----
async function vatar(method, path, body, extraHeaders = {}) {
  const r = await fetch(ORIGIN + API_PATH + path, {
    method,
    body,
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...extraHeaders },
  })
  return { http: r.status, ...(await r.json().catch(() => ({}))) }
}

// Who is playing? Ask Vatar once, then remember the answer until the token expires.
async function whoIs(session) {
  if (typeof session !== "string" || session.length > 4000) return null
  const known = sessions.get(session)
  if (known && known.exp > Date.now()) return known
  const v = await vatar("POST", "/session/verify", JSON.stringify({ session }))
  if (v.http !== 200) return null
  const me = { playerId: v.playerId, name: v.name, mode: v.mode, exp: v.exp }
  if (sessions.size > 5000) sessions.clear()
  sessions.set(session, me)
  return me
}

// ---- The X and O rules ----
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]
const MARKS = ["X", "O"]

async function place(game, cell) {
  game.board[cell] = MARKS[game.turn]
  const line = LINES.find(([a, b, c]) => game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c])
  if (line) {
    game.winner = game.players[game.turn].playerId
  } else if (game.board.every(Boolean)) {
    game.winner = "draw"
  } else {
    game.turn = 1 - game.turn
  }
  if (line) await addWin(game.winner)
  await saveGame(game)
}

// Find the game for a match: in memory, then in the database, or start one by asking Vatar who is in the match.
// Two requests arriving together for a new match share one lookup, so they can't end up with two different boards.
const loading = new Map()
function loadGame(matchId) {
  if (games.has(matchId)) return Promise.resolve(games.get(matchId))
  if (!loading.has(matchId)) loading.set(matchId, findGame(matchId).finally(() => loading.delete(matchId)))
  return loading.get(matchId)
}
async function findGame(matchId) {
  const saved = await db("GET", "game:" + matchId)
  if (saved) {
    const game = { ...JSON.parse(saved), settling: false }
    for (const id in game.seen) game.seen[id] = Date.now()   // don't let the test bot jump in right after a restart
    games.set(matchId, game)
    return game
  }
  const m = await vatar("GET", `/matches/${encodeURIComponent(matchId)}`)
  if (m.http !== 200 || m.status !== "playing" || !Array.isArray(m.players) || m.players.length !== 2) return null
  const now = Date.now()
  const game = {
    id: m.id, nonce: m.nonce, mode: m.mode,
    players: m.players.map((p) => ({ playerId: p.playerId, name: p.name })),  // first player is X
    board: Array(9).fill(null), turn: 0, winner: null, settled: false, settling: false,
    seen: Object.fromEntries(m.players.map((p) => [p.playerId, now])),
  }
  games.set(matchId, game)
  await saveGame(game)
  return game
}

// Tell Vatar who won. Signed with the results secret, exactly as the docs describe.
async function settle(game) {
  if (game.settled || game.settling || !game.winner) return
  game.settling = true
  try {
    const path = `${API_PATH}/matches/${encodeURIComponent(game.id)}/result`
    const body = JSON.stringify({ winner: game.winner })
    const ts = String(Math.floor(Date.now() / 1000))
    const sha = crypto.createHash("sha256").update(body).digest("hex")
    const sig = "v1=" + crypto.createHmac("sha256", RESULTS_SECRET)
      .update(["POST", path, ts, game.nonce, sha].join("\n")).digest("hex")
    const r = await vatar("POST", `/matches/${encodeURIComponent(game.id)}/result`, body,
      { "X-Vatar-Timestamp": ts, "X-Vatar-Signature": sig })
    // 200 = settled. 409 = it was already settled or is over, so stop trying. Anything else: try again later.
    if (r.http === 200 || r.http === 409) { game.settled = true; await saveGame(game) }
    else {
      console.log("settle failed, will retry:", r.http, r.error)
      // Clues for fixing it. Never log the secret itself, only facts about it.
      const raw = process.env.VATAR_RESULTS_SECRET || ""
      console.log("settle check:", JSON.stringify({
        resultsSecretSet: Boolean(RESULTS_SECRET),
        resultsSecretLength: RESULTS_SECRET?.length || 0,
        resultsSecretKind: RESULTS_SECRET?.match(/^[a-z]+_[a-z]+_/)?.[0] || "no vtr_..._ prefix",  // e.g. "vtr_whsec_", never the secret part
        hadExtraSpaces: raw !== raw.trim(),
        sameAsWebhookSecret: Boolean(RESULTS_SECRET) && RESULTS_SECRET === WEBHOOK_SECRET,
        sameAsGameSecret: Boolean(RESULTS_SECRET) && RESULTS_SECRET === SECRET,
        noncePresent: typeof game.nonce === "string" && game.nonce.length > 0,
      }))
    }
  } finally {
    game.settling = false
  }
}

// Keep trying to post finished results, even after both players have gone back to the lobby.
// Until a result is accepted, Lagos Life keeps the players in that match ("busy").
setInterval(() => {
  for (const game of games.values()) if (game.winner && !game.settled) settle(game).catch((e) => console.error(e))
}, 30 * 1000)

// After a restart, pick up finished games whose result still needs posting.
if (DB_URL) {
  db("SMEMBERS", "unsettled")
    .then((ids) => Promise.all((ids || []).map((id) => loadGame(id))))
    .then((list) => console.log("database connected; results still to post:", list.filter(Boolean).length))
    .catch((e) => console.error("database problem at start:", e.message))
} else {
  console.log("No database set (UPSTASH_REDIS_REST_URL): wins, purchases and games are kept in memory only.")
}

// What one player is allowed to see about the game.
function view(game, me, myWins) {
  const mine = game.players.findIndex((p) => p.playerId === me.playerId)
  const winnerIdx = game.players.findIndex((p) => p.playerId === game.winner)
  return {
    board: game.board,
    you: MARKS[mine],
    turn: MARKS[game.turn],
    names: { X: game.players[0].name, O: game.players[1].name },
    over: Boolean(game.winner),
    winner: game.winner === "draw" ? "draw" : winnerIdx >= 0 ? MARKS[winnerIdx] : null,
    settled: game.settled,
    wins: myWins,
  }
}

// ---- Small helpers ----
const send = (res, code, data) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(data))
}
const read = (req) => new Promise((ok, fail) => {
  const chunks = []; let size = 0
  req.on("data", (c) => { size += c.length; if (size > 10000) { fail(new Error("too big")); req.destroy() } else chunks.push(c) })
  req.on("end", () => ok(Buffer.concat(chunks)))
  req.on("error", fail)
})
const goodId = (id) => typeof id === "string" && /^[\w-]{1,64}$/.test(id)

function webhookIsGenuine(raw, header) {
  const want = Buffer.from("sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET || "").update(raw).digest("hex"))
  const got = Buffer.from(String(header ?? ""))
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

// ---- The routes ----
http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0]

    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": FRAME, "Cache-Control": "no-cache" })
      return res.end(PAGE)
    }
    if (req.method === "GET" && url === "/health") return send(res, 200, { ok: true })
    if (req.method !== "POST") return send(res, 404, { error: "not_found" })

    const raw = await read(req)

    // Vatar telling us a purchase was paid. A nudge only: the game still claims it through /api/claim.
    if (url === "/vatar-webhook") {
      if (!webhookIsGenuine(raw, req.headers["x-vatar-signature"])) return send(res, 401, { error: "bad_signature" })
      return send(res, 200, { ok: true })
    }

    // Everything below comes from the game page and must say who is asking.
    let data
    try { data = JSON.parse(raw) } catch { return send(res, 400, { error: "bad_request" }) }
    const me = await whoIs(data.session)
    if (!me) return send(res, 401, { error: "bad_session" })

    if (url === "/api/me") {
      return send(res, 200, { gold: await owns(me.playerId, GOLD), wins: await getWins(me.playerId) })
    }

    if (url === "/api/claim") {
      if (!goodId(data.purchaseId)) return send(res, 400, { error: "bad_request" })
      const p = await vatar("GET", `/purchases/${encodeURIComponent(data.purchaseId)}`)   // is it real, and paid?
      if (p.http !== 200 || p.playerId !== me.playerId) return send(res, 403, { error: "not_yours" })
      if (p.status === "refunded") return send(res, 409, { error: "refunded" })
      await give(me.playerId, p.productId)                                              // give the item (saved)
      await vatar("POST", `/purchases/${encodeURIComponent(p.id)}/deliver`, "{}")       // mark delivered (safe to repeat)
      return send(res, 200, { ok: true, productId: p.productId })
    }

    if (url === "/api/state" || url === "/api/move") {
      if (!goodId(data.matchId)) return send(res, 400, { error: "bad_request" })
      const game = await loadGame(data.matchId)
      if (!game) return send(res, 404, { error: "no_game" })
      const mine = game.players.findIndex((p) => p.playerId === me.playerId)
      if (mine < 0) return send(res, 403, { error: "not_in_match" })
      game.seen[me.playerId] = Date.now()

      if (url === "/api/move") {
        const cell = data.cell
        if (game.winner) return send(res, 409, { error: "game_over" })
        if (game.turn !== mine) return send(res, 409, { error: "not_your_turn" })
        if (!Number.isInteger(cell) || cell < 0 || cell > 8 || game.board[cell]) return send(res, 400, { error: "bad_move" })
        await place(game, cell)
      } else if (game.mode === "test" && !game.winner && game.turn !== mine) {
        // Sandbox only: if the other seat is the test bot (it never calls us), play a random move for it.
        const other = game.players[game.turn].playerId
        if (Date.now() - game.seen[other] > 4000) {
          const free = game.board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0)
          await place(game, free[Math.floor(Math.random() * free.length)])
        }
      }

      if (game.winner && !game.settled) await settle(game)
      return send(res, 200, view(game, me, await getWins(me.playerId)))
    }

    return send(res, 404, { error: "not_found" })
  } catch (e) {
    console.error(e)
    if (!res.headersSent) send(res, 500, { error: "error" })
  }
}).listen(PORT, () => console.log("X and O is running on port " + PORT))
