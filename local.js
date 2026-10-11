// Local test mode: play X and O on your own computer, outside Lagos Life.
// Run it with `npm run local`, then open http://localhost:8080/?as=Ada and http://localhost:8080/?as=Tunde in two tabs.
//
// This file pretends to be Lagos Life. It does three jobs:
//   1. serves the game page, with a fake SDK swapped in for the real one
//   2. answers the fake SDK (players, matches, purchases, leaderboard), all in memory
//   3. answers the real game server (server.js) exactly where it would call the Vatar API,
//      including checking the match-result signature the same way the docs describe
// Nothing here talks to the internet, uses real keys or real money. It is never used on Render.

import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"

const PORT = 8080                   // the address you open in the browser
const GAME_PORT = 8090              // where the real server.js runs, behind this one
const API_PATH = "/api/games/v1"

// Made-up keys, only for this test mode. server.js reads them before it starts.
process.env.PORT = String(GAME_PORT)
process.env.VATAR_ORIGIN = `http://localhost:${PORT}`
process.env.VATAR_SECRET = "vtr_local_secret"
process.env.VATAR_RESULTS_SECRET = "vtr_local_results"
process.env.VATAR_WEBHOOK_SECRET = "vtr_local_webhook"
await import("./server.js")

// ---- Memory ----
const players = new Map()     // player id -> name
const matches = new Map()     // match id -> { id, code, status, players, nonce, mode, quick }
const purchases = new Map()   // purchase id -> { id, playerId, productId, status, delivered }
const scores = new Map()      // player id -> best score

const rand = (n) => crypto.randomBytes(n).toString("hex")
const newCode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[crypto.randomInt(24)]).join("")
const forSdk = (m) => m && { id: m.id, code: m.code, status: m.status, stake: 0, players: m.players }
const activeMatch = (pid) => [...matches.values()].find((m) => ["open", "playing"].includes(m.status) && m.players.some((p) => p.playerId === pid))
const latestMatch = (pid) => [...matches.values()].reverse().find((m) => m.players.some((p) => p.playerId === pid)) || null

function startMatch(pid, quick) {
  if (activeMatch(pid)) return { error: "in_match" }
  const m = { id: "m_" + rand(6), code: newCode(), status: "open", players: [{ playerId: pid, name: players.get(pid) }], nonce: rand(8), mode: "test", quick }
  matches.set(m.id, m)
  console.log(`[local] ${players.get(pid)} opened match ${m.code}`)
  return m
}
function joinMatch(pid, m) {
  if (activeMatch(pid)) return { error: "in_match" }
  if (!m) return { error: "not_found" }
  if (m.status !== "open" || m.players.some((p) => p.playerId === pid)) return { error: "not_open" }
  m.players.push({ playerId: pid, name: players.get(pid) })
  m.status = "playing"
  console.log(`[local] ${players.get(pid)} joined match ${m.code}, game on`)
  return m
}

