# Large downloadable assets

An existing account uploads a large file in three calls: create (`POST /asset`), a direct `PUT` to a presigned R2 URL, then complete. Recipients get a share page with file details and a Download button served from R2.

## Sub-features

- `asset-create` validates the name, size and plan limit, then returns a presigned PUT URL.
- `asset-put` uploads bytes straight to R2. They never pass through the Worker.
- `asset-complete` finalizes the asset and returns a share page at `/a/<user>/<id>`.
- `asset-limits` rejects a bad name (400), a bad size (400) or an over-plan size (413).

## How to get to it (user POV)

- `curl -X POST -H "Authorization: Bearer <ownerToken>" -H 'content-type: application/json' "$BASE/asset?username=<u>" -d '{"name":"<file>","bytes":<n>}'`, then the PUT and complete calls described in `/llms.txt` ("Large downloadable assets").

## Driving it with `curl`

Preconditions:

- An account exists (`U` and `TOKEN` from any publish).
- Real, bucket-scoped R2 S3 credentials are available. **The default verification launch does not load them** (it skips `worker/.dev.vars`), so the full journey cannot pass locally as launched.

- **Validation.** Run `curl -s -w ' %{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' "$BASE/asset?username=$U" -d '{"name":"","bytes":10}'`. It prints `{"error":"valid file name required (max 180 characters)"} 400`.
- **Create without credentials.** Run the same command with `-d '{"name":"a.bin","bytes":10}'`. It prints `{"error":"direct R2 uploads are not configured"} 503`. Report the journey as **failed: R2 credentials not configured** and stop. Don't weaken it.
- **Full journey (only with real credentials).** Add `--var R2_ACCESS_KEY_ID:… --var R2_SECRET_ACCESS_KEY:… --var R2_ACCOUNT_ID:… --var R2_BUCKET_NAME:…` to the `wrangler dev` line, or launch from a config next to a `.dev.vars` that holds them. The create returns a presigned URL. `curl -T file "<putUrl>"` returns 200 from R2. The complete call returns the share URL, and its page shows a Download button whose link fetches the exact bytes (compare `sha256sum`).

## Gotchas

- The full journey writes to a **real** R2 bucket. Use a scratch bucket, and delete the asset afterward (`DELETE $BASE/a/<u>/<id>` with the Bearer token), because Miniflare cleanup does not reach it.
- The create body fields are `name` and `bytes`, not `filename` or `size`.
- Free plan max is 100 MB per asset and paid is 5 GB. Flip the plan through the admin console to test the paid limit.
