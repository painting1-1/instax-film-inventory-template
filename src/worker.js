import { authenticated, allowAttempt, createSession, sessionCookie, sessionId, verifyPassphrase } from "./owner-auth.mjs";
import { validateState } from "./state-validation.mjs";
const OWNER = "personal:owner";
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
}
const readState = db => db.prepare("SELECT payload, updated_at, revision FROM inventory_state WHERE owner_key = ?").bind(OWNER).first();
const conflict = row => json({ error: "云端数据已有更新，请先核对本机备份再重新导入", state: row ? JSON.parse(row.payload) : null, revision: row?.revision || 0, updatedAt: row?.updated_at || null }, 409);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.DB || typeof env.OWNER_PASSPHRASE !== "string" || env.OWNER_PASSPHRASE.length < 12) return json({ error: "个人库存尚未配置，请完成数据库和口令设置" }, 503);
    if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== url.origin) return json({ error: "请求来源无效" }, 403);
    try {
      if (url.pathname === "/api/unlock" && request.method === "POST") {
        if (!await allowAttempt(request, env.DB)) return json({ error: "尝试次数过多，请 15 分钟后重试" }, 429);
        const body = await request.json().catch(() => null);
        if (!await verifyPassphrase(body?.passphrase, env.OWNER_PASSPHRASE)) return json({ error: "口令不正确" }, 401);
        return json({ uid: "owner" }, 200, { "set-cookie": await createSession(env.DB) });
      }
      if (!await authenticated(request, env.DB)) return json({ error: "请先解锁个人库存" }, 401);
      if (url.pathname === "/api/session" && request.method === "GET") return json({ uid: "owner" });
      if (url.pathname === "/api/logout" && request.method === "POST") {
        await env.DB.prepare("DELETE FROM owner_sessions WHERE id = ?").bind(await sessionId(request)).run();
        return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
      }
      if (url.pathname !== "/api/state") return json({ error: "接口不存在" }, 404);
      if (request.method === "GET") {
        const row = await readState(env.DB);
        return json({ state: row ? JSON.parse(row.payload) : null, updatedAt: row?.updated_at || null, revision: row?.revision || 0 });
      }
      if (request.method !== "PUT") return json({ error: "不支持的请求" }, 405);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 4_000_000) return json({ error: "备份过大" }, 413);
      let body, state;
      try { body = JSON.parse(raw); state = validateState(body.state); }
      catch (error) { return json({ error: error.message || "数据格式无效" }, 400); }
      const baseRevision = body.baseRevision;
      if (!Number.isInteger(baseRevision) || baseRevision < 0) return json({ error: "版本号无效" }, 400);
      const current = await readState(env.DB);
      if ((current?.revision || 0) !== baseRevision) return conflict(current);
      const now = new Date().toISOString(), revision = baseRevision + 1;
      const result = current
        ? await env.DB.prepare("UPDATE inventory_state SET payload = ?, updated_at = ?, revision = ? WHERE owner_key = ? AND revision = ?").bind(JSON.stringify(state), now, revision, OWNER, baseRevision).run()
        : await env.DB.prepare("INSERT OR IGNORE INTO inventory_state (owner_key, payload, updated_at, revision) VALUES (?, ?, ?, ?)").bind(OWNER, JSON.stringify(state), now, revision).run();
      if (!result.meta?.changes) return conflict(await readState(env.DB));
      return json({ ok: true, updatedAt: now, revision });
    } catch { return json({ error: "云端暂时无法连接，请保留本机备份后重试" }, 503); }
  },
};