// ---- What the fake SDK in the browser asks for ----
function sdk(action, d) {
  const pid = d.playerId
  if (action === "hello") { players.set(pid, String(d.name).slice(0, 30)); return { ok: true } }
  if (!players.has(pid)) return { error: "signed_out" }

  const out = (m) => (m.error ? m : forSdk(m))   // never hand the secret nonce to the browser
  if (action === "match/create") return out(startMatch(pid, false))
  if (action === "match/quick") {
    const waiting = [...matches.values()].find((m) => m.quick && m.status === "open" && m.players[0].playerId !== pid)
    return out(waiting ? joinMatch(pid, waiting) : startMatch(pid, true))
  }
  if (action === "match/join") return out(joinMatch(pid, [...matches.values()].find((m) => m.code === d.code && m.status === "open")))
  if (action === "match/leave") {
    const m = activeMatch(pid)
    if (m && m.status === "open") matches.delete(m.id)   // only an open match can be left; a game in play has to finish
    return { ok: true }
  }
  if (action === "match/current") return { match: forSdk(latestMatch(pid)) }

  if (action === "purchase") {
    const mine = [...purchases.values()].filter((p) => p.playerId === pid && p.productId === d.productId)
    if (mine.some((p) => p.delivered)) return { error: "owned" }
    const p = { id: "pur_" + rand(6), playerId: pid, productId: d.productId, status: "paid", delivered: false }
    purchases.set(p.id, p)
    console.log(`[local] ${players.get(pid)} bought ${p.productId} (pretend money)`)
    return { purchaseId: p.id, productId: p.productId }
  }
  if (action === "purchases") {
    return { list: [...purchases.values()].filter((p) => p.playerId === pid && !p.delivered).map((p) => ({ purchaseId: p.id, productId: p.productId })) }
  }

  if (action === "score") { scores.set(pid, Math.max(scores.get(pid) || 0, Number(d.score) || 0)); return { ok: true } }
  if (action === "leaderboard") {
    return { top: [...scores].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, score]) => ({ name: players.get(id), score })) }
  }
  return { error: "not_found" }
}

// ---- What server.js asks the "Vatar API" for ----
function api(method, path, raw, headers) {
  if (headers.authorization !== `Bearer ${process.env.VATAR_SECRET}`) return [401, { error: "bad_key" }]

  if (method === "POST" && path === "/session/verify") {
    const pid = String(JSON.parse(raw).session || "").replace(/^dev\./, "")
    if (!players.has(pid)) return [401, { error: "bad_session" }]
    return [200, { playerId: pid, name: players.get(pid), mode: "test", exp: Date.now() + 15 * 60 * 1000 }]
  }

  let hit
  if (method === "GET" && (hit = path.match(/^\/matches\/([\w-]+)$/))) {
    const m = matches.get(hit[1])
    return m ? [200, { id: m.id, status: m.status, players: m.players, nonce: m.nonce, mode: m.mode }] : [404, { error: "not_found" }]
  }

  if (method === "POST" && (hit = path.match(/^\/matches\/([\w-]+)\/result$/))) {
    const m = matches.get(hit[1])
    if (!m) return [404, { error: "not_found" }]
    // Check the signature the way the docs describe, so a mistake in settle() shows up here too.
    const ts = String(headers["x-vatar-timestamp"] || "")
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return [401, { error: "stale_timestamp" }]
    const sha = crypto.createHash("sha256").update(raw).digest("hex")
    const want = "v1=" + crypto.createHmac("sha256", process.env.VATAR_RESULTS_SECRET)
      .update(["POST", API_PATH + path, ts, m.nonce, sha].join("\n")).digest("hex")
    if (headers["x-vatar-signature"] !== want) {
      console.log("[local] match result REJECTED: bad_signature")
      return [401, { error: "bad_signature" }]
    }
    if (m.status !== "playing") return [409, { error: "already_settled" }]
    const { winner } = JSON.parse(raw)
    if (winner !== "draw" && !m.players.some((p) => p.playerId === winner)) return [400, { error: "bad_winner" }]
    m.status = "done"
    console.log(`[local] match ${m.code} result accepted: ${winner === "draw" ? "draw" : players.get(winner) + " won"}`)
    return [200, { ok: true }]
  }

  if (method === "GET" && (hit = path.match(/^\/purchases\/([\w-]+)$/))) {
    const p = purchases.get(hit[1])
    return p ? [200, { id: p.id, playerId: p.playerId, productId: p.productId, status: p.status }] : [404, { error: "not_found" }]
  }
  if (method === "POST" && (hit = path.match(/^\/purchases\/([\w-]+)\/deliver$/))) {
    const p = purchases.get(hit[1])
    if (!p) return [404, { error: "not_found" }]
    p.delivered = true
    return [200, { ok: true }]
  }
  return [404, { error: "not_found" }]
}

