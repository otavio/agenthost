# Account dashboard and invites

Publishing is invite-only. The operator invites an email from the admin console. The invited user signs in at `account.{apex}` (Cloudflare Access with a one-time PIN in production, `DEV_ACCOUNT_EMAIL` locally), generates an agent token, and manages their sites and uploaded files.

## Sub-features

- `account-invite` creates a user from the admin console or `POST /admin/api/users`. A second invite for the same email returns 409.
- `account-token` generates an agent token, shown once with a publish command. The previous token stops working.
- `account-sites` lists the user's sites with a public toggle, "New share link" and delete.
- `account-files` lists uploaded files with delete.
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
- **Generate a token.** `preview_open {url: "http://account.localhost:$PORT/", open: false, reuseExistingTab: false}`, click `role=button[name='Generate agent token']`, accept the confirm with `preview_dialog {accept: true}`. The page shows the token and a curl command with `Authorization: Bearer` and `?username=$U`. Set `TOKEN` from the snapshot.
- **Publish with it.** `printf '# Report' | curl -s --data-binary @- -H "Authorization: Bearer $TOKEN" "$BASE/publish?id=report&username=$U"` returns 200. Reload the dashboard. The `Pages and docs` table has a `report` row.
- **Public toggle.** Click the row's `public` checkbox. `curl -s -o /dev/null -w '%{http_code}' -H "Host: $U-report.localhost" "$BASE/"` prints `200`.
- **New share link.** Click `New share link` and accept the confirm. The new link appears under the row and the checkbox clears. The bare URL and the old `?k=` print `401`, and the new `?k=` prints `302`.
- **Replace the token.** Generate another token. A publish with the old one returns 403 `invalid username or owner token`, and the new one returns 200.
- **Delete.** Click `Delete` and accept. `/account/api/me` lists no sites, and the site host returns 404.

## Gotchas

- `DEV_ACCOUNT_EMAIL` is fixed per launch. To see the "not invited" page in the browser, launch with `ACCOUNT_EMAIL=stranger@example.com`.
- Writes without the dashboard's `Origin` return 403 `cross-origin request rejected`. Locally the dashboard origin is `http://account.localhost:$PORT`.
- Access keys are stored only as hashes, so the dashboard never shows an existing share link. "New share link" rotates the key and makes the site private.
- Clipboard writes from the `Copy` buttons may fail in the preview browser. Read the token from the snapshot instead.
