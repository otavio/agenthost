---
name: {{skillName}}
version: 0.5.0
description: "Publishes a page, docs or file with public or private access, lists what the account has shared, and regenerates the share link of one site or file. Use when a deliverable reads better as a page than as chat, or is too big to send, or when the human asks what they have shared or for a new share link."
metadata:
  homepage: https://{{apexHost}}
  hermes:
    category: publishing
    tags: [hosting, static-site, publish, share, docs]
  openclaw:
    emoji: "🚀"
    requires:
      bins: [curl, tar]
---

Publish a page, a folder or a set of Markdown docs, or upload a large file, and get back a link a human opens in one click. Sites can be public or private. It's plain `curl` and `tar` against `https://{{apexHost}}`, with nothing else to install.

## Install or update

```bash
curl -fsSL https://{{apexHost}}/skill/install.sh | sh
```

It saves the skill's files, `SKILL.md` and `references/http-api.md`, into `{{skillName}}/` under `~/.claude/skills` and `~/.agents/skills`, and rerunning it updates them. To install yourself instead, save each file from `https://{{apexHost}}/skill/<file>` as `<your skills dir>/{{skillName}}/<file>`, keeping the `references/` folder.

## Choose visibility

Choose visibility before a publish or upload. Listing shares and regenerating a share link do not need this step.

If the user has specified public or private access, use that choice. Otherwise, ask: "Should this be public or private?" Explain that public access needs no key, while private access needs the share link's key. Wait for the answer before publishing or uploading. You can prepare the artifact while you wait.

Downloadable assets uploaded through `/asset` support private access only. If the user wants one public, explain this limit before uploading. A file within the site limits can instead use `/publish?file=<name>` with public access.

## One account, saved in your home directory

Your account lives in `{{credentialsFile}}`, a curl config that every authenticated request below reads with `-K`. It holds the owner token for {{apexHost}}, so it is named after the host and stays in your home directory. Never copy it into the skill directory or a working tree, where a project-level install could get it committed.

Check for it with `test -f {{credentialsFile}}`, and never `cat` or print it.

- **It exists**: use it. A 403 after publishes that worked means the human generated a new token or changed their username. Ask them to set it up again as below.
- **It doesn't**: publishing is invite-only, and a publish without the file returns 401. Ask the human to sign in at `https://account.{{apexHost}}`, generate an agent token, and run the command shown there in a terminal on this machine. That command already names their username and prompts only for the token, with the input hidden, so the token never lands in chat or in shell history. This one does the same but prompts for the username too:

    ```bash
    {{credentialsCommand}}
    ```

- **You run in a remote or cloud sandbox** with no terminal they can reach: they may paste their username and token in chat. Save them with this command, in place of `OWNER_TOKEN` and `USERNAME`, and never echo the token back.

    ```bash
    {{writeCredentialsCommand}}
    ```

## Publish

`id` becomes the subdomain: `{username}-{id}.{{apexHost}}`. Same account + same `id` → same URL, content replaced. Leaving out `id` publishes to `site`, overwriting it.

```bash
curl -s -K {{credentialsFile}} --data-binary @report.md 'https://{{apexHost}}/publish?id=report'
```

What the body can be:

- **One `.md` or `.html`**: served at `/`, Markdown rendered. The type is sniffed from the bytes, so no `Content-Type` is needed.
- **A folder**: pipe a tar, `tar cf - -C ./dist . | curl -s --data-binary @- …`. Zip is rejected. A folder of `.md` becomes a docs site (sidebar, `README.md` as home, `SUMMARY.md` for order and nesting, GFM, mermaid, highlighted code).
- **Any other single file**: add `&file=<name>`; the extension sets the served type. It replaces the whole site.

Absolute (`/css/app.css`) and relative (`./css/app.css`) asset paths both resolve, since each site is its own subdomain root.

New sites start private. After publishing, set the chosen visibility with the returned `siteId` as `id`:

```bash
# Public access
curl -s -K {{credentialsFile}} -X POST 'https://{{apexHost}}/key/public?id=<siteId>&public=true'
# Private access
curl -s -K {{credentialsFile}} -X POST 'https://{{apexHost}}/key/public?id=<siteId>&public=false'
```

Check that the response reports `ok: true` and the chosen `public` value before sharing the URL. Redeploys preserve visibility. For a private redeploy of an existing site, set `public=false` before replacing its content.

