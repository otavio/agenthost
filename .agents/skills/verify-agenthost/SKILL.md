---
name: verify-agenthost
description: Launch an isolated local agenthost (Cloudflare Worker under wrangler dev with Miniflare R2) and prove behavior the way a user sees it, through the publish API with curl, hosted sites and share links in the preview browser, the admin console and the account dashboard. Use it to reproduce a bug, to confirm that a change to worker/, landing/, admin/ or account/ works in the real app, or to capture evidence for a PR.
---

# Verify agenthost

agenthost is one Cloudflare Worker that routes by `Host`:

- **Apex (control plane):** the landing page, `POST /publish`, the owner API (`/key/*`, `/asset`) and `/llms.txt`. Publishing is invite-only, so every publish needs an owner token.
- **Hosted sites:** served at `{username}-{siteId}.{apex}`, private behind an access key unless made public.
- **Admin console:** a Svelte SPA plus `/admin/api/*` at `admin.{apex}`. It invites users by email.
- **Account dashboard:** a Svelte SPA plus `/account/api/*` at `account.{apex}`. An invited user generates an agent token and manages their sites there. Locally the signed-in email is `DEV_ACCOUNT_EMAIL`, which `launch.sh` sets from `ACCOUNT_EMAIL` (default `owner@example.com`).

Users touch it two ways. Agents publish with `curl`, and people open share links in a browser. Drive both.

The helpers in `scripts/` run from the repo root and need `direnv` (the Nix dev shell supplies Node, pnpm and wrangler). Read [`features/README.md`](features/README.md) before you drive anything. It is the maintained map of what to verify and how.

## Launch

```bash
RUN=$(.agents/skills/verify-agenthost/scripts/launch.sh)   # or: launch.sh /tmp/verify-agenthost/<name>
. "$RUN/env"    # PORT, BASE=http://127.0.0.1:$PORT, APEX=localhost, PID, ROOT
```

`launch.sh` does the following:

- Installs dependencies if `node_modules/` is missing.
- Builds landing, admin and the worker's client bundle into `public/` and `worker/src/client/gen/`. `SKIP_BUILD=1` skips this when nothing under `landing/`, `admin/` or `worker/src/client/` changed since the last build.
- Starts `wrangler dev --local` on a free port, with its own `--persist-to "$RUN/state"`. Every run starts with an empty R2 bucket, and a run never touches the user's `.wrangler/state` or another run's.
- Waits until `/llms.txt` answers with the apex baked in. That is "ready". It took about 2 s after the build.

The launch differs from `pnpm dev` in three deliberate ways:

- **Routes.** It uses a generated config, `$RUN/wrangler.json` (from `scripts/verify-config.mjs`), with `routes` removed. With routes present, wrangler dev rewrites every request's `Host` to `agenthost.page`, so sites and admin are unreachable.
- **Apex.** `APEX_HOST=localhost`, so sites live at `http://<user>-<site>.localhost:$PORT/` and admin at `http://admin.localhost:$PORT/`. `*.localhost` resolves to loopback in the preview browser and in curl, and browsers treat it as a secure context, so the `Secure` access cookie works over plain http.
- **Variables.** `DEV_MODE=1` is passed with `--var`. The user's `worker/.dev.vars` is not loaded, so real R2 credentials never reach a verification run.

Several runs can go side by side because each has its own port, state and log. Don't drive an instance you didn't launch, including the user's `pnpm dev` on 8787.

## Doctor

```bash
.agents/skills/verify-agenthost/scripts/doctor.sh "$RUN"
```

The doctor is read-only. It checks that:

- the process group is alive;
- the port is held by the workerd of this run;
- `/llms.txt` names `localhost`;
- the landing page is served (assets built);
- the admin API answers without Cloudflare Access (DEV_MODE on);
- the worker client bundle exists.

Any `FAIL` means the instance isn't worth driving. Run cleanup, then launch again. Run the doctor first whenever a result looks wrong.

## Drive

**HTTP (agent surface).** The API returns `https://<host>/…` URLs with no port. Map them onto the instance with:

```bash
.agents/skills/verify-agenthost/scripts/local-url.sh "$RUN" "$(jq -r .shareUrl pub.json)"
# → http://<user>-<site>.localhost:$PORT/?k=<key>
```

Core calls, with real routes from `worker/src/apex.ts` and `worker/src/admin.ts`:

