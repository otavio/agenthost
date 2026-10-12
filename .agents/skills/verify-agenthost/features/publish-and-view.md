# Publish and view a site

An agent publishes HTML, a folder or markdown with one `POST /publish` and gets back a private share link. A person opening that link sees the rendered site on its own subdomain.

## Sub-features

- `publish-doc` publishes one document (HTML or markdown) from the request body.
- `publish-folder` publishes a tar of a folder, with `index.html` as the default document.
- `publish-docs` renders a folder of `.md` files as a docs site with a sidebar.
- `view-share` opens the returned `shareUrl` in a browser and lands on the site.

## How to get to it (user POV)

- Pipe a file into `curl --data-binary @- "$BASE/publish?id=<site>"`.
- Pipe a `tar cf - -C <dir> .` into the same endpoint.
- Open the `shareUrl` from the response in a browser.
- Follow the instructions at `$BASE/llms.txt`, which is what agents read first.

## Driving it with `curl` and `preview_*`

Preconditions:

- The doctor passes for `$RUN`.
- No account exists yet. A publish without a token mints a new anonymous account.

- **Publish one HTML page.** Run `printf '<!doctype html><title>Verify</title><body><h1>hello verify</h1></body>' | curl -s -D $RUN/evidence/publish-doc-headers.txt --data-binary @- "$BASE/publish?id=demo" > $RUN/evidence/publish-doc-publish.json`. The response is 200 with JSON holding `username`, `siteId: "demo"`, `generation: 1`, `fileCount: 1`, `accessKey`, `ownerToken` and `shareUrl: "https://<user>-demo.localhost/?k=<key>"`.
- **Open the share link.** `URL=$(.agents/skills/verify-agenthost/scripts/local-url.sh "$RUN" "$(jq -r .shareUrl $RUN/evidence/publish-doc-publish.json)")`, then `preview_open {url: $URL, open: false, reuseExistingTab: false}`. The network log shows `302` then `200`. The tab URL no longer has `?k=` and the title is `Verify`.
- **Check the page.** Run `preview_snapshot`. The accessibility tree has `heading "hello verify"` and the injected `button "Share"`. Save the tree text to `$RUN/evidence/publish-doc-view.aria.txt`. Then run `preview_snapshot` with `save: true` and copy the returned `screenshotPath` to `$RUN/evidence/publish-doc-view.png`.
- **Publish a markdown folder.** Make `$RUN/fixture/README.md` (`# Home`) and `$RUN/fixture/guide/install.md` (`# Install`). Set `U` and `TOKEN` from `publish-doc-publish.json`. Run `tar cf - -C $RUN/fixture . | curl -s --data-binary @- -H "Authorization: Bearer $TOKEN" "$BASE/publish?id=docs&username=$U"`. The response has `fileCount: 2` and the same `username`.
- **View the docs site.** Open its local share URL. The title is `Home · docs`. The sidebar `navigation` lists `link "README"` (`/README.md`) and `link "Install"` (`/guide/install.md`), and the article has `heading "Home"` and a `Next Install` link. Click `role=navigation >> role=link[name='Install']`, then `preview_wait_for` `role=heading[name='Install']` with `urlIncludes: /guide/install.md`.
- **Second view.** Run `curl -s -H "Host: admin.localhost" "$BASE/admin/api/sites?username=$U"`. The output lists `demo` and `docs` with matching `fileCount`.

## Gotchas

- At `/`, a markdown-only site renders the first `SUMMARY.md` entry, else `README.md`, else the first file. `index.md` is not special: a folder with `index.md` and `guide/install.md` opens on `Install`. Sidebar labels come from file names (`index.md` shows as `Index`), not from headings.

- The Share widget is appended to `<body>` by HTMLRewriter. An HTML document without an explicit `<body>` element renders fine but has no `Share` button.

- `?username=` without `Authorization: Bearer` is ignored. The publish mints a new account with a different username instead of failing.
- A bare `<h1>…</h1>` body with no `<!doctype` or `<html>` is sniffed as markdown and renders as a one-page docs site titled `README · <site>`. Send a doctype, or `-H 'Content-Type: text/html'`, when you mean HTML.
- Response URLs are `https://…localhost/` with no port. Opening them unmapped hits nothing.
- `PUBLISH_LIMITER` allows 20 publishes per 60 s for each IP. In local dev every caller shares the IP `unknown`, so a loop of publishes starts getting 429s.
