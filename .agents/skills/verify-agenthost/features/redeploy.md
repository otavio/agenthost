# Redeploy the same URL

An owner republishes to the same address with the `ownerToken`. The site's content is replaced atomically, the generation increases, files missing from the new upload disappear, and the existing access key keeps working.

## Sub-features

- `redeploy-auth` updates a site in place with a Bearer token and `?username=`.
- `redeploy-generation` increments `generation` with each publish.
- `redeploy-orphans` stops serving files absent from the new upload.
- `redeploy-key-kept` returns `accessKey: null`, and the old share link still works.
- `redeploy-reject` refuses a wrong token with 403.

## How to get to it (user POV)

- `tar cf - -C <dir> . | curl --data-binary @- -H 'Authorization: Bearer <ownerToken>' "$BASE/publish?id=<site>&username=<username>"` (from `/llms.txt`, "Redeploy the SAME url").

## Driving it with `curl`

Preconditions:

- A folder site `docs` was published, with `U` and `TOKEN` known. Its fixture has `index.md` and `guide/install.md`.
- `SITE=http://$U-docs.localhost:$PORT`. The site is made public with `/key/public`, or requests carry the cookie, so GETs return content.

- **Republish without a file.** Delete `$RUN/fixture/guide/install.md` and change `index.md` to `# Home v2`. Run `tar cf - -C $RUN/fixture . | curl -s --data-binary @- -H "Authorization: Bearer $TOKEN" "$BASE/publish?id=docs&username=$U" > $RUN/evidence/redeploy-publish.json`. The response has `generation: 2`, `fileCount: 1` and `accessKey: null`.
- **Content replaced.** Run `curl -s $SITE/ | grep -o '<h1[^>]*>[^<]*'`. It shows `Home v2`.
- **Orphan removed.** Run `curl -s -o /dev/null -w '%{http_code}' $SITE/guide/install.md`. It prints `404`.
- **Wrong token.** Run `printf x | curl -s -w ' %{http_code}' --data-binary @- -H 'Authorization: Bearer nope' "$BASE/publish?id=docs&username=$U"`. It prints a JSON error and `403`, and the site still serves `Home v2`.

## Gotchas

- Without the Bearer header the publish returns 401. Generating a new token in the account dashboard makes the old one return 403.
- Hosted HTML is cached per generation. Compare generations in the publish response rather than trusting a browser tab that may show a stale page.
