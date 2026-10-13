# agenthost HTTP API

The publish contract. Base URL: `https://{{apexHost}}`. Plain `curl` throughout.

## Authentication

Two secrets:

- **`ownerToken`**, the account credential. Publishing is invite-only. The human signs in at `https://account.{{apexHost}}`, generates the token there (shown once), and saves it on the agent's machine with the command shown next to it. Send it as `Authorization: Bearer <token>` on every publish and owner endpoint. Only its SHA-256 is stored. Generating a new one invalidates the old one.
- **`accessKey`**, the password gating one private site or asset. Returned by a site's first publish, by `POST /asset`, and by each rotate call. Embedded in `shareUrl` as `?k=<accessKey>`. Persists across redeploys. Only its SHA-256 is stored, so it cannot be listed or recovered. Rotating it does not change the `ownerToken`.

Authenticated requests also need the account `username`, as `?username=<name>` or the `x-agenthost-user` header. The skill keeps both headers in the curl config `{{credentialsFile}}` and passes it with `-K`, as every example below does. See [SKILL.md](../SKILL.md) for how that file gets written.

## POST /publish

Body is either a **tar** of a directory or a **single raw file**. No `Content-Type` header required.

| Param | Where | Notes |
|---|---|---|
| `id` | `?id=` or `x-agenthost-site` header | Subdomain label (`{username}-{id}.{{apexHost}}`). Generated if omitted. |
| `username` | `?username=` or `x-agenthost-user` header | Required. |
| `file` | `?file=` | Single-file mode: names the stored file (sanitized). Optional. |
| `Authorization: Bearer <ownerToken>` | header | Required. Without it the publish returns 401. |

**Body:**

- A tar (gzipped or not) → the site directory.
- Anything else → one document: Markdown as `README.md`, HTML as `index.html`. Both serve at `/`.
- Any other file type → send `?file=<name>`; the extension sets the served `Content-Type`.

Single-file publish replaces the whole site with that one file. `id` defaults to `site` when omitted. A zip body is rejected with 400; send a tar. Curl examples are in [SKILL.md](../SKILL.md).

### Response (200)

```jsonc
{
  "url":        "https://cleverotter4f2-myblog.{{apexHost}}/", // bare URL (prompts for the key)
  "shareUrl":   "https://cleverotter4f2-myblog.{{apexHost}}/?k=<accessKey>", // give THIS to a human
  "username":   "cleverotter4f2",      // account name (auto-generated, no hyphens)
  "siteId":     "myblog",
  "generation": 2,                     // deploy counter (cache versioning)
  "fileCount":  12,
  "bytes":      48213,
  "accessKey":  "<shown once — first publish only>"
}
```

`accessKey` is returned **only on a site's first publish**. Redeploys preserve it silently, and their `shareUrl` comes back bare (no `?k=`), identical to `url`.

## Direct asset upload

Large binary assets use a three-request control flow; the payload itself goes directly to R2.

1. **Initiate** — `POST /asset` with owner auth and JSON `{ "name": "video.mp4", "bytes": 757603783, "contentType": "video/mp4" }`.
2. **Upload** — `PUT` the file to the returned `uploadUrl`, sending every returned `uploadHeaders` value exactly. Send no owner auth (no `-K`), since a bearer token would leak to R2 and break the signature. The hostname is `*.r2.cloudflarestorage.com`; the Worker never receives the body.
3. **Complete** — `POST` the returned `completeUrl` with owner auth. Agenthost checks the R2 object size and marks the share page ready.

The initiate response carries `assetId`, `uploadUrl`, `uploadHeaders` (`content-length`, `content-type`, `content-disposition`), `uploadExpiresIn`, `completeUrl`, `url`, `shareUrl` and `accessKey`. The asset's `shareUrl` and `accessKey` exist **only** in that response, until `POST /a/:username/:assetId/rotate` replaces them; complete returns `{ ok, url, name, bytes }`. Opening the `shareUrl` shows the file name, type, size, and a **Download** button. The button targets a short-lived presigned R2 GET, so downloads also bypass the Worker. The object stores `Content-Disposition: attachment`, making browsers download instead of trying to render it.

The upload URL expires after 15 minutes and is restricted by its signature to one object, exact byte length, content type, and download filename. The download URL expires after five minutes and is generated whenever the share page opens.

| Asset limit | Free | Paid |
|---|---:|---:|
| Single asset | {{freePerAsset}} | {{paidPerAsset}} |
| Total account storage | {{freePerUser}}, shared with sites | {{paidPerUser}} |
| Retention | {{freeRetention}} | {{paidRetention}} |

Pending uploads are deleted after one day. `DELETE /a/:username/:assetId` with owner auth removes a completed or pending asset:

```bash
curl -s -K {{credentialsFile}} -X DELETE 'https://{{apexHost}}/a/<username>/<assetId>'
# → { "ok": true }
```

