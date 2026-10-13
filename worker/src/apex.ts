import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { handlePublish } from "./publish";
import { verifyOwner, type OwnerCtx } from "./auth";
import { getMeta, putMeta, type SiteMeta } from "./storage";
import { sanitizeSiteId } from "./ids";
import { listShares, rotateSiteShare } from "./shares";
import { llmsTxt } from "./llms";
import { renderTemplate, skillName, skillRoutes, skillVars } from "./skill";
import { completeAsset, createAsset, deleteAsset, rotateAsset, serveAsset } from "./assets";

type Ctx = Context<{ Bindings: Env }>;

async function requireOwner(c: Ctx): Promise<OwnerCtx | Response> {
  const owner = await verifyOwner(c.req.raw, c.env);
  return owner.ok ? owner.ctx : c.json({ error: owner.error }, owner.status);
}

async function requireSite(c: Ctx, username: string): Promise<{ siteId: string; meta: SiteMeta } | Response> {
  const siteId = sanitizeSiteId(c.req.query("id"));
  if (!siteId) return c.json({ error: "id required" }, 400);
  const meta = await getMeta(c.env.SITES, username, siteId);
  if (!meta) return c.json({ error: "site not found" }, 404);
  return { siteId, meta };
}

const noStore: MiddlewareHandler = async (c, next) => {
  c.header("cache-control", "no-store");
  await next();
};

// Tolerates an empty/non-JSON body.
async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const app = new Hono<{ Bindings: Env }>();

app.post("/publish", (c) => handlePublish(c.req.raw, c.env));

// Large binary assets use a two-step control flow around a direct R2 PUT. The
// share page is served here, but neither uploads nor downloads cross the Worker.
app.post("/asset", createAsset);
app.post("/a/:username/:id/complete", completeAsset);
app.post("/a/:username/:id/rotate", noStore, rotateAsset);
app.delete("/a/:username/:id", deleteAsset);
app.get("/a/:username/:id", serveAsset);

app.get("/shares", noStore, async (c) => {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  return c.json(await listShares(c.env.SITES, owner, c.env.APEX_HOST));
});

app.post("/key/rotate", noStore, async (c) => {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const siteId = sanitizeSiteId(c.req.query("id"));
  if (!siteId) return c.json({ error: "id required" }, 400);
  const rotated = await rotateSiteShare(c.env.SITES, owner, siteId, c.env.APEX_HOST);
  return rotated ? c.json(rotated) : c.json({ error: "site not found" }, 404);
});

app.post("/key/public", async (c) => {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const site = await requireSite(c, owner.username);
  if (site instanceof Response) return site;

  const makePublic = ((await readBody(c)).public as boolean | undefined) ?? c.req.query("public") !== "false";
  site.meta.public = makePublic;
  await putMeta(c.env.SITES, owner.username, site.siteId, site.meta);
  return c.json({ ok: true, public: makePublic });
});

const DOC_CACHE = "public, max-age=3600";

app.get("/llms.txt", (c) =>
  c.body(llmsTxt(c.env.APEX_HOST), 200, { "content-type": "text/plain; charset=utf-8", "cache-control": DOC_CACHE }),
);

for (const [path, { template, contentType }] of Object.entries(skillRoutes)) {
  app.get(path, (c) => {
    const name = skillName(c.env);
    if (!name.ok) return c.json({ error: name.error }, 500);
    const body = renderTemplate(template, skillVars(c.env.APEX_HOST, name.name));
    return c.body(body, 200, { "content-type": contentType, "cache-control": DOC_CACHE });
  });
}

// Unmatched paths → Static Assets (the landing page). Registered as the Hono
// notFound handler so route handlers can return real 404s without being
// swallowed by the fallthrough.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export const apexApp = app;
