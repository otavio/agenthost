# agenthost

Static-site and asset hosting **built for AI agents**. An agent publishes a site,
Markdown docs, or a large downloadable file and gets back a private share link.
Built entirely on Cloudflare — one Worker and one R2 bucket.

## Publish

```bash
# a single .md or .html — just pipe it in, no headers
curl -s --data-binary @report.md 'https://agenthost.page/publish?id=report'

# or a whole folder — tar it
tar cf - -C ./dist . | curl -s --data-binary @- \
  'https://agenthost.page/publish?id=myblog'
```

You get back a private `shareUrl` (hand it to a human — it logs them in on first
open), the bare `url`, the `accessKey`, your auto-generated `username`, and an
`ownerToken` to redeploy the same URL later.

Sites are served at `https://{username}-{id}.agenthost.page/` — each site is the
root of its own subdomain, so both absolute (`/css/app.css`) and relative
(`./css/app.css`) asset paths work. (The commands above target the public instance
at `agenthost.page`; self-host on your own domain with [DEPLOYING.md](./DEPLOYING.md).)

## Upload a large asset

Three `curl` calls with an existing account: initiate (`POST /asset`), `PUT` the
file to the signed R2 URL it returns, then complete. Only those small control
requests go through the Worker; upload and download payloads use short-lived,
object-scoped R2 URLs, so large files never pass through Worker compute. The
returned share page shows file details and a Download button. Paid accounts
support direct single-file uploads up to 5 GB. The exact recipe is in the
[skill](./skills/agenthost/SKILL.md#upload-a-downloadable-asset).

## Install the skill

agenthost ships as an [Agent Skill](https://agentskills.io) at
[`skills/agenthost/`](./skills/agenthost/). It's a plain `SKILL.md` + `references/`,
so any skill installer can pick it up straight from this repo:

| Runtime | Install |
|---------|---------|
| [skills.sh](https://skills.sh) | `npx skills add <owner>/<repo> --skill agenthost` |
| Claude Code | copy `skills/agenthost/` into `~/.claude/skills/` |
| Hermes | `hermes skills tap add <owner>/<repo>` |
| OpenClaw | import the repo into ClawHub (reads `skills/agenthost/SKILL.md`) |

Replace `<owner>/<repo>` with this repository (e.g. `you/agenthost`).

## Install the development skills

The [p3-stack](https://github.com/Tr1Fecta-7/p3-stack) development skills are in
`skills/`, alongside the agenthost skill. The source revision, upstream
documentation, and license are in `docs/p3-stack/`.

```bash
./install.sh --project . --claude
```

This runs the p3-stack install script with `--project` and `--claude`.
The committed `.agents/skills/` and `.claude/skills/` links load the agenthost
skill and all 53 p3-stack skills for Codex and Claude Code. The installer creates
relative links so the checkout can move to a different path.
The installer preserves existing directories with the same names.

To install the same skills for all projects:

```bash
./install.sh --claude
```

The skills will be available on the next turn. Run `/setup-p3` to configure
provider and model roles, then use `/p3-mode` to select a workflow.

## How it works

- **One Worker, one R2 bucket — nothing else.** R2's strong read-after-write
  consistency is what lets the publish→serve loop work without a database or any
  other coordination primitive.
- **Direct asset data path:** the Worker signs exact-size PUT and GET URLs; bytes
  move client ↔ R2 while the Worker handles only metadata, access, and the share page.
- **Routing by `Host`:** the apex serves the landing page + `/publish`;
  `*.{apex}` subdomains serve hosted sites; `admin.{apex}` serves the admin
  console (behind Cloudflare Access, verified again in the Worker).
- **Private by default.** Each site has an access key; a cookie keeps visitors
  signed in, and an injected Share button copies a key-embedded link.
- **Markdown → docs.** A folder of `.md` renders as a GitBook-style site: nested
  sidebar (honoring `SUMMARY.md`), on-this-page outline, prev/next, GFM, mermaid,
  server-side syntax highlighting, light and dark.
- **Deploy generation** baked into the cache key invalidates the edge globally on
  every publish — no purge API, no stale assets.

## Layout

| Path | What |
|------|------|
| `worker/` | The entire backend — Hono on Workers (publish, serve, admin, cron). |
| `landing/` | Astro static landing page, built into `public/`. |
| `admin/` | Svelte SPA admin console, built into `public/admin/`. |
| `skills/agenthost/` | The `agenthost` Agent Skill (`SKILL.md` + `references/`). |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and [DEPLOYING.md](./DEPLOYING.md)
to host your own instance.

## Develop

With Nix and direnv installed, enable the development shell once per checkout:

```bash
direnv allow
direnv exec . pnpm setup:dev
```

The shell provides Node.js 24, pnpm 10, Git, curl, jq, and format and lint tools.
The flake uses [red-tape](https://github.com/phaer/red-tape) to load the shell
and formatter from `nix/`. Run `nix fmt` to format the Nix files with
[Pedantix](https://github.com/Swarsel/pedantix). Run `nix flake check` to verify
their formatting. Pedantix is also available in the development shell.
The setup command installs locked dependencies and creates `worker/.dev.vars`
from the example if the file does not exist. Existing local settings are kept.

On NixOS, enable `programs.nix-ld.enable = true` for the npm Linux binaries.
The shell supplies the runtime library paths. To enter without direnv, run
`nix develop`.

```bash
pnpm setup:dev
pnpm -C worker dev      # wrangler dev with a local R2 + cache
pnpm -C admin dev       # admin SPA, proxying its API to the local worker
```

To preview the complete application, run `pnpm dev` and open
`http://localhost:8787`. Run `pnpm typecheck` and `pnpm test` to check changes.

In T3 Code, use the scripts from `t3.json` to set up the environment, preview,
test, typecheck, or deploy. New worktrees run setup before the agent starts.
The Preview action starts the full application and opens its local URL.
All actions run through direnv.

## Build & deploy

```bash
pnpm deploy             # turbo build → copy dist into public/ → wrangler deploy
```

One `wrangler deploy` ships everything: the landing and admin are built to static
output, copied into `public/`, and served by the Worker via Static Assets. For a
full from-scratch setup on your own domain (DNS, TLS, R2, admin auth, secrets),
see [DEPLOYING.md](./DEPLOYING.md).

## License

[MIT](./LICENSE)