// ---- The fake SDK the page loads instead of the real one ----
const FAKE_SDK = `(() => {
  const NAMES = ["Ada", "Tunde", "Chioma", "Emeka", "Funke", "Bayo", "Ngozi", "Seyi"]
  let name = new URLSearchParams(location.search).get("as")
  if (!name) { try { name = sessionStorage.getItem("localName") } catch {} }
  if (!name) {
    name = NAMES[Math.floor(Math.random() * NAMES.length)] + " " + Math.floor(10 + Math.random() * 90)
    try { sessionStorage.setItem("localName", name) } catch {}
  }
  const playerId = "p_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_")
  const session = "dev." + playerId
  async function call(action, data) {
    const r = await fetch("/local-sdk/" + action, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, name, ...data }) })
    const j = await r.json()
    if (j.error) throw Object.assign(new Error(j.error), { code: j.error })
    return j
  }
  window.Vatar = {
    init: () => call("hello").then(() => ({ player: { id: playerId, name }, session })),
    session: async () => ({ session }),
    submitScore: (score) => call("score", { score }),
    leaderboard: () => call("leaderboard"),
    purchase: async (productId) => {
      if (!confirm("LOCAL TEST: pretend to pay NGN 100 for " + productId + "?")) throw Object.assign(new Error("cancelled"), { code: "cancelled" })
      return call("purchase", { productId })
    },
    purchases: () => call("purchases").then((r) => r.list),
    onPurchase() {}, onPause() {}, onResume() {},
    match: {
      create: (opts) => call("match/create", opts),
      quick: (opts) => call("match/quick", opts),
      join: (code) => call("match/join", { code }),
      leave: () => call("match/leave"),
      current: () => call("match/current").then((r) => r.match),
      onUpdate(cb) {
        let seen
        setInterval(async () => {
          const m = await window.Vatar.match.current().catch(() => undefined)
          if (m === undefined) return
          const key = m ? m.id + ":" + m.status : ""
          if (seen !== undefined && key !== seen) cb(m)
          seen = key
        }, 1000)
      },
    },
  }
  document.title = "X and O · " + name + " (local test)"
})()`

// ---- Small helpers ----
const send = (res, code, data) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(data))
}
const read = (req) => new Promise((ok, fail) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => ok(Buffer.concat(chunks)))
  req.on("error", fail)
})

// ---- The routes ----
http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0]

    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      // Read the page fresh each time, so edits to index.html show up on refresh.
      const page = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8")
        .replace("https://lagoslife.app/sdk/vatar-games-v1.js", "/local-sdk.js")
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      return res.end(page)
    }
    if (req.method === "GET" && url === "/local-sdk.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" })
      return res.end(FAKE_SDK)
    }

    const raw = await read(req)

    if (req.method === "POST" && url.startsWith("/local-sdk/")) {
      const out = sdk(url.slice("/local-sdk/".length), JSON.parse(raw))
      return send(res, out.error ? 400 : 200, out)
    }
    if (url.startsWith(API_PATH + "/")) {
      const [code, out] = api(req.method, url.slice(API_PATH.length), raw.toString(), req.headers)
      return send(res, code, out)
    }

    // Everything else (/api/me, /api/move, ...) goes to the real game server.
    const r = await fetch(`http://localhost:${GAME_PORT}${req.url}`, {
      method: req.method,
      headers: { "Content-Type": req.headers["content-type"] || "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
    })
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json", "Cache-Control": "no-store" })
    res.end(Buffer.from(await r.arrayBuffer()))
  } catch (e) {
    console.error(e)
    if (!res.headersSent) send(res, 500, { error: "error" })
  }
}).listen(PORT, () => console.log(`\nLocal test mode is ready. Open these in two browser tabs:\n` +
  `  http://localhost:${PORT}/?as=Ada\n  http://localhost:${PORT}/?as=Tunde\n`))
