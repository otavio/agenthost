import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAccount } from "./account";
import { handleAdmin } from "./admin";
import { handlePublish } from "./publish";
import { getMeta, getUser, putAssetMeta } from "./storage";
import { sha256Hex } from "./ids";
import { testBucket } from "./test-bucket";
import type { Env } from "./env";

const NOW = Date.UTC(2026, 9, 1);
const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = "https://account.example.com";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(overrides: Partial<Env> = {}) {
  const f = testBucket();
  const env = {
    ...f.env,
    DEV_ACCOUNT_EMAIL: "ana@example.com",
    ASSETS: { fetch: async (req: Request) => new Response(`asset ${new URL(req.url).pathname}`) },
    ...overrides,
  } as Env;
  const account = (path: string, init: RequestInit = {}) => handleAccount(new Request(`https://account.example.com${path}`, init), env);
  const post = (path: string, body?: unknown, origin: string | null = ORIGIN) => account(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const invite = async (email: string) => {
    const res = await handleAdmin(new Request("https://admin.example.com/admin/api/users", {
      method: "POST", body: JSON.stringify({ email }), headers: { "content-type": "application/json" },
    }), f.env);
    return ((await res.json()) as { username: string }).username;
  };
  const token = async () => ((await (await post("/account/api/token")).json()) as { token: string }).token;
  const publish = (username: string, ownerToken: string, id = "docs") => handlePublish(new Request(`https://example.com/publish?username=${username}&id=${id}`, {
    method: "POST", body: "# Home", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "text/markdown" },
  }), env);
  const me = async () => (await account("/account/api/me")).json();
  return { ...f, env, account, post, invite, token, publish, me };
}

describe("account access", () => {
  it("answers an email without an invite with 403 on the API and a page on the UI", async () => {
    const f = fixture({ DEV_ACCOUNT_EMAIL: "stranger@example.com" });
    await f.invite("ana@example.com");
    const api = await f.account("/account/api/me");
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: "not invited" });
    const ui = await f.account("/");
    expect(ui.status).toBe(403);
    expect(await ui.text()).toContain("<b>stranger@example.com</b> has no example.com account");
  });

  it("fails closed outside dev mode when the Access JWT is missing", async () => {
    const f = fixture({ DEV_MODE: undefined, ACCESS_TEAM_DOMAIN: "team", ACCOUNT_ACCESS_AUD: "aud" });
    await f.invite("ana@example.com");
    const api = await f.account("/account/api/me");
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: "forbidden" });
    const ui = await f.account("/");
    expect(ui.status).toBe(403);
    expect(await ui.text()).toBe("forbidden");
  });

  it("serves the dashboard SPA to an invited user", async () => {
    const f = fixture();
    await f.invite("ana@example.com");
    expect(await (await f.account("/")).text()).toBe("asset /account/index.html");
    expect(await (await f.account("/assets/app.js")).text()).toBe("asset /account/assets/app.js");
  });
});

