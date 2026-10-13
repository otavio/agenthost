// User dashboard on account.{APEX_HOST}, behind Cloudflare Access (email
// one-time PIN). The Access policy admits any email; the Worker decides who is
// invited by mapping the verified email to a user record.

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./env";
import { LIMITS } from "./config";
import { verifyAccessJwt, type OwnerCtx } from "./auth";
import { normalizeEmail, userForEmail } from "./invites";
import { renameAccount } from "./rename";
import { credentialsCommand, credentialsFile } from "./skill";
import {
  assetMetaKey,
  deleteSite,
  getAssetMeta,
  getMeta,
  listAssetMetas,
  putMeta,
  putUser,
  siteRecords,
  type SiteMeta,
} from "./storage";
import { generateAccessKey, generateOwnerToken, sanitizeSiteId, sha256Hex, shareUrl, siteHost, siteUrl } from "./ids";

type AccountEnv = { Bindings: Env; Variables: { owner: OwnerCtx } };
type Ctx = Context<AccountEnv>;

const DAY_MS = 24 * 60 * 60 * 1000;

type Viewer = { ok: true; owner: OwnerCtx } | { ok: false; error: "forbidden" | "not invited"; email?: string };

async function accessEmail(req: Request, env: Env): Promise<string | null> {
  // DEV_MODE is only ever set in .dev.vars; there is no Access in front locally.
  if (env.DEV_MODE === "1") return normalizeEmail(env.DEV_ACCOUNT_EMAIL);
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCOUNT_ACCESS_AUD) return null;
  try {
    return normalizeEmail((await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCOUNT_ACCESS_AUD)).email);
  } catch {
    return null;
  }
}

async function viewer(req: Request, env: Env): Promise<Viewer> {
  const email = await accessEmail(req, env);
  if (!email) return { ok: false, error: "forbidden" };
  const found = await userForEmail(env.SITES, email, req.method !== "GET" && req.method !== "HEAD");
  return found ? { ok: true, owner: found } : { ok: false, error: "not invited", email };
}

// User sites on *.{apex} are same-site with this host, so SameSite cookies do
// not stop them from posting here. Only the dashboard's own origin may write.
function trustedOrigin(origin: string | null, env: Env): boolean {
  const host = `account.${env.APEX_HOST.toLowerCase()}`;
  if (origin === `https://${host}`) return true;
  if (env.DEV_MODE !== "1" || !origin) return false;
  const url = URL.canParse(origin) ? new URL(origin) : null;
  return url?.protocol === "http:" && ["localhost", "127.0.0.1", host].includes(url.hostname);
}

const expiresAt = (owner: OwnerCtx, lastDeployAt: number) => {
  const days = LIMITS[owner.user.plan].retentionDays;
  return days === null ? null : lastDeployAt + days * DAY_MS;
};

const assetUrl = (apex: string, username: string, id: string) =>
  `https://${apex}/a/${encodeURIComponent(username)}/${encodeURIComponent(id)}`;

async function requireSite(c: Ctx): Promise<{ siteId: string; meta: SiteMeta } | Response> {
  const siteId = sanitizeSiteId(c.req.query("id"));
  if (!siteId) return c.json({ error: "id required" }, 400);
  const meta = await getMeta(c.env.SITES, c.var.owner.username, siteId);
  if (!meta) return c.json({ error: "site not found" }, 404);
  return { siteId, meta };
}

const api = new Hono<AccountEnv>();

api.use("*", async (c, next) => {
  const v = await viewer(c.req.raw, c.env);
  if (!v.ok) return c.json({ error: v.error }, 403);
  c.set("owner", v.owner);
  c.header("cache-control", "no-store");
  await next();
});

api.get("/me", async (c) => {
  const { username, user } = c.var.owner;
  const apex = c.env.APEX_HOST;
  const sites = [];
  for await (const { siteId, meta } of siteRecords(c.env.SITES, username, user)) {
    sites.push({
      id: siteId,
      url: siteUrl(siteHost(username, siteId, apex)),
      public: meta.public,
      bytes: meta.bytes,
      fileCount: meta.fileCount,
      lastDeployAt: meta.lastDeployAt,
      expiresAt: expiresAt(c.var.owner, meta.lastDeployAt),
      takenDown: meta.tombstone ?? false,
    });
  }
  const assets = (await listAssetMetas(c.env.SITES, username)).map((a) => ({
    id: a.id,
    name: a.name,
    size: a.bytes,
    public: a.public,
    status: a.status,
    url: assetUrl(apex, username, a.id),
    expiresAt: expiresAt(c.var.owner, a.lastDeployAt),
  }));
  return c.json({ username, email: user.email, plan: user.plan, renamedFrom: user.renamedFrom, sites, assets });
});

