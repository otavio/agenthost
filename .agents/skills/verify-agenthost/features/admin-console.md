# Admin console

The operator's Svelte console at `admin.{apex}` lists users and their sites and assets. It can change a user's plan, rename a user, take a site down (410) and restore it, and attach a custom domain.

## Sub-features

- `admin-users` lists users with their plan.
- `admin-sites` shows a user's sites table (site, size, files, last deploy) and assets.
- `admin-plan` toggles a user between free and paid.
- `admin-takedown` tombstones a site, which then serves 410, and restores it.
- `admin-rename` and `admin-domain` are prompt-driven mutations.

## How to get to it (user POV)

- Open `http://admin.localhost:$PORT/`. Locally, DEV_MODE skips Cloudflare Access.
- API: `curl -H "Host: admin.localhost" $BASE/admin/api/{users,sites?username=,assets?username=}`, plus `POST /admin/api/{plan,rename,takedown,domain}` with JSON bodies.

## Driving it with `preview_*`

Preconditions:

- At least one site was published, for example `demo` from [publish-and-view](./publish-and-view.md), and its owner `U` is known.

- **Open the console.** Run `preview_open {url: "http://admin.localhost:$PORT/", open: false, reuseExistingTab: false}`. The snapshot has `heading "⚙️ agenthost admin"` and `heading "Users N"`, plus one `button "<U> free"`.
- **Select the user.** Run `preview_click` with locator `role=button[name='<U> free']`. A `heading "<U>"` appears with `button "⬆ Upgrade to paid"`, `button "✎ Rename"`, `heading "Sites N"` and a table row `role=row[name=/^demo /]`.
- **Take down.** Run `preview_click` with locator `role=row[name=/^demo /] >> role=button[name='takedown']`, then `preview_wait_for` on the same row's `role=button[name='restore']`. Then `curl -s -o /dev/null -w '%{http_code}' http://$U-demo.localhost:$PORT/` prints `410`.
- **Restore.** Click `restore` in that row. The same curl prints `401` again (private site, no key).
- **Plan.** Click `⬆ Upgrade to paid`. Then `curl -s -H "Host: admin.localhost" $BASE/admin/api/users` shows `"plan":"paid"` for `U`.
- **Proof.** After each mutation, save the `preview_snapshot` tree text to `$RUN/evidence/admin-<step>.aria.txt` and copy the PNG from `preview_snapshot {save: true}` to `$RUN/evidence/admin-<step>.png`.

## Gotchas

- `✎ Rename` and `+ domain` open `prompt()` dialogs. Answer them with `preview_dialog {accept: true, promptText: …}`. Deleting an asset opens a `confirm()`.
- The takedown API body is `{"username","siteId","tombstone": true|false}`.
- A rename moves every R2 key for the user. Afterward the old site host 404s, and the owner's token works only with the new username.
- Lists are cursor-paged (`Load more …` buttons). A fresh run has one page.