describe("account access through a signed Access JWT", () => {
  let keys: CryptoKeyPair;
  beforeAll(async () => {
    keys = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    ) as CryptoKeyPair;
  });

  const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  async function jwt(payload: Record<string, unknown>) {
    const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
    const unsigned = `${enc({ alg: "RS256", kid: "k1" })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${b64url(new Uint8Array(sig))}`;
  }
  async function signedFixture() {
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    vi.stubGlobal("fetch", async () => Response.json({ keys: [{ ...jwk, kid: "k1" }] }));
    return fixture({ DEV_MODE: undefined, ACCESS_TEAM_DOMAIN: "team", ACCOUNT_ACCESS_AUD: "account-aud" });
  }
  const claims = (aud: string) => ({ iss: "https://team.cloudflareaccess.com", aud: [aud], email: "Ana@Example.com", exp: NOW / 1000 + 60 });

  it("maps the verified email claim to the invited user", async () => {
    const f = await signedFixture();
    const username = await f.invite("ana@example.com");
    const res = await f.account("/account/api/me", { headers: { "cf-access-jwt-assertion": await jwt(claims("account-aud")) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username, email: "ana@example.com", plan: "free", sites: [], assets: [] });
  });

  it("rejects a token minted for another Access application", async () => {
    const f = await signedFixture();
    await f.invite("ana@example.com");
    const res = await f.account("/account/api/me", { headers: { "cf-access-jwt-assertion": await jwt(claims("admin-aud")) } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
});

describe("account CSRF guard", () => {
  it.each([
    ["a hosted site on the same apex", "https://ana1234-docs.example.com"],
    ["no Origin header", null],
  ])("rejects a write from %s and keeps the token", async (_label, origin) => {
    const f = fixture();
    const username = await f.invite("ana@example.com");
    const before = (await getUser(f.bucket, username))!.tokenHash;
    const res = await f.post("/account/api/token", undefined, origin);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-origin request rejected" });
    expect((await getUser(f.bucket, username))!.tokenHash).toBe(before);
  });

  it.each(["http://localhost:5173", "http://account.example.com:8787"])("accepts the dev origin %s in dev mode", async (origin) => {
    const f = fixture();
    await f.invite("ana@example.com");
    expect((await f.post("/account/api/token", undefined, origin)).status).toBe(200);
  });

  it("rejects a plain-http origin outside dev mode", async () => {
    const f = fixture({ DEV_MODE: undefined });
    const res = await f.post("/account/api/token", undefined, "http://account.example.com");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-origin request rejected" });
  });
});

describe("account dashboard API", () => {
  it("lists a published site with its free-plan expiry", async () => {
    const f = fixture();
    const username = await f.invite("ana@example.com");
    expect((await f.publish(username, await f.token())).status).toBe(200);
    expect(await f.me()).toEqual({
      username,
      email: "ana@example.com",
      plan: "free",
      sites: [{
        id: "docs",
        url: `https://${username}-docs.example.com/`,
        public: false,
        bytes: 6,
        fileCount: 1,
        lastDeployAt: NOW,
        expiresAt: NOW + 15 * DAY_MS,
        takenDown: false,
      }],
      assets: [],
    });
  });

  it("replaces the agent token so only the newest one publishes", async () => {
    const f = fixture();
    const username = await f.invite("ana@example.com");
    const first = await f.token();
    expect((await f.publish(username, first)).status).toBe(200);
    const second = await f.token();
    expect(second).not.toBe(first);
    const stale = await f.publish(username, first);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "invalid username or owner token" });
    expect((await f.publish(username, second)).status).toBe(200);
  });

  it("deletes a site and its files", async () => {
    const f = fixture();
    const username = await f.invite("ana@example.com");
    await f.publish(username, await f.token());
    const res = await f.account("/account/api/site?id=docs", { method: "DELETE", headers: { origin: ORIGIN } });
    expect(await res.json()).toEqual({ ok: true });
    expect([...f.records.keys()].filter((k) => k.includes(`/${username}/`))).toEqual([]);
    expect(((await f.me()) as { sites: unknown[] }).sites).toEqual([]);
  });

  it("rotates a share link and makes the site private", async () => {
    const f = fixture();
    const username = await f.invite("ana@example.com");
    await f.publish(username, await f.token());
    await f.post("/account/api/site/public?id=docs", { public: true });
    const res = await f.post("/account/api/site/rotate?id=docs");
    const body = (await res.json()) as { accessKey: string; shareUrl: string; public: boolean };
    expect(body.shareUrl).toBe(`https://${username}-docs.example.com/?k=${body.accessKey}`);
    expect(body.accessKey).toMatch(/^[a-z2-9]{10}$/);
    const meta = (await getMeta(f.bucket, username, "docs"))!;
    expect(meta.keyHash).toBe(await sha256Hex(body.accessKey));
    expect(meta.public).toBe(false);
  });

  it("toggles a site public and back", async () => {
    const f = fixture();
    const username = await f.invite("ana@example.com");
    await f.publish(username, await f.token());
    expect(await (await f.post("/account/api/site/public?id=docs", { public: true })).json()).toEqual({ ok: true, public: true });
    expect((await getMeta(f.bucket, username, "docs"))!.public).toBe(true);
    expect(await (await f.post("/account/api/site/public?id=docs", { public: false })).json()).toEqual({ ok: true, public: false });
    expect((await getMeta(f.bucket, username, "docs"))!.public).toBe(false);
    const bad = await f.post("/account/api/site/public?id=docs", { public: "yes" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "public must be a boolean" });
  });

  it("does not reach another user's site", async () => {
    const f = fixture();
    const other = await f.invite("bo@example.com");
    await f.invite("ana@example.com");
    f.json(`_sites/${other}/docs`, { generation: 1, createdAt: 0, lastDeployAt: 0, bytes: 1, fileCount: 1, keyHash: "x", public: false });
    const res = await f.account("/account/api/site?id=docs", { method: "DELETE", headers: { origin: ORIGIN } });
    expect(res.status).toBe(404);
    expect(f.records.has(`_sites/${other}/docs`)).toBe(true);
  });

  it("lists and deletes an uploaded file", async () => {
    const f = fixture();
    const username = await f.invite("ana@example.com");
    f.records.set(`assets/${username}/a1/blob`, { body: "bytes" });
    await putAssetMeta(f.bucket, username, "a1", {
      id: "a1", username, name: "report.pdf", contentType: "application/pdf", bytes: 5,
      objectKey: `assets/${username}/a1/blob`, keyHash: "x", public: false, status: "ready", createdAt: NOW, lastDeployAt: NOW,
    });
    expect(((await f.me()) as { assets: unknown[] }).assets).toEqual([{
      id: "a1", name: "report.pdf", size: 5, public: false, status: "ready",
      url: `https://example.com/a/${username}/a1`, expiresAt: NOW + 15 * DAY_MS,
    }]);
    const res = await f.account("/account/api/asset?id=a1", { method: "DELETE", headers: { origin: ORIGIN } });
    expect(await res.json()).toEqual({ ok: true });
    expect([...f.records.keys()].filter((k) => k.includes(`/${username}/`))).toEqual([]);
  });
});
