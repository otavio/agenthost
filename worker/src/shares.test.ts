import { describe, expect, it } from "vitest";
import { apexApp } from "./apex";
import { sha256Hex } from "./ids";
import { getAssetMeta, getMeta, type AssetMeta, type SiteMeta } from "./storage";
import { testBucket } from "./test-bucket";
import type { Env } from "./env";

const DAY_MS = 24 * 60 * 60 * 1000;
const alice = { authorization: "Bearer alice-token", "x-agenthost-user": "alice" };
const bob = { authorization: "Bearer bob-token", "x-agenthost-user": "bob" };

const site = (over: Partial<SiteMeta> = {}): SiteMeta => ({
  generation: 3, createdAt: 1, lastDeployAt: 1000, bytes: 10, fileCount: 2, keyHash: "a".repeat(64), public: false, ...over,
});
const asset = async (username: string, id: string, over: Partial<AssetMeta> = {}): Promise<AssetMeta> => ({
  id, username, name: `${id}.mp4`, contentType: "video/mp4", bytes: 3, objectKey: `assets/${username}/${id}/blob`,
  keyHash: await sha256Hex(`old-${id}`), public: false, status: "ready", createdAt: 5, lastDeployAt: 2000, readyAt: 6, ...over,
});

async function fixture() {
  const oneRecordPerPage = 1;
  const f = testBucket(oneRecordPerPage);
  f.json("_users/alice", { tokenHash: await sha256Hex("alice-token"), plan: "free", createdAt: 0, legacySiteIds: ["old"] }, true);
  f.json("_users/bob", { tokenHash: await sha256Hex("bob-token"), plan: "paid", createdAt: 0, legacySiteIds: [] }, true);
  f.json("_sites/alice/docs", site(), true);
  f.json("_sites/alice/gone", site({ public: true, tombstone: true }), true);
  f.json("sites/alice/old/_meta", site({ generation: undefined, public: true, bytes: 7, fileCount: 1, lastDeployAt: 500 }));
  f.json("_assets/alice/vid/_meta", await asset("alice", "vid"), true);
  f.json("_assets/alice/up/_meta", await asset("alice", "up", { status: "pending", public: true, readyAt: undefined }), true);
  f.json("_sites/bob/docs", site(), true);
  f.json("_assets/bob/vid/_meta", await asset("bob", "vid"), true);
  f.records.set("assets/alice/vid/blob", { body: "abc" });
  const env = {
    ...f.env,
    ACCESS_LIMITER: { limit: async () => ({ success: true }) },
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_BUCKET_NAME: "assets-bucket",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
  } as unknown as Env;
  const call = (path: string, method = "GET", headers: Record<string, string> = alice) =>
    apexApp.fetch(new Request(`https://example.com${path}`, { method, headers }), env);
  const visit = (path: string, cookie?: string) =>
    apexApp.fetch(new Request(`https://example.com${path}`, { headers: cookie ? { cookie } : {} }), env);
  const raw = (key: string) => JSON.stringify(f.records.get(key));
  return { ...f, call, visit, raw };
}

describe("GET /shares", () => {
  it("lists every site and asset the owner has, private ones included, without secrets", async () => {
    const f = await fixture();
    const res = await f.call("/shares");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      username: "alice",
      sites: [
        { id: "docs", url: "https://alice-docs.example.com/", public: false, bytes: 10, fileCount: 2, lastDeployAt: 1000, expiresAt: 1000 + 15 * DAY_MS, takenDown: false },
        { id: "gone", url: "https://alice-gone.example.com/", public: true, bytes: 10, fileCount: 2, lastDeployAt: 1000, expiresAt: 1000 + 15 * DAY_MS, takenDown: true },
        { id: "old", url: "https://alice-old.example.com/", public: true, bytes: 7, fileCount: 1, lastDeployAt: 500, expiresAt: 500 + 15 * DAY_MS, takenDown: false },
      ],
      assets: [
        { id: "up", name: "up.mp4", size: 3, public: true, status: "pending", url: "https://example.com/a/alice/up", expiresAt: 2000 + 15 * DAY_MS },
        { id: "vid", name: "vid.mp4", size: 3, public: false, status: "ready", url: "https://example.com/a/alice/vid", expiresAt: 2000 + 15 * DAY_MS },
      ],
    });
    expect(text).not.toMatch(/keyHash|objectKey|tokenHash|[0-9a-f]{64}/);
  });

  it("lists only the caller's own shares", async () => {
    const f = await fixture();
    expect(await (await f.call("/shares", "GET", bob)).json()).toEqual({
      username: "bob",
      sites: [{ id: "docs", url: "https://bob-docs.example.com/", public: false, bytes: 10, fileCount: 2, lastDeployAt: 1000, expiresAt: null, takenDown: false }],
      assets: [{ id: "vid", name: "vid.mp4", size: 3, public: false, status: "ready", url: "https://example.com/a/bob/vid", expiresAt: null }],
    });
  });

  it("accepts the username as a query parameter", async () => {
    const f = await fixture();
    const res = await f.call("/shares?username=bob", "GET", { authorization: "Bearer bob-token" });
    expect(((await res.json()) as { username: string }).username).toBe("bob");
  });

  it("rejects missing or wrong credentials without caching the denial", async () => {
    const f = await fixture();
    const cases: [Record<string, string>, number, string][] = [
      [{}, 401, "Bearer token requires ?username=<your-username>"],
      [{ authorization: "Bearer alice-token" }, 401, "Bearer token requires ?username=<your-username>"],
      [{ ...alice, authorization: "Bearer bob-token" }, 403, "invalid username or owner token"],
    ];
    for (const [headers, status, error] of cases) {
      const res = await f.call("/shares", "GET", headers);
      expect([res.status, res.headers.get("cache-control"), await res.json()]).toEqual([status, "no-store", { error }]);
    }
  });
});