```bash
curl -s -H "Host: admin.localhost" -H 'content-type: application/json' -d '{"email":"owner@example.com"}' "$BASE/admin/api/users"  # invite; set U to the returned username
TOKEN=$(curl -s -X POST -H "Host: account.localhost" -H "Origin: http://account.localhost:$PORT" "$BASE/account/api/token" | jq -r .token)
printf '<!doctype html><h1>hi</h1>' | curl -s --data-binary @- -H "Authorization: Bearer $TOKEN" "$BASE/publish?id=demo&username=$U" > pub.json
tar cf - -C ./dir . | curl -s --data-binary @- -H "Authorization: Bearer $TOKEN" "$BASE/publish?id=docs&username=$U"  # redeploy
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/key/rotate?username=$U&id=demo"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/key/public?username=$U&id=demo" -d '{"public":true}'
curl -s -H "Host: admin.localhost" "$BASE/admin/api/sites?username=$U"
```

**Browser (human surface).** Use the `preview_*` tools on the mapped URL. Open with `reuseExistingTab: false` and `open: false` unless the user should watch, and keep the returned `tabId` for every later call.

- `preview_open {url: "http://<user>-<site>.localhost:$PORT/?k=<key>"}`: the server answers 302 with `Set-Cookie: as_auth_<siteId>=…`, and the tab lands on the clean URL.
- `preview_snapshot`: read the accessibility tree. Target elements with `aria-ref` from the snapshot, or by role and name, for example the `Share` button that every hosted HTML page gets, or the `Copy` button on rendered markdown.
- Admin console: `preview_open {url: "http://admin.localhost:$PORT/"}`.

The feature files give the exact steps for each journey.

## Evidence

Write every artifact to `$RUN/evidence/`. Cleanup deletes `$RUN/state` (the R2 data) and keeps `$RUN/evidence/`, and it moves `wrangler.log` there too. Name files `<feature-id>-<step>.<ext>`.

Standards for a proof:

- **Use the real user path.** Publish through `POST /publish`, view through the share link and the site host, and use admin through `admin.localhost`. Never write into `$RUN/state` or call internal functions to set up a result.
- **Capture the action and the result.** For HTTP, save the request (command line) and the full response (`curl -s -D headers.txt -o body`), status code included. For the browser, save the `preview_snapshot` tree text, then call `preview_snapshot` with `save: true`, which returns only a `screenshotPath`, and copy that PNG into `$RUN/evidence/`.
- **Check side effects from a second view.** After a publish, the admin API or a second GET shows the stored site. After a key rotation, the old key gets 401 and the new key gets 302. After a takedown, the site returns 410.
- **No mocks.** Everything is local Miniflare already. The one external boundary is R2's S3 endpoint for large assets (see [`features/large-assets.md`](features/large-assets.md)).

## Cleanup

```bash
.agents/skills/verify-agenthost/scripts/cleanup.sh "$RUN"
```

Cleanup sends TERM, then KILL, to the process group `launch.sh` recorded. It never kills by process name. It warns if the port is still listening, then deletes `$RUN/state`, `$RUN/fixture` (the place for recipe fixtures), `$RUN/build.log`, `$RUN/wrangler.json`, `$RUN/.wrangler`, `$RUN/pid` and `$RUN/env`. `$RUN/evidence/` survives. Close any preview tabs you opened with `t3_preview_close`. Run cleanup after a failed attempt too.

The build writes `public/` and `worker/src/client/gen/`, which are gitignored build output shared with `pnpm dev`. Cleanup leaves them in place.

## Helpers

| Script | Use |
|---|---|
| `scripts/launch.sh [RUN_DIR]` | Build and start an isolated instance, then print `RUN_DIR`. Env: `SKIP_BUILD=1`, `APEX=<host>`. |
| `scripts/doctor.sh RUN_DIR` | Read-only health check. Exits non-zero on any `FAIL`. |
| `scripts/local-url.sh RUN_DIR URL` | Rewrite an API-returned `https://host/…` URL to `http://host:$PORT/…`. |
| `scripts/cleanup.sh RUN_DIR` | Stop the instance and delete its state, keeping the evidence. |
| `scripts/verify-config.mjs ROOT OUT` | Used by `launch.sh`. Writes `worker/wrangler.jsonc` minus `routes`, with absolute paths. |
