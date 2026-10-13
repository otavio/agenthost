# Account dashboard and invites

Publishing is invite-only. The operator invites an email from the admin console. The invited user signs in at `account.{apex}` (Cloudflare Access with a one-time PIN in production, `DEV_ACCOUNT_EMAIL` locally), generates an agent token, and manages their sites and uploaded files.

## Sub-features

- `account-invite` creates a user from the admin console or `POST /admin/api/users`. A second invite for the same email returns 409.
- `account-token` generates an agent token, shown once with a save command that prompts for it and writes `~/.config/agenthost/{apex}.curlrc` (mode 600) for `curl -K`. The previous token stops working.
- `account-skill` serves the agenthost skill at `$BASE/skill/SKILL.md`, naming the apex and that credentials file.
- `account-sites` lists the user's sites with a public toggle, "New share link" and delete.
- `account-files` lists uploaded files with delete.
- `account-rename` changes the username from the token card. Sites, asset metadata and a custom-domain mapping move to the new name, and a name in use returns 409.
- `account-guard` answers 403 for an email without an invite and for writes from any other origin.

## How to get to it (user POV)

- Admin console: the invite form above the user list at `http://admin.localhost:$PORT/`.
- Dashboard: `http://account.localhost:$PORT/`.
- API: `curl -H "Host: account.localhost" $BASE/account/api/me`, plus `POST /account/api/{token,site/rotate?id=,site/public?id=}` and `DELETE /account/api/{site,asset}?id=`. Every write needs `-H "Origin: http://account.localhost:$PORT"`.

## Driving it with `curl` and `preview_*`

Preconditions:

- The doctor passes for `$RUN`. The launch used the default `ACCOUNT_EMAIL`, `owner@example.com`.

- **Not invited yet.** `curl -s -w ' %{http_code}' -H "Host: account.localhost" "$BASE/account/api/me"` prints `{"error":"not invited"} 403`.
- **Invite.** `curl -s -H "Host: admin.localhost" -H 'content-type: application/json' -d '{"email":"owner@example.com"}' "$BASE/admin/api/users"` returns 201 with `username`. Set `U` to it. Repeating the call returns 409 `email already invited`.
- **Generate a token.** `preview_open {url: "http://account.localhost:$PORT/", open: false, reuseExistingTab: false}`, click `role=button[name='Generate agent token']`, accept the confirm with `preview_dialog {accept: true}`. The page shows the token and a save command that names `$U` and holds no token. Set `TOKEN` and `SAVE` from the snapshot.
- **Save it.** `export HOME=$(mktemp -d) && printf '%s\n' "$TOKEN" | sh -c "$SAVE"`. It prompts for the token with echo off. To see that, run it in a pty instead (`script -qc "sh -c '$SAVE'"`) and paste the token. `stat -c %a "$HOME/.config/agenthost/localhost.curlrc"` prints `600`, and the file holds two lines, `header = "Authorization: Bearer $TOKEN"` and `header = "x-agenthost-user: $U"`.
- **Publish with it.** `printf '# Report' | curl -s -K "$HOME/.config/agenthost/localhost.curlrc" --data-binary @- "$BASE/publish?id=report"` returns 200. Reload the dashboard. The `Pages and docs` table has a `report` row.
- **Public toggle.** Click the row's `public` checkbox. `curl -s -o /dev/null -w '%{http_code}' -H "Host: $U-report.localhost" "$BASE/"` prints `200`.
- **New share link.** Click `New share link` and accept the confirm. The new link appears under the row and the checkbox clears. The bare URL and the old `?k=` print `401`, and the new `?k=` prints `302`.
- **Replace the token.** Generate another token. A publish with the old one returns 403 `invalid username or owner token`, and the new one returns 200.
- **Change the username.** Click `Change username`, type a new name, click `Change` and accept the confirm. The header shows the new name. `$NEW-<site>.localhost` prints `200` and `$U-<site>.localhost` prints `404`. A publish with the same token and `username=$U` returns 403, and with `username=$NEW` it returns 200. A name another user holds shows `username taken`. To see the batched move, publish a site with more than 12 files and POST `/account/api/username` with curl. Each request answers 202 with `"complete":false` until the last one answers 200.
- **Delete.** Click `Delete` and accept. `/account/api/me` lists no sites, and the site host returns 404.

## Gotchas

- `DEV_ACCOUNT_EMAIL` is fixed per launch. To see the "not invited" page in the browser, launch with `ACCOUNT_EMAIL=stranger@example.com`.
- Writes without the dashboard's `Origin` return 403 `cross-origin request rejected`. Locally the dashboard origin is `http://account.localhost:$PORT`.
- Access keys are stored only as hashes, so the dashboard never shows an existing share link. "New share link" rotates the key and makes the site private.
- Clipboard writes from the `Copy` buttons may fail in the preview browser. Read the token from the snapshot instead.