describe("POST /a/:username/:id/rotate", () => {
  it("replaces the asset key so only the new link and cookie open it", async () => {
    const f = await fixture();
    const before = (await getAssetMeta(f.bucket, "alice", "vid"))!;
    const users = [f.raw("_users/alice"), f.raw("_users/bob")];
    const others = [f.raw("_assets/alice/up/_meta"), f.raw("_assets/bob/vid/_meta"), f.raw("_sites/alice/docs")];

    const res = await f.call("/a/alice/vid/rotate", "POST");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { accessKey: string };
    expect(body).toEqual({ ok: true, accessKey: body.accessKey, public: false, shareUrl: `https://example.com/a/alice/vid?k=${body.accessKey}` });
    expect(body.accessKey).toMatch(/^[a-z2-9]{10}$/);

    expect(await getAssetMeta(f.bucket, "alice", "vid")).toEqual({ ...before, keyHash: await sha256Hex(body.accessKey) });
    expect([f.raw("_users/alice"), f.raw("_users/bob")]).toEqual(users);
    expect([f.raw("_assets/alice/up/_meta"), f.raw("_assets/bob/vid/_meta"), f.raw("_sites/alice/docs")]).toEqual(others);

    expect((await f.visit("/a/alice/vid?k=old-vid")).status).toBe(401);
    expect((await f.visit("/a/alice/vid", "aa_auth_vid=old-vid")).status).toBe(401);
    const opened = await f.visit(`/a/alice/vid?k=${body.accessKey}`);
    expect(opened.status).toBe(302);
    expect(opened.headers.get("set-cookie")).toContain(`aa_auth_vid=${body.accessKey};`);
    expect((await f.visit("/a/alice/vid", `aa_auth_vid=${body.accessKey}`)).status).toBe(200);
  });

  it("makes a public pending upload private and leaves it pending", async () => {
    const f = await fixture();
    const before = (await getAssetMeta(f.bucket, "alice", "up"))!;
    expect((await f.visit("/a/alice/up")).status).toBe(425);

    const { accessKey } = (await (await f.call("/a/alice/up/rotate", "POST")).json()) as { accessKey: string };
    expect(await getAssetMeta(f.bucket, "alice", "up")).toEqual({ ...before, keyHash: await sha256Hex(accessKey), public: false });
    expect((await f.visit("/a/alice/up")).status).toBe(401);
    expect((await f.visit("/a/alice/up", `aa_auth_up=${accessKey}`)).status).toBe(425);
  });

  it("answers 404 for another owner's asset or a missing one and changes nothing", async () => {
    const f = await fixture();
    const bobAsset = f.raw("_assets/bob/vid/_meta");
    for (const path of ["/a/bob/vid/rotate", "/a/alice/nope/rotate"]) {
      const res = await f.call(path, "POST");
      expect([res.status, res.headers.get("cache-control"), await res.json()]).toEqual([404, "no-store", { error: "asset not found" }]);
    }
    expect(f.raw("_assets/bob/vid/_meta")).toBe(bobAsset);
  });

  it("rejects a caller without credentials", async () => {
    const f = await fixture();
    const res = await f.call("/a/alice/vid/rotate", "POST", {});
    expect([res.status, res.headers.get("cache-control")]).toEqual([401, "no-store"]);
    expect(await getAssetMeta(f.bucket, "alice", "vid")).toEqual(await asset("alice", "vid"));
  });
});

describe("POST /key/rotate", () => {
  it("makes a public legacy site private in place and keeps its other fields", async () => {
    const f = await fixture();
    const before = (await getMeta(f.bucket, "alice", "old"))!;
    const res = await f.call("/key/rotate?id=old", "POST");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { accessKey: string };
    expect(body).toEqual({ ok: true, accessKey: body.accessKey, public: false, shareUrl: `https://alice-old.example.com/?k=${body.accessKey}` });
    expect(await getMeta(f.bucket, "alice", "old")).toEqual({ ...before, keyHash: await sha256Hex(body.accessKey), public: false });
    expect(f.records.has("_sites/alice/old")).toBe(false);
  });

  it("keeps a taken-down site taken down", async () => {
    const f = await fixture();
    const { accessKey } = (await (await f.call("/key/rotate?id=gone", "POST")).json()) as { accessKey: string };
    expect(await getMeta(f.bucket, "alice", "gone")).toEqual(site({ tombstone: true, keyHash: await sha256Hex(accessKey) }));
  });

  it("rejects a wrong token and a missing site without caching", async () => {
    const f = await fixture();
    const res = await f.call("/key/rotate?id=docs", "POST", { ...bob, "x-agenthost-user": "alice" });
    expect([res.status, res.headers.get("cache-control")]).toEqual([403, "no-store"]);
    const missing = await f.call("/key/rotate?id=nope", "POST");
    expect([missing.status, missing.headers.get("cache-control"), await missing.json()]).toEqual([404, "no-store", { error: "site not found" }]);
  });
});
