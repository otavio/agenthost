import { describe, expect, it } from "vitest";
import { handleAdmin } from "./admin";
import { getUser } from "./storage";
import { testBucket } from "./test-bucket";

function fixture() {
  const f = testBucket();
  const invite = (body: unknown) => handleAdmin(new Request("https://admin.example.com/admin/api/users", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), f.env);
  return { ...f, invite };
}

describe("admin invites", () => {
  it("creates a user keyed by a generated username with the lowercased email", async () => {
    const f = fixture();
    const res = await f.invite({ email: " Ana@Example.COM ", plan: "paid" });
    expect(res.status).toBe(201);
    const body = await res.json() as { username: string; email: string; plan: string };
    expect(body).toEqual({ username: expect.stringMatching(/^[a-z]+[0-9a-f]{4}$/), email: "ana@example.com", plan: "paid" });
    expect(await getUser(f.bucket, body.username)).toEqual({
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      email: "ana@example.com",
      legacySiteIds: [],
      plan: "paid",
      createdAt: expect.any(Number),
    });
  });

  it("defaults to the free plan", async () => {
    const f = fixture();
    const body = await (await f.invite({ email: "bo@example.com" })).json() as { plan: string };
    expect(body.plan).toBe("free");
  });

  it("rejects a second invite for the same email regardless of case", async () => {
    const f = fixture();
    expect((await f.invite({ email: "ana@example.com" })).status).toBe(201);
    const res = await f.invite({ email: "ANA@example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email already invited" });
    expect([...f.records.keys()].filter((k) => k.startsWith("_users/")).length).toBe(1);
  });

  it.each([[{}], [{ email: "not-an-email" }], [{ email: 42 }]])("rejects %j with 400", async (body) => {
    const f = fixture();
    const res = await f.invite(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "valid email required" });
    expect([...f.records.keys()]).toEqual([]);
  });

  it("rejects an unknown plan", async () => {
    const f = fixture();
    const res = await f.invite({ email: "ana@example.com", plan: "gold" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad plan" });
  });
});
