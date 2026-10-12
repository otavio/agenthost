# agenthost verification map

This directory is the maintained source for verifying agenthost's user-facing behavior. Read this index before you drive the app, then follow the matching feature file as the recipe.

## Baseline preconditions

- Start the instance with `RUN=$(.agents/skills/verify-agenthost/scripts/launch.sh)` and `. "$RUN/env"`.
- Every run starts from an empty R2 bucket in `$RUN/state`. The seed data is whatever the recipe publishes first.
- `.agents/skills/verify-agenthost/scripts/doctor.sh "$RUN"` prints only `ok` lines.
- The apex is `localhost`. Sites live at `http://<user>-<site>.localhost:$PORT/`, admin at `http://admin.localhost:$PORT/`, the account dashboard at `http://account.localhost:$PORT/`, and the control plane at `$BASE`.
- Publishing is invite-only. Before any publish, invite `owner@example.com` and get a token as described in [account-dashboard](./account-dashboard.md).
- Drive only an instance that this run launched.

## Driving conventions

- The agent surface is `curl` against `$BASE`. The human surface is the `preview_*` tools on the `*.localhost` URLs.
- Rewrite every URL the API returns with `scripts/local-url.sh "$RUN" <url>`. Never hand-edit the port.
- Keep `username` and `accessKey` from the publish response, and the token from the account dashboard, in `$RUN/evidence/<feature>-publish.json`. Later steps read them with `jq`.
- In the browser, prefer role and name locators (`role=button[name='Share']`). Open tabs with `reuseExistingTab: false` and pass the `tabId` on every call.
- Take commands literally. Query parameters (`id`, `username`) and headers (`Authorization: Bearer`, `Host`) are the contract.

## Proof and skip reporting

- For HTTP, save the command, the response headers (`-D`) and the body. The status code is part of the proof.
- For the browser, save the plain `preview_snapshot` tree text, then copy the PNG from `preview_snapshot {save: true}` (it returns only `screenshotPath`) into `$RUN/evidence/`.
- Prove a mutation from a second view: the admin API, a fresh GET with no cookies, or the admin UI.
- Prefix every artifact with the feature ID and the entry point used, and write it to `$RUN/evidence/`.
- If a path is unreachable, report the attempted command and the unmet precondition. Don't call it verified through a different entry point.

## Feature entry contract

Each feature file starts with an H1 and one paragraph describing the user-visible behavior. Four H2 sections follow, in this order:

1. `Sub-features` lists short IDs, one line per behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and pairs each user action with an exact command and its observable result.
4. `Gotchas` lists traps that waste a verification run or make it invalid.

## Features

- [Publish and view a site](./publish-and-view.md) covers single-document, folder (tar) and markdown-docs publishes, viewed through the share link.
- [Private access and share links](./private-access.md) covers the key gate, the share-link cookie, key rotation and the public toggle.
- [Redeploy the same URL](./redeploy.md) covers owner-token republishing, the generation bump and orphan removal.
- [Admin console](./admin-console.md) covers the user and site inventory, plan changes and takedown and restore.
- [Account dashboard and invites](./account-dashboard.md) covers admin invites, token generation, and the user's site and file management.
- [Large downloadable assets](./large-assets.md) covers the direct-R2 asset flow, which needs real R2 credentials.
