// Runs against workerd's R2 binding and Miniflare's R2 store, because the
// in-memory test bucket does not implement conditional puts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { handleAccount } from "./account";
import { getUser, putUser } from "./storage";
import type { Env } from "./env";

let bucket: R2Bucket;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc", persist: false });
  bucket = proxy.env.SITES;
  dispose = proxy.dispose;
}, 60_000);
afterAll(() => dispose?.());

const rename = (email: string, username: string) => handleAccount(new Request("https://account.example.com/account/api/username", {
  method: "POST", body: JSON.stringify({ username }), headers: { "content-type": "application/json", origin: "https://account.example.com" },
}), { SITES: bucket, DEV_MODE: "1", APEX_HOST: "example.com", DEV_ACCOUNT_EMAIL: email } as Env);

const invite = (username: string, email: string) => putUser(bucket, username, { tokenHash: "x", email, legacySiteIds: [], plan: "free", createdAt: 0 });

describe("R2 put-if-absent", () => {
  it("stores the first put and refuses the second", async () => {
    expect(await bucket.put("claim/a", "first", { onlyIf: { etagDoesNotMatch: "*" } })).not.toBeNull();
    expect(await bucket.put("claim/a", "second", { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();
    expect(await (await bucket.get("claim/a"))!.text()).toBe("first");
  });

  it("gives a contested username to exactly one of several racing users", async () => {
    for (let round = 0; round < 5; round++) {
      const users = Array.from({ length: 4 }, (_, i) => ({ username: `r${round}u${i}`, email: `r${round}u${i}@example.com` }));
      await Promise.all(users.map((u) => invite(u.username, u.email)));
      const statuses = await Promise.all(users.map((u) => rename(u.email, `prize${round}`).then((r) => r.status)));
      expect([...statuses].sort()).toEqual([200, 409, 409, 409]);
      const winner = users[statuses.indexOf(200)]!;
      expect((await getUser(bucket, `prize${round}`))!.email).toBe(winner.email);
      expect(await getUser(bucket, winner.username)).toBeNull();
    }
  });
});
