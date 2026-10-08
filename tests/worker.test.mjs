import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";
function environment() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_personal.sql", import.meta.url), "utf8"));
  const DB = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { args: [], bind(...args) { this.args = args; return this; }, async first() { return statement.get(...this.args) || null; }, async run() { return { meta: { changes: Number(statement.run(...this.args).changes) } }; } };
  } };
  return { DB, OWNER_PASSPHRASE: "test-pass-12", ASSETS: { fetch: async () => new Response("empty shell") }, sqlite };
}
function request(path, method = "GET", body, cookie, origin = "https://inventory.example") {
  return new Request(`https://inventory.example${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), origin, "CF-Connecting-IP": "192.0.2.1" }, body: body ? JSON.stringify(body) : undefined });
}
async function unlock(env) {
  const response = await worker.fetch(request("/api/unlock", "POST", { passphrase: env.OWNER_PASSPHRASE }), env);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /Secure; HttpOnly; SameSite=Strict/);
  return cookie.split(";")[0];
}
const state = { products: [{ id: "p1", category: "相纸", series: "Mini", model: "双白", capacity: 20, officialPrice: 100 }], transactions: [{ id: "t1", type: "purchase", productId: "p1", quantity: 2, unitPrice: 60, date: "2026-07-01", lotId: "lot1" }] };
test("public shell contains no inventory; private APIs require backend session", async () => {
  const env = environment();
  assert.equal((await worker.fetch(request("/"), env)).status, 200);
  assert.equal((await worker.fetch(request("/api/state"), env)).status, 401);
  assert.equal((await worker.fetch(request("/api/state", "GET", null, "__Host-inventory=" + "a".repeat(64)), env)).status, 401);
  const cookie = await unlock(env);
  assert.equal((await worker.fetch(request("/api/session", "GET", null, cookie), env)).status, 200);
  env.sqlite.prepare("UPDATE owner_sessions SET expires_at = 0").run();
  assert.equal((await worker.fetch(request("/api/state", "GET", null, cookie), env)).status, 401);
});
test("wrong passphrases are rate limited and cross-site writes rejected", async () => {
  const env = environment();
  assert.equal((await worker.fetch(request("/api/unlock", "POST", { passphrase: env.OWNER_PASSPHRASE }, null, "https://evil.example"), env)).status, 403);
  for (let i = 0; i < 10; i++) assert.equal((await worker.fetch(request("/api/unlock", "POST", { passphrase: "incorrect" }), env)).status, 401);
  assert.equal((await worker.fetch(request("/api/unlock", "POST", { passphrase: env.OWNER_PASSPHRASE }), env)).status, 429);
});
test("two devices share records, reject stale writes, preserve previous data, and logout revokes only its session", async () => {
  const env = environment(), a = await unlock(env), b = await unlock(env);
  assert.equal((await worker.fetch(request("/api/state", "PUT", { state, baseRevision: 0 }, a), env)).status, 200);
  const remote = await (await worker.fetch(request("/api/state", "GET", null, b), env)).json();
  assert.equal(remote.revision, 1);
  assert.equal(remote.state.products[0].id, "p1");
  assert.equal((await worker.fetch(request("/api/state", "PUT", { state: { products: [], transactions: [] }, baseRevision: 0 }, b), env)).status, 409);
  assert.equal((await worker.fetch(request("/api/state", "PUT", { state, baseRevision: 1 }, a, "https://evil.example"), env)).status, 403);
  assert.equal((await worker.fetch(request("/api/state", "PUT", { state: { ...state, products: [] }, baseRevision: 1 }, a), env)).status, 400);
  const after = await (await worker.fetch(request("/api/state", "GET", null, b), env)).json();
  assert.deepEqual(after, remote);
  assert.equal((await worker.fetch(request("/api/logout", "POST", {}, a), env)).status, 200);
  assert.equal((await worker.fetch(request("/api/state", "GET", null, a), env)).status, 401);
  assert.equal((await worker.fetch(request("/api/state", "GET", null, b), env)).status, 200);
});