api.post("/token", async (c) => {
  const { username, user } = c.var.owner;
  const token = generateOwnerToken();
  await putUser(c.env.SITES, username, { ...user, tokenHash: await sha256Hex(token) });
  const apex = c.env.APEX_HOST;
  return c.json({ username, token, credentialsFile: credentialsFile(apex), saveCommand: credentialsCommand(apex, username) });
});

api.post("/username", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: unknown };
  const result = await renameAccount(c.env.SITES, c.var.owner, body.username);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result, result.complete ? 200 : 202);
});

// Matches the apex /key/rotate, so old share links stop working.
api.post("/site/rotate", async (c) => {
  const site = await requireSite(c);
  if (site instanceof Response) return site;
  const { username } = c.var.owner;
  const accessKey = generateAccessKey();
  site.meta.keyHash = await sha256Hex(accessKey);
  site.meta.public = false;
  await putMeta(c.env.SITES, username, site.siteId, site.meta);
  const url = shareUrl(siteHost(username, site.siteId, c.env.APEX_HOST), accessKey);
  return c.json({ ok: true, accessKey, public: false, shareUrl: url });
});

api.post("/site/public", async (c) => {
  const site = await requireSite(c);
  if (site instanceof Response) return site;
  const body = (await c.req.json().catch(() => ({}))) as { public?: unknown };
  if (typeof body.public !== "boolean") return c.json({ error: "public must be a boolean" }, 400);
  site.meta.public = body.public;
  await putMeta(c.env.SITES, c.var.owner.username, site.siteId, site.meta);
  return c.json({ ok: true, public: body.public });
});

api.delete("/site", async (c) => {
  const site = await requireSite(c);
  if (site instanceof Response) return site;
  await deleteSite(c.env.SITES, c.var.owner.username, site.siteId);
  return c.json({ ok: true });
});

api.delete("/asset", async (c) => {
  const { username } = c.var.owner;
  const id = c.req.query("id");
  const meta = id ? await getAssetMeta(c.env.SITES, username, id) : null;
  if (!id || !meta) return c.json({ error: "asset not found" }, 404);
  await Promise.all([c.env.SITES.delete(meta.objectKey), c.env.SITES.delete(assetMetaKey(username, id))]);
  return c.json({ ok: true });
});

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const notInvitedHtml = (email: string, apex: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not invited · ${escapeHtml(apex)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0c10;color:#e8edf2;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}main{max-width:420px;padding:28px;background:#14181f;border:1px solid #232a33;border-radius:14px}h1{font-size:19px;margin:0 0 10px}p{color:#8c97a3;margin:0}b{color:#e8edf2}</style>
</head><body><main><h1>Not invited</h1><p><b>${escapeHtml(email)}</b> has no ${escapeHtml(apex)} account. Publishing is invite-only; ask the operator of this instance for an invite.</p></main></body></html>`;

const app = new Hono<AccountEnv>();

app.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  if (!trustedOrigin(c.req.header("origin") ?? null, c.env)) return c.json({ error: "cross-origin request rejected" }, 403);
  await next();
});

app.route("/account/api", api);

// Everything else is the dashboard SPA, served from Static Assets under /account/.
app.all("*", async (c) => {
  if (c.req.path.startsWith("/account/api")) return c.json({ error: "not found" }, 404);
  const v = await viewer(c.req.raw, c.env);
  if (!v.ok) {
    return v.error === "not invited"
      ? c.html(notInvitedHtml(v.email!, c.env.APEX_HOST), 403, { "cache-control": "no-store" })
      : c.text("forbidden", 403);
  }
  const fetchAsset = (pathname: string) => {
    const u = new URL(c.req.url);
    u.pathname = pathname;
    return c.env.ASSETS.fetch(new Request(u.toString(), { method: "GET" }));
  };
  const res = await fetchAsset(c.req.path === "/" ? "/account/index.html" : `/account${c.req.path}`);
  return res.status === 404 ? fetchAsset("/account/index.html") : res;
});

export const handleAccount = async (req: Request, env: Env): Promise<Response> => app.fetch(req, env);
