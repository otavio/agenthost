# Private access and share links

Every site is private by default. The bare address shows a key prompt, the share link (`?k=`) signs the visitor in with a cookie, rotating the key cuts off old links, and the owner can make a site public.

## Sub-features

- `gate-bare` shows the access interstitial (401) without a key.
- `gate-share` accepts `?k=<key>`, sets `as_auth_<siteId>`, and redirects to the clean URL.
- `gate-wrong` re-prompts on a wrong key with 401, or 429 once throttled.
- `key-rotate` issues a new key and makes the old share link fail.
- `key-public` serves the site without any key, and reverts.

## How to get to it (user POV)

- Open `http://<user>-<site>.localhost:$PORT/` with no key.
- Open the `shareUrl` from a publish or a rotation.
- Owner: `POST $BASE/key/rotate?username=<u>&id=<site>` with `Authorization: Bearer <ownerToken>`.
- Owner: `POST $BASE/key/public?username=<u>&id=<site>` with body `{"public":true}` or `{"public":false}`.
- Visitor: the `Share` button on any HTML page copies a key-embedded link.

## Driving it with `curl` and `preview_*`

Preconditions:

- A site `demo` was published as in [publish-and-view](./publish-and-view.md), and `U`, `TOKEN` and `KEY` were read from `$RUN/evidence/publish-doc-publish.json`.
- `SITE=http://$U-demo.localhost:$PORT`.

- **Bare address.** Run `curl -s -o $RUN/evidence/gate-bare.html -w '%{http_code}' $SITE/`. It prints `401`, and the body is the key prompt page, not the site content.
- **Share link.** Run `curl -s -D - -o /dev/null "$SITE/?k=$KEY"`. It prints `302`, `Location: /` and `Set-Cookie: as_auth_demo=$KEY; Path=/; Secure; HttpOnly; SameSite=Lax`.
- **Browser cookie.** Run `preview_open` on the share link, then `preview_navigate` to `$SITE/` (no key). The page still renders, which proves the cookie carries the session.
- **Rotate.** Run `curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/key/rotate?username=$U&id=demo"`. It returns `ok: true` with a new `accessKey` and `shareUrl`. Then `curl -s -o /dev/null -w '%{http_code}' "$SITE/?k=$KEY"` prints `401`, and the new key prints `302`.
- **Public.** Run `curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/key/public?username=$U&id=demo" -d '{"public":true}'`. After that, a cookie-less `curl -s -o /dev/null -w '%{http_code}' $SITE/` prints `200`. Revert with `{"public":false}`, and the same request prints `401` again.

## Gotchas

- A browser tab that already holds the cookie keeps working after a rotation until the cookie's key stops matching. Test "old link fails" with a cookie-less curl or a fresh `incognito` profile tab.
- Wrong-key attempts count against `ACCESS_LIMITER` (30 per 60 s for each IP and site). A tight loop turns 401s into 429s.
- `/key/public` with no body defaults to public. Send the JSON body explicitly.
- Rotating also forces `public: false`.
