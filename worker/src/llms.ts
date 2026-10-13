// /llms.txt — machine-readable publish instructions served at the apex.
// The apex host is read from env (APEX_HOST) so the text always reflects the
// deployment, and limits are rendered from config so a quota bump can't silently
// make this lie.

import { ASSET_LIMITS, LIMITS, formatBytes } from "./config";
import { credentialsCommand, credentialsFile, skillFiles, writeCredentialsCommand } from "./skill";

const free = LIMITS.free;

export const llmsTxt = (apexHost: string): string => `# agenthost — publish a static site or docs, get a private share link. Invite-only.

## Account (once, done by the human)
Publishing is invite-only. The operator invites the human by email. The human
signs in at https://account.${apexHost}, generates an agent token, and runs the
command shown there in a terminal on your machine. It saves the token and the
username in the curl config ${credentialsFile(apexHost)}, which every request below
reads with -K. Check for it with \`test -f ${credentialsFile(apexHost)}\` and never print it.
Without it, a publish returns 401.
The dashboard's command prompts only for the token. This one prompts for the username too:
${credentialsCommand(apexHost)}
If you run in a remote sandbox with no terminal the human can reach, they may paste the
username and token in chat. Save them with this, in place of OWNER_TOKEN and USERNAME,
and don't echo the token:
${writeCredentialsCommand(apexHost)}
A 403 after publishes that worked means the token was regenerated or the username
changed. Ask the human to generate a token and run the command again.

## Publish (one command, zero install)
# A single .md or .html — pipe it straight in (md renders, html is served as-is;
# the file lands at the site root /):
curl -s -K ${credentialsFile(apexHost)} --data-binary @report.md \\
  'https://${apexHost}/publish?id=report'

# A whole folder — pipe a tar of it:
tar cf - -C ./dist . | curl -s -K ${credentialsFile(apexHost)} --data-binary @- \\
  'https://${apexHost}/publish?id=myblog'

## Response (JSON)
{
  "shareUrl": "https://cleverotter4f2-myblog.${apexHost}/?k=<key>",  // hand THIS to a human; private + pre-authed
  "url": "https://cleverotter4f2-myblog.${apexHost}/",              // bare URL (prompts for the key)
  "accessKey": "<the site access key, also embedded in shareUrl>",
  "username": "cleverotter4f2"                                           // your account name (auto-generated, no hyphens)
}
Publishing again with the same id replaces the content at the same URL.

## Large downloadable assets
Three calls, all with -K ${credentialsFile(apexHost)} except the PUT, which goes to R2
and must not carry your token:
1. POST https://${apexHost}/asset with JSON
   {"name":"demo.mp4","bytes":<exact size>,"contentType":"video/mp4"}
   → uploadUrl, uploadHeaders, completeUrl, shareUrl (the shareUrl only comes back here)
2. curl --upload-file demo.mp4 -H '<each uploadHeaders entry>' '<uploadUrl>'   (within 15 min)
3. POST <completeUrl> → {"ok":true}
The file goes straight from the client to R2. Opening the shareUrl shows a Download
button whose bytes also come directly from R2.
Free max: ${formatBytes(ASSET_LIMITS.free.perAsset)} per asset. Paid max: ${formatBytes(ASSET_LIMITS.paid.perAsset)} per asset.

## Site asset paths
Each site is the root of its own subdomain ({username}-{id}.${apexHost}), so
both absolute and relative asset paths work:
  <link href="/css/app.css">     GOOD
  <link href="./css/app.css">    GOOD

## Notes
- Static sites, markdown docs, OR direct-R2 downloadable assets. /index.html is the default doc; a folder of .md renders as a
  GitBook-style docs site (sidebar + README.md as home; optional SUMMARY.md for ordering and nesting).
- No Content-Type needed: a tar body is a folder, anything else is one document. To publish a
  single file of any other type, add ?file=<name>.
- Sites are PRIVATE by default. Share the shareUrl; visitors stay logged in via a cookie.
  Every page has a "Share" button that copies a key-embedded link.
- Limits (free): ${free.filesPerSite} files, ${formatBytes(free.perFile)}/file, ${formatBytes(free.perSite)}/site, ${formatBytes(free.perUser)}/account. Hosted sites are noindex.
- Free sites are deleted ${free.retentionDays} days after the last publish — redeploy to keep alive.

## Install as a skill (optional — persist this contract)
This publish contract ships as an Agent Skill rendered for ${apexHost}, so you don't
have to re-read this file on every run. Install it once; rerun to update:
curl -fsSL https://${apexHost}/skill/install.sh | sh
An agent can instead save each of the skill's files into its own skills directory,
in a folder named after the skill's \`name\`, keeping their paths:
${Object.keys(skillFiles).map((file) => `- https://${apexHost}/skill/${file} → <name>/${file}`).join("\n")}
`;
