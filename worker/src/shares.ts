import type { OwnerCtx } from "./auth";
import { LIMITS } from "./config";
import { getAssetMeta, getMeta, listAssetMetas, putAssetMeta, putMeta, siteRecords } from "./storage";
import { assetUrl, generateAccessKey, sha256Hex, shareUrl, siteHost, siteUrl } from "./ids";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SiteShare {
  id: string;
  url: string;
  public: boolean;
  bytes: number;
  fileCount: number;
  lastDeployAt: number;
  expiresAt: number | null;
  takenDown: boolean;
}

export interface AssetShare {
  id: string;
  name: string;
  size: number;
  public: boolean;
  status: "pending" | "ready";
  url: string;
  expiresAt: number | null;
}

export interface Shares {
  username: string;
  sites: SiteShare[];
  assets: AssetShare[];
}

export interface RotatedShare {
  ok: true;
  accessKey: string;
  public: false;
  shareUrl: string;
}

const expiresAt = (owner: OwnerCtx, lastDeployAt: number) => {
  const days = LIMITS[owner.user.plan].retentionDays;
  return days === null ? null : lastDeployAt + days * DAY_MS;
};

export async function listShares(b: R2Bucket, owner: OwnerCtx, apex: string): Promise<Shares> {
  const { username, user } = owner;
  const sites: SiteShare[] = [];
  for await (const { siteId, meta } of siteRecords(b, username, user)) {
    sites.push({
      id: siteId,
      url: siteUrl(siteHost(username, siteId, apex)),
      public: meta.public,
      bytes: meta.bytes,
      fileCount: meta.fileCount,
      lastDeployAt: meta.lastDeployAt,
      expiresAt: expiresAt(owner, meta.lastDeployAt),
      takenDown: meta.tombstone ?? false,
    });
  }
  const assets = (await listAssetMetas(b, username)).map((a): AssetShare => ({
    id: a.id,
    name: a.name,
    size: a.bytes,
    public: a.public,
    status: a.status,
    url: assetUrl(apex, username, a.id),
    expiresAt: expiresAt(owner, a.lastDeployAt),
  }));
  return { username, sites, assets };
}

export async function rotateSiteShare(b: R2Bucket, owner: OwnerCtx, siteId: string, apex: string): Promise<RotatedShare | null> {
  const meta = await getMeta(b, owner.username, siteId);
  if (!meta) return null;
  const accessKey = generateAccessKey();
  await putMeta(b, owner.username, siteId, { ...meta, keyHash: await sha256Hex(accessKey), public: false });
  return { ok: true, accessKey, public: false, shareUrl: shareUrl(siteHost(owner.username, siteId, apex), accessKey) };
}

export async function rotateAssetShare(b: R2Bucket, owner: OwnerCtx, assetId: string, apex: string): Promise<RotatedShare | null> {
  const meta = await getAssetMeta(b, owner.username, assetId);
  if (!meta) return null;
  const accessKey = generateAccessKey();
  await putAssetMeta(b, owner.username, assetId, { ...meta, keyHash: await sha256Hex(accessKey), public: false });
  return { ok: true, accessKey, public: false, shareUrl: `${assetUrl(apex, owner.username, assetId)}?k=${accessKey}` };
}
