import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAccount } from "./account";
import { handleAdmin } from "./admin";
import { handlePublish } from "./publish";
import worker from "./index";
import { getAssetMeta, getDomain, getMeta, getUser, putAssetMeta } from "./storage";
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

// testBucket ignores onlyIf. Real R2 refuses a put with etagDoesNotMatch "*" when
// the key exists (rename.miniflare.test.ts checks that against workerd).
function putIfAbsent(f: ReturnType<typeof testBucket>) {
  const put = f.put.getMockImplementation()!;
  f.put.mockImplementation(async (key, body, opts) => {
    if ((opts?.onlyIf as R2Conditional | undefined)?.etagDoesNotMatch === "*") {
      if (f.records.has(key)) return null as never;
      f.records.set(key, { body: "" });
    }
    return put(key, body, opts);
  });
}

function fixture(overrides: Partial<Env> = {}) {
  const f = testBucket();
  putIfAbsent(f);
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
  const rename = (username: unknown, email = "ana@example.com") => handleAccount(new Request("https://account.example.com/account/api/username", {
    method: "POST", body: JSON.stringify({ username }), headers: { "content-type": "application/json", origin: ORIGIN },
  }), { ...env, DEV_ACCOUNT_EMAIL: email });
  const visit = (url: string) => worker.fetch(new Request(url), env, { waitUntil: () => {} } as unknown as ExecutionContext);
  const keysOf = (username: string) => [...f.records.keys()].filter((k) => k.split("/")[1] === username).sort();
  return { ...f, env, account, post, invite, token, publish, me, rename, visit, keysOf };
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

  it("returns the command that saves the token to the per-host credentials file", async () => {
    const f = fixture();
    const username = await f.invite("ana@example.com");
    const body = (await (await f.post("/account/api/token")).json()) as { username: string; token: string; credentialsFile: string; saveCommand: string };
    expect(body.username).toBe(username);
    expect(body.credentialsFile).toBe("~/.config/agenthost/example.com.curlrc");
    expect(body.saveCommand).toBe(
      `(f="$HOME/.config/agenthost/example.com.curlrc"; mkdir -p "\${f%/*}" && umask 077 || exit; u='${username}'; trap 'stty echo 2>/dev/null; exit 130' INT HUP TERM; stty -echo 2>/dev/null; printf 'example.com token (hidden): ' >&2; read -r t; stty echo 2>/dev/null; echo >&2; [ -n "$u" ] && [ -n "$t" ] || exit 1; printf 'header = "Authorization: Bearer %s"\\nheader = "x-agenthost-user: %s"\\n' "$t" "$u" > "$f" && chmod 600 "$f" && echo "Saved $f" >&2)`,
    );
    expect(body.saveCommand).not.toContain(body.token);
  });

  it("publishes with the saved headers alone, without ?username=", async () => {
    const f = fixture();
    const username = await f.invite("ana@example.com");
    const token = await f.token();
    const res = await handlePublish(new Request("https://example.com/publish?id=docs", {
      method: "POST", body: "# Home", headers: { authorization: `Bearer ${token}`, "x-agenthost-user": username },
    }), f.env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { username: string }).username).toBe(username);
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

describe("username change", () => {
  beforeEach(() => {
    vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
    vi.stubGlobal("HTMLRewriter", class { on() { return this; } transform(res: Response) { return res; } });
  });

  async function publishedAccount() {
    const f = fixture();
    const old = await f.invite("ana@example.com");
    const token = await f.token();
    expect((await f.publish(old, token, "docs")).status).toBe(200);
    expect((await f.publish(old, token, "notes")).status).toBe(200);
    await f.post("/account/api/site/public?id=docs", { public: true });
    return { f, old, token };
  }

  it("moves published sites to the new host and frees the old one", async () => {
    const { f, old } = await publishedAccount();
    const res = await f.rename("anabanana");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, username: "anabanana", complete: true });

    const moved = await f.visit("https://anabanana-docs.example.com/?raw");
    expect(moved.status).toBe(200);
    expect(await moved.text()).toBe("# Home");
    expect((await f.visit(`https://${old}-docs.example.com/?raw`)).status).toBe(404);
    expect(f.keysOf(old)).toEqual([]);
    expect(f.keysOf("anabanana")).toEqual([
      "_sites/anabanana/docs", "_sites/anabanana/notes", "_users/anabanana",
      "sites/anabanana/docs/README.md", "sites/anabanana/notes/README.md",
    ]);
    const me = (await f.me()) as { username: string; sites: { url: string }[] };
    expect(me.username).toBe("anabanana");
    expect(me.sites.map((s) => s.url)).toEqual(["https://anabanana-docs.example.com/", "https://anabanana-notes.example.com/"]);
  });

  it("keeps the agent token, which then publishes only under the new username", async () => {
    const { f, old, token } = await publishedAccount();
    await f.rename("anabanana");
    expect((await f.publish("anabanana", token, "docs")).status).toBe(200);
    const stale = await f.publish(old, token, "docs");
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "invalid username or owner token" });
  });

  it("moves uploaded file metadata and leaves the blob in place", async () => {
    const f = fixture();
    const old = await f.invite("ana@example.com");
    f.records.set(`assets/${old}/a1/blob`, { body: "bytes" });
    const asset = {
      id: "a1", username: old, name: "report.pdf", contentType: "application/pdf", bytes: 5,
      objectKey: `assets/${old}/a1/blob`, keyHash: "x", public: false, status: "ready" as const, createdAt: NOW, lastDeployAt: NOW,
    };
    await putAssetMeta(f.bucket, old, "a1", asset);
    await f.rename("anabanana");
    expect(await getAssetMeta(f.bucket, "anabanana", "a1")).toEqual({ ...asset, username: "anabanana" });
    expect(f.keysOf(old)).toEqual([`assets/${old}/a1/blob`]);
    expect(((await f.me()) as { assets: { url: string }[] }).assets.map((a) => a.url)).toEqual(["https://example.com/a/anabanana/a1"]);
  });

  it("repoints the custom domain at the new username", async () => {
    const { f, old } = await publishedAccount();
    await handleAdmin(new Request("https://admin.example.com/admin/api/domain", {
      method: "POST", body: JSON.stringify({ host: "docs.acme.test", username: old, siteId: "docs" }), headers: { "content-type": "application/json" },
    }), f.env);
    await f.rename("anabanana");
    expect(await getDomain(f.bucket, "docs.acme.test")).toEqual({ username: "anabanana", siteId: "docs" });
    expect(await (await f.visit("https://docs.acme.test/?raw")).text()).toBe("# Home");
  });

  it("lowercases and trims the requested name", async () => {
    const f = fixture();
    await f.invite("ana@example.com");
    expect(await (await f.rename("  AnaBanana ")).json()).toEqual({ ok: true, username: "anabanana", complete: true });
  });

  it.each([["admin"], ["a"], ["ana-b"], ["a".repeat(31)], ["ana_b"], [42]])("rejects %j with 400", async (name) => {
    const f = fixture();
    const old = await f.invite("ana@example.com");
    const res = await f.rename(name);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "username must be 2-30 lowercase letters or digits, and not reserved" });
    expect(f.keysOf(old)).toEqual([`_users/${old}`]);
  });

  it("rejects the current username with 400", async () => {
    const f = fixture();
    const old = await f.invite("ana@example.com");
    const res = await f.rename(old);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "that is already your username" });
  });

  it("refuses a name another user holds with 409 and changes nothing", async () => {
    const { f, old } = await publishedAccount();
    const bo = await f.invite("bo@example.com");
    expect((await f.rename("taken", "bo@example.com")).status).toBe(200);
    const before = new Map(f.records);
    const res = await f.rename("taken");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "username taken" });
    expect(f.records).toEqual(before);
    expect((await getUser(f.bucket, "taken"))!.email).toBe("bo@example.com");
    expect(f.keysOf(old)).toContain(`_users/${old}`);
    expect(f.keysOf(bo)).toEqual([]);
  });

  it("lets exactly one of two users racing for a name win", async () => {
    const f = fixture();
    await f.invite("ana@example.com");
    await f.invite("bo@example.com");
    const [ana, bo] = await Promise.all([f.rename("shared"), f.rename("shared", "bo@example.com")]);
    expect([ana.status, bo.status].sort()).toEqual([200, 409]);
    const winner = ana.status === 200 ? "ana@example.com" : "bo@example.com";
    expect((await getUser(f.bucket, "shared"))!.email).toBe(winner);
  });

  it("moves a large account over several requests that each report progress", async () => {
    const f = fixture();
    const old = await f.invite("ana@example.com");
    for (let i = 0; i < 20; i++) f.records.set(`sites/${old}/big/f${String(i).padStart(2, "0")}.txt`, { body: `file ${i}` });
    f.json(`_sites/${old}/big`, { generation: 1, createdAt: NOW, lastDeployAt: NOW, bytes: 140, fileCount: 20, keyHash: null, public: true });

    const first = await f.rename("anabanana");
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true, username: "anabanana", complete: false });
    const me = (await f.me()) as { username: string; renamedFrom?: string };
    expect([me.username, me.renamedFrom]).toEqual(["anabanana", old]);
    const elsewhere = await f.rename("other");
    expect(elsewhere.status).toBe(409);
    expect(await elsewhere.json()).toEqual({ error: "finish the rename to anabanana first" });

    expect(await (await f.rename("anabanana")).json()).toEqual({ ok: true, username: "anabanana", complete: true });
    expect(f.keysOf(old)).toEqual([]);
    expect(f.keysOf("anabanana")).toHaveLength(22);
    expect(await getUser(f.bucket, "anabanana")).not.toHaveProperty("renamedFrom");
    expect(await (await f.visit("https://anabanana-big.example.com/f19.txt")).text()).toBe("file 19");
  });

  it("converges when a retry follows a request that died mid-copy", async () => {
    const { f, old, token } = await publishedAccount();
    f.del.mockRejectedValueOnce(new Error("subrequest limit"));
    expect((await f.rename("anabanana")).status).toBe(500);
    expect((await getUser(f.bucket, "anabanana"))!.renamedFrom).toBe(old);
    expect((await getUser(f.bucket, old))!.email).toBe("ana@example.com");
    expect(((await f.me()) as { username: string }).username).toBe("anabanana");

    expect(await (await f.rename("anabanana")).json()).toEqual({ ok: true, username: "anabanana", complete: true });
    expect(f.keysOf(old)).toEqual([]);
    expect(await (await f.visit("https://anabanana-docs.example.com/?raw")).text()).toBe("# Home");
    expect((await f.publish("anabanana", token, "docs")).status).toBe(200);
  });

  it("finishes a rename whose source record was already deleted", async () => {
    const { f, old } = await publishedAccount();
    const user = (await getUser(f.bucket, old))!;
    f.json(`_users/anabanana`, { ...user, renamedFrom: old }, true);
    f.records.delete(`_users/${old}`);
    expect(await (await f.rename("anabanana")).json()).toEqual({ ok: true, username: "anabanana", complete: true });
    expect(await getUser(f.bucket, "anabanana")).toEqual(user);
  });
});
