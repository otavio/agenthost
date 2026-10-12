import { describe, expect, it } from "vitest";
import { apexApp } from "./apex";
import { getUser } from "./storage";
import { sha256Hex } from "./ids";
import { testBucket } from "./test-bucket";

function fixture() {
  const f = testBucket();
  const env = { ...f.env, ASSETS: { fetch: async () => new Response("landing 404", { status: 404 }) } };
  const fetch = (path: string, init?: RequestInit) => apexApp.fetch(new Request(`https://example.com${path}`, init), env);
  return { ...f, fetch };
}

describe("invite-only publishing", () => {
  it("rejects a publish without an owner token and creates no account", async () => {
    const f = fixture();
    const res = await f.fetch("/publish?id=docs", { method: "POST", body: "# Home", headers: { "content-type": "text/markdown" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "publishing is invite-only: sign in at https://account.example.com to get an agent token" });
    expect([...f.records.keys()]).toEqual([]);
  });

  it("no longer lets an owner token attach an email through /claim", async () => {
    const f = fixture();
    f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0, legacySiteIds: [] });
    const res = await f.fetch("/claim?username=alice", {
      method: "POST", body: JSON.stringify({ email: "mallory@example.com" }),
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
    expect(await getUser(f.bucket, "alice")).toEqual({ tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0, legacySiteIds: [] });
  });
});
