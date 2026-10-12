// Write a wrangler config for local verification: worker/wrangler.jsonc minus
// `routes` (wrangler dev rewrites every request's Host to the first route's zone,
// which defeats Host-based routing) and with absolute main/assets paths.
// Usage: node verify-config.mjs <repo-root> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [root, out] = process.argv.slice(2);
const src = readFileSync(resolve(root, "worker/wrangler.jsonc"), "utf8");

// Strip // and /* */ comments outside strings, then trailing commas.
let json = "", inStr = false;
for (let i = 0; i < src.length; i++) {
  const c = src[i];
  if (inStr) { json += c; if (c === "\\") json += src[++i]; else if (c === '"') inStr = false; continue; }
  if (c === '"') { inStr = true; json += c; continue; }
  if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; json += "\n"; continue; }
  if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 1; continue; }
  json += c;
}
const cfg = JSON.parse(json.replace(/,(\s*[}\]])/g, "$1"));
delete cfg.routes;
delete cfg.$schema;
cfg.main = resolve(root, "worker", cfg.main);
cfg.assets.directory = resolve(root, "worker", cfg.assets.directory);
writeFileSync(out, JSON.stringify(cfg, null, 2));
