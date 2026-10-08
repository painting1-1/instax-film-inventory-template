const encoder = new TextEncoder();
export const SESSION_AGE = 90 * 24 * 3600;
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
}
export async function verifyPassphrase(input, expected) {
  if (typeof input !== "string" || input.length > 200) return false;
  const a = await digest(input), b = await digest(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export function sessionCookie(token, age = SESSION_AGE) {
  return `__Host-inventory=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
}
export async function sessionId(request) {
  const token = /(?:^|;\s*)__Host-inventory=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") || "")?.[1];
  return token ? digest(token) : null;
}
export async function authenticated(request, db) {
  const id = await sessionId(request);
  if (!id) return false;
  return Boolean(await db.prepare("SELECT id FROM owner_sessions WHERE id = ? AND expires_at > ?").bind(id, Date.now()).first());
}
export async function createSession(db) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, "0")).join("");
  await db.prepare("DELETE FROM owner_sessions WHERE expires_at <= ?").bind(Date.now()).run();
  await db.prepare("INSERT INTO owner_sessions (id, expires_at) VALUES (?, ?)").bind(await digest(token), Date.now() + SESSION_AGE * 1000).run();
  return sessionCookie(token);
}
export async function allowAttempt(request, db) {
  const slot = Math.floor(Date.now() / 900000);
  const key = `${slot}:${await digest(request.headers.get("CF-Connecting-IP") || "unknown")}`;
  await db.prepare("DELETE FROM unlock_attempts WHERE slot < ?").bind(slot - 1).run();
  const result = await db.prepare("INSERT INTO unlock_attempts (id, slot, attempts) VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1 WHERE attempts < 10").bind(key, slot).run();
  return Boolean(result.meta?.changes);
}