## What to hand the human

For public sites, use the bare `url`. For private sites, use the complete `shareUrl` with its access key (`?k=…`), which logs the visitor in on first open. **The key is only returned on a site's first publish**: a redeploy returns a bare `shareUrl` that asks for a key. So record the link from the first publish of each `id` next to the deliverable, and give that same link again after private redeploys. Pages already open in a browser reload themselves when you republish.

If the link is lost, see "Find or regenerate a share link" below. The human can also use "New share link" for a site in the account dashboard.

After a successful publish or completed asset upload, with the chosen visibility in place, open the final URL in the user's browser. Use the available browser tool or system URL opener. If neither is available, state that you could not open it.

Return a clickable link and the complete URL in a fenced `text` code block so the user can copy it. For private links, keep the full `?k=…` value even if the browser redirects to a bare URL:

```text
https://<username>-<siteId>.{{apexHost}}/?k=<accessKey>
```

## Upload a downloadable asset

Use this for files that aren't a site (video, archive, dataset): up to {{freePerAsset}} on free, {{paidPerAsset}} on paid. It needs the credentials file. The bytes go straight to R2, never through agenthost.

```bash
# 1. initiate; bytes must be the exact file size
curl -s -K {{credentialsFile}} -H 'Content-Type: application/json' \
  --data '{"name":"demo.mp4","bytes":757603783,"contentType":"video/mp4"}' \
  'https://{{apexHost}}/asset'

# 2. within 15 min: PUT to uploadUrl with every uploadHeaders value verbatim, no -K
curl -s --upload-file demo.mp4 \
  -H 'content-type: <uploadHeaders.content-type>' \
  -H 'content-disposition: <uploadHeaders.content-disposition>' \
  '<uploadUrl>'

# 3. complete; expect {"ok":true}
curl -s -K {{credentialsFile}} -X POST '<completeUrl>'
```

Step 2 goes to R2, not to {{apexHost}}, so it must not use `-K`. That would send your owner token to R2 and break the upload's signature.

After step 3 succeeds, open and hand over the `shareUrl` from **step 1** as described above; completing doesn't repeat it.

## Find or regenerate a share link

Agenthost stores only a hash of each access key, so a lost key cannot be read back. If you recorded the link earlier, give that same link again.

List every site and asset the account owns, private ones included:

```bash
curl -s -K {{credentialsFile}} 'https://{{apexHost}}/shares'
```

The response has `username`, `sites` and `assets`. Each item has its bare `url` and `public`, and never a key. Listing changes nothing. A request to list shares or to get a link is not a request for a new key, so never regenerate one for it. Regenerating stops every earlier share link for that item.

To regenerate a link, first find the exact item in the list. For a site, match the URL's hostname against `sites[].url`. For an asset, match its origin and path against `assets[].url`. Ignore query parameters and fragments. Take `id` from that item and `username` from the response. A site's key covers all of its pages. Then run the call for its kind:

```bash
# Site
curl -s -K {{credentialsFile}} -X POST 'https://{{apexHost}}/key/rotate?id=<siteId>'
# Downloadable asset
curl -s -K {{credentialsFile}} -X POST 'https://{{apexHost}}/a/<username>/<assetId>/rotate'
```

When the human asks for a new link, that request is the permission. Do not ask again. The call makes a new access key and makes the item private. Every earlier link and browser cookie for that item stops working. A download link that a share page signed before the call stays valid for up to five minutes. Hand over the complete returned `shareUrl` as in "What to hand the human", and record it, because no later call returns this key.

Do not enable automatic retries for rotate calls. Each successful call replaces the key again. If the response is lost, the new key cannot be recovered. Another rotation is needed to get a usable link.

This changes the access key of one share link. It does not change the owner token in `{{credentialsFile}}`. Only the human generates a new owner token, in the account dashboard.

## Limits

- Free: {{freeFilesPerSite}} files, {{freePerFile}} per file, {{freePerSite}} per site, {{freePerUser}} per account (sites and assets combined). Free sites are deleted {{freeRetention}} after their last publish, so republish to keep one alive.
- `_gen` and `_meta` are reserved filenames.

Public sites, the share list, key rotation, deleting assets, every response field and error code: [references/http-api.md](references/http-api.md), also served at `https://{{apexHost}}/skill/references/http-api.md`.
