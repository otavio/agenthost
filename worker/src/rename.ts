// Self-service username change from the account dashboard. The username is part
// of every site host and R2 key, so a rename moves storage. One request moves at
// most RENAME_BATCH objects and answers complete: false until nothing is left;
// the dashboard repeats the same request. Every step is safe to repeat: copies
// overwrite, deleting a missing key succeeds, and the target record carries
// renamedFrom until the last step.

import type { OwnerCtx } from "./auth";
import { isValidUsername } from "./ids";
import {
  deleteKeys,
  getDomain,
  getUser,
  indexedJson,
  mapBounded,
  putAssetMeta,
  putDomain,
  putUser,
  userAssetsPrefix,
  userKey,
  userSitesPrefix,
  type AssetMeta,
  type MetadataListOptions,
  type UserRecord,
} from "./storage";

// Workers Free allows 50 subrequests per invocation. Each object costs a GET and
// a PUT, and the rest of the request needs about 20.
const RENAME_BATCH = 12;

export type RenameResult =
  | { ok: false; status: 400 | 409; error: string }
  | { ok: true; username: string; complete: boolean };

// putUser's encoding plus put-if-absent, so two users cannot both claim a name.
async function claimUsername(b: R2Bucket, username: string, rec: UserRecord): Promise<boolean> {
  const json = JSON.stringify(rec);
  const inline = new TextEncoder().encode(json).byteLength <= 6000;
  const put = await b.put(userKey(username), inline ? "" : json, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: inline ? { json } : {},
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return put !== null;
}

async function copyObject(b: R2Bucket, from: R2Object, key: string): Promise<void> {
  const obj = await b.get(from.key);
  if (obj) await b.put(key, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
}

// Asset blobs stay at their immutable keys; only the metadata moves.
async function copyAssetEntry(b: R2Bucket, from: R2Object, key: string, to: string): Promise<void> {
  const meta = from.key.endsWith("/_meta") ? await indexedJson<AssetMeta>(b, from) : null;
  if (meta) await putAssetMeta(b, to, meta.id, { ...meta, username: to });
  else await copyObject(b, from, key);
}

const MOVES: { prefix: (u: string) => string; copy: (b: R2Bucket, from: R2Object, key: string, to: string) => Promise<void> }[] = [
  { prefix: userSitesPrefix, copy: copyObject },
  { prefix: (u) => `_sites/${u}/`, copy: copyObject },
  { prefix: userAssetsPrefix, copy: copyAssetEntry },
];

async function movePage(b: R2Bucket, move: (typeof MOVES)[number], from: string, to: string, limit: number): Promise<number> {
  const src = move.prefix(from);
  const page = await b.list({ prefix: src, limit, include: ["customMetadata"] } as MetadataListOptions);
  await mapBounded(page.objects, (o) => move.copy(b, o, move.prefix(to) + o.key.slice(src.length), to));
  await deleteKeys(b, page.objects.map((o) => o.key));
  return page.objects.length;
}

export async function renameAccount(b: R2Bucket, owner: OwnerCtx, raw: unknown): Promise<RenameResult> {
  const to = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!isValidUsername(to)) return { ok: false, status: 400, error: "username must be 2-30 lowercase letters or digits, and not reserved" };
  const { username: current, user } = owner;

  let from: string;
  if (user.renamedFrom) {
    if (to !== current) return { ok: false, status: 409, error: `finish the rename to ${current} first` };
    from = user.renamedFrom;
  } else {
    if (to === current) return { ok: false, status: 400, error: "that is already your username" };
    from = current;
    if (!(await claimUsername(b, to, { ...user, renamedFrom: from }))) {
      // A concurrent request from this user (a double click) may hold the claim.
      const holder = await getUser(b, to);
      if (holder?.email !== user.email || holder?.renamedFrom !== from) return { ok: false, status: 409, error: "username taken" };
    }
  }

  // Data under `from` is ours only while _users/{from} is. It is deleted last, so
  // a missing or foreign record means an earlier attempt already moved everything.
  if ((await getUser(b, from))?.email === user.email) {
    let budget = RENAME_BATCH;
    for (const move of MOVES) {
      for (;;) {
        if (budget === 0) return { ok: true, username: to, complete: false };
        const moved = await movePage(b, move, from, to, budget);
        if (moved === 0) break;
        budget -= moved;
      }
    }
    const domain = user.customDomain ? await getDomain(b, user.customDomain) : null;
    if (domain?.username === from) await putDomain(b, user.customDomain!, { ...domain, username: to });
    await b.delete(userKey(from));
  }

  const target = await getUser(b, to);
  if (target?.renamedFrom) {
    const done = { ...target };
    delete done.renamedFrom;
    await putUser(b, to, done);
  }
  return { ok: true, username: to, complete: true };
}