## Owner endpoints

All require `Authorization: Bearer <ownerToken>` + `username` (both in `{{credentialsFile}}`). `GET /shares` and the rotate calls answer with `Cache-Control: no-store`, errors included.

**`GET /shares`** lists every site and asset the account owns, including private, taken-down and pending ones. It changes nothing and returns bare URLs, never an access key.

```bash
curl -s -K {{credentialsFile}} 'https://{{apexHost}}/shares'
```

```jsonc
{
  "username": "cleverotter4f2",
  "sites": [
    {
      "id": "myblog",
      "url": "https://cleverotter4f2-myblog.{{apexHost}}/",
      "public": false,
      "bytes": 48213,
      "fileCount": 12,
      "lastDeployAt": 1760000000000,
      "expiresAt": 1761296000000, // null when the plan keeps sites without a limit
      "takenDown": false          // true when the operator took the site down; it answers 410
    }
  ],
  "assets": [
    {
      "id": "k7m2p4q8r9s3t5u6",
      "name": "demo.mp4",
      "size": 757603783,
      "public": false,
      "status": "ready",          // "pending" until complete succeeds; pending uploads are deleted after one day
      "url": "https://{{apexHost}}/a/cleverotter4f2/k7m2p4q8r9s3t5u6",
      "expiresAt": 1761296000000
    }
  ]
}
```

**`POST /key/public?id=<siteId>`** drops or restores the access gate.

```bash
curl -s -K {{credentialsFile}} -X POST 'https://{{apexHost}}/key/public?id=myblog&public=true'
# → { "ok": true, "public": true }
```

**`POST /key/rotate?id=<siteId>`** creates a new `accessKey`, invalidates the site's existing share links, and makes the site private.

```bash
curl -s -K {{credentialsFile}} -X POST 'https://{{apexHost}}/key/rotate?id=myblog'
# → { "ok": true, "accessKey": "<new key>", "public": false, "shareUrl": "…/?k=<new key>" }
```

**`POST /a/:username/:assetId/rotate`** does the same for one downloadable asset. `username` must be your own. A missing asset or another account's asset answers 404.

```bash
curl -s -K {{credentialsFile}} -X POST 'https://{{apexHost}}/a/cleverotter4f2/k7m2p4q8r9s3t5u6/rotate'
# → { "ok": true, "accessKey": "<new key>", "public": false, "shareUrl": "https://{{apexHost}}/a/cleverotter4f2/k7m2p4q8r9s3t5u6?k=<new key>" }
```

Each rotate call replaces the key, so a retry after a lost response stops the link from the first call. Do not retry rotate calls automatically. Old share links and browser cookies stop working at once. A download URL that a share page signed earlier stays valid for up to five minutes. Rotation keeps the item's other fields, such as `status` and `takenDown`, and never changes the `ownerToken`.

## Errors

JSON `{ "error": "<message>" }` with the status:

| Status | Cause |
|---|---|
| 400 | Empty body, nameless single file, archive with no files, unsafe path (`..`), or symlink/hardlink entry. |
| 401 | Missing Bearer token (publishing is invite-only), or missing `username` with a Bearer token. |
| 403 | Invalid username or owner token (indistinguishable — no enumeration). |
| 405 | Non-POST to `/publish`. |
| 404 | Site or asset not found, or the asset path names another account. |
| 413 | Over per-file cap, too many files, or over the size budget. |
| 429 | Rate limit exceeded (per IP). Back off and retry. |

## URL & path rules

- Served at `https://{username}-{id}.{{apexHost}}/…`; each site is its subdomain root.
- `username` is `[a-z0-9]`, 2–30 chars (**no hyphens** — it separates `{username}-{id}`).
- `siteId` is lowercased, sanitized to `[a-z0-9._-]`, ≤32 chars (so the label fits 63 chars).
- macOS cruft (`.DS_Store`, `._*`) and directory entries are skipped silently.
- Absolute (`/css/app.css`) and relative (`./css/app.css`) asset paths both work.
- All sites send `X-Robots-Tag: noindex, nofollow`.
- Open pages reload themselves when the site is republished (they poll `/_gen`, which is why `_gen` and `_meta` are reserved filenames). Add `<meta name="agenthost-live" content="off">` to an HTML page to opt out.

## Limits

| Limit | Free | Paid |
|---|---|---|
| Per file | {{freePerFile}} | {{paidPerFile}} |
| Files per site | {{freeFilesPerSite}} | {{paidFilesPerSite}} |
| Size per site | {{freePerSite}} | {{paidPerSite}} |
| Total per account | {{freePerUser}} | {{paidPerUser}} |
| Retention | {{freeRetention}} since last publish | {{paidRetention}} |

Caps are enforced *during* the upload stream, so an over-limit publish fails fast. The paid tier (custom username / domain) is operator-enabled, not self-serve.
