// Invite-only accounts. The admin creates a user by email; the account
// dashboard maps an Access-verified email back to that user. The email lives on
// the user record itself, so lookups scan _users/ (instances are small).

import type { Context } from "hono";
import type { Env } from "./env";
import { getUser, listUsersPage, putUser, userKey, type UserRecord } from "./storage";
import { generateOwnerToken, generateUsername, sha256Hex } from "./ids";

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

// Mid-rename, the source and target records share the email. The target,
// marked renamedFrom, wins so every request sees the same account.
async function scanForEmail(b: R2Bucket, email: string): Promise<string | null> {
  let found: string | null = null;
  let cursor: string | undefined;
  do {
    const page = await listUsersPage(b, cursor);
    for (const { username, user } of page.items) {
      if (user.email !== email) continue;
      if (user.renamedFrom) return username;
      found ??= username;
    }
    cursor = page.cursor;
  } while (cursor);
  return found;
}

// Only hits are cached, because a miss must not lock a just-invited user out for the
// TTL. A cached hit is re-checked against the record, so a rename or email
// change falls back to a fresh scan.
const EMAIL_CACHE_TTL_MS = 60_000;
const emailCache = new Map<string, { username: string; expires: number }>();

// Writes pass fresh. A cached hit can name the source of an unfinished rename,
// and a write there is lost when the rename deletes it. A fresh lookup also
// drops the entry, so the next read sees the rename target.
export async function userForEmail(b: R2Bucket, email: string, fresh = false): Promise<{ username: string; user: UserRecord } | null> {
  const hit = emailCache.get(email);
  if (!fresh && hit && hit.expires > Date.now()) {
    const user = await getUser(b, hit.username);
    if (user?.email === email) return { username: hit.username, user };
  }
  emailCache.delete(email);
  const username = await scanForEmail(b, email);
  const user = username ? await getUser(b, username) : null;
  if (!username || !user) return null;
  if (!fresh) emailCache.set(email, { username, expires: Date.now() + EMAIL_CACHE_TTL_MS });
  return { username, user };
}

// The initial token is random and never revealed, so verifyOwner needs no
// special case; the user replaces it from the dashboard.
export async function createUser(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; plan?: unknown };
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: "valid email required" }, 400);
  const plan = body.plan ?? "free";
  if (plan !== "free" && plan !== "paid") return c.json({ error: "bad plan" }, 400);
  if (await scanForEmail(c.env.SITES, email)) return c.json({ error: "email already invited" }, 409);

  let username: string;
  do {
    username = generateUsername();
  } while (await c.env.SITES.head(userKey(username)));
  await putUser(c.env.SITES, username, {
    tokenHash: await sha256Hex(generateOwnerToken()),
    email,
    legacySiteIds: [],
    plan,
    createdAt: Date.now(),
  });
  return c.json({ username, email, plan }, 201);
}
