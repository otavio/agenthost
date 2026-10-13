<script>
  const API = "/account/api";
  const apexHost = location.host.replace(/^account\./, "");

  let me = $state(null);
  let error = $state("");
  let toast = $state("");
  let issued = $state(null);
  let links = $state({});
  let renaming = $state(false);
  let newName = $state("");
  let moving = $state(false);

  async function api(path, opts) {
    const res = await fetch(API + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  function flash(msg) {
    toast = msg;
    setTimeout(() => (toast = ""), 2500);
  }

  async function run(fn) {
    error = "";
    try { await fn(); } catch (e) { error = e.message; }
  }

  // The server moves a bounded number of files per request and answers
  // complete: false until it is done, including after an interrupted rename.
  async function moveTo(name) {
    moving = true;
    try {
      let done = false;
      while (!done) done = (await post("/username", { username: name })).complete;
    } finally {
      moving = false;
    }
    me = await api("/me");
  }

  const load = () => run(async () => {
    me = await api("/me");
    if (me.renamedFrom) await moveTo(me.username);
  });

  const nameValid = $derived(/^[a-z0-9]{2,30}$/.test(newName.trim().toLowerCase()));

  const changeUsername = () => {
    const name = newName.trim().toLowerCase();
    if (!confirm(`Change your username to ${name}?\n\nEvery page's address changes to ${name}-<site>.${apexHost}, and old links stop working. Your agent's saved token file still names the old username, so generate a new agent token afterwards and run its save command again.`)) return;
    run(async () => {
      await moveTo(name);
      issued = null;
      renaming = false;
      newName = "";
      flash(`username is now ${name}`);
    });
  };

  async function copy(text) {
    await navigator.clipboard.writeText(text);
    flash("copied");
  }

  const generateToken = () => {
    if (!confirm("Generate a new agent token? Agents using the current token stop working.")) return;
    run(async () => { issued = await post("/token"); });
  };

  const setPublic = (s, value) => run(async () => {
    await post(`/site/public?id=${encodeURIComponent(s.id)}`, { public: value });
    s.public = value;
    flash(value ? `${s.id} is public` : `${s.id} is private`);
  });

  const rotate = (s) => {
    if (!confirm(`Create a new share link for ${s.id}? Existing share links stop working and the site becomes private.`)) return;
    run(async () => {
      const d = await post(`/site/rotate?id=${encodeURIComponent(s.id)}`);
      s.public = false;
      links[s.id] = d.shareUrl;
    });
  };

  const removeSite = (s) => {
    if (!confirm(`Delete ${s.id}? This cannot be undone.`)) return;
    run(async () => {
      await api(`/site?id=${encodeURIComponent(s.id)}`, { method: "DELETE" });
      me.sites = me.sites.filter((x) => x.id !== s.id);
      flash(`${s.id} deleted`);
    });
  };

  const removeAsset = (a) => {
    if (!confirm(`Delete ${a.name}? This cannot be undone.`)) return;
    run(async () => {
      await api(`/asset?id=${encodeURIComponent(a.id)}`, { method: "DELETE" });
      me.assets = me.assets.filter((x) => x.id !== a.id);
      flash(`${a.name} deleted`);
    });
  };

  const fmtBytes = (b) => (b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : b < 1073741824 ? (b / 1048576).toFixed(1) + " MB" : (b / 1073741824).toFixed(2) + " GB");
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  load();
</script>

<header>
  <h1>agenthost account</h1>
  {#if me}
    <div class="meta">
      <span>{me.email}</span>
      <span class="name">{me.username}</span>
      <span class="badge {me.plan}">{me.plan}</span>
    </div>
  {/if}
</header>

{#if error}<div class="error">⚠ {error}</div>{/if}
{#if toast}<div class="toast">{toast}</div>{/if}

{#if me}
  <main>
    <section class="panel">
      <h2>Agent token</h2>
      {#if issued}
        <p class="muted">Copy it now. It is not shown again.</p>
        <div class="secret"><code>{issued.token}</code><button class="ghost sm" onclick={() => copy(issued.token)}>Copy</button></div>
        <p class="muted">Run this in a terminal on the machine your agent uses and paste the token at the prompt. It saves to <code>{issued.credentialsFile}</code>.</p>
        <div class="secret"><pre>{issued.saveCommand}</pre><button class="ghost sm" onclick={() => copy(issued.saveCommand)}>Copy</button></div>
      {:else}
        <p class="muted">Your agent publishes as <span class="name">{me.username}</span>. Generate a token to get the command that saves it on your agent's machine.</p>
      {/if}
      <button onclick={generateToken}>Generate agent token</button>
      <div class="rename">
        {#if moving}
          <p class="muted">Moving your pages to the new username…</p>
        {:else if renaming}
          <form onsubmit={(e) => { e.preventDefault(); changeUsername(); }}>
            <input bind:value={newName} placeholder="new username" maxlength="30" autocomplete="off" spellcheck="false" aria-label="new username" />
            <button disabled={!nameValid}>Change</button>
            <button type="button" class="ghost" onclick={() => { renaming = false; newName = ""; }}>Cancel</button>
          </form>
          <p class="muted small">2-30 lowercase letters or digits.</p>
        {:else}
          <button class="ghost sm" onclick={() => (renaming = true)}>Change username</button>
        {/if}
      </div>
    </section>

    <section class="panel">
      <h2>Pages and docs <span class="count">{me.sites.length}</span></h2>
      {#if me.sites.length === 0}
        <p class="muted">Nothing published yet.</p>
      {:else}
        <table>
          <thead><tr><th>site</th><th>size</th><th>last publish</th><th>access</th><th></th></tr></thead>
          <tbody>
            {#each me.sites as s (s.id)}
              <tr class:down={s.takenDown}>
                <td>
                  <a href={s.url} target="_blank" rel="noopener"><b>{s.id}</b></a>
                  {#if s.takenDown}<span class="tomb">taken down</span>{/if}
                  {#if s.expiresAt}<div class="muted small">deleted {fmtDate(s.expiresAt)} unless republished</div>{/if}
                </td>
                <td>{fmtBytes(s.bytes)} · {s.fileCount} {s.fileCount === 1 ? "file" : "files"}</td>
                <td>{fmtDate(s.lastDeployAt)}</td>
                <td>
                  <label class="toggle"><input type="checkbox" checked={s.public} onchange={(e) => setPublic(s, e.currentTarget.checked)} /> public</label>
                </td>
                <td>
                  <div class="actions">
                    <button class="ghost sm" onclick={() => rotate(s)}>New share link</button>
                    <button class="danger sm" onclick={() => removeSite(s)}>Delete</button>
                  </div>
                </td>
              </tr>
              {#if links[s.id]}
                <tr class="link"><td colspan="5"><div class="secret"><code>{links[s.id]}</code><button class="ghost sm" onclick={() => copy(links[s.id])}>Copy</button></div></td></tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}
    </section>

    <section class="panel">
      <h2>Uploaded files <span class="count">{me.assets.length}</span></h2>
      {#if me.assets.length === 0}
        <p class="muted">No uploaded files.</p>
      {:else}
        <table>
          <thead><tr><th>file</th><th>size</th><th>status</th><th></th></tr></thead>
          <tbody>
            {#each me.assets as a (a.id)}
              <tr>
                <td>
                  <a href={a.url} target="_blank" rel="noopener"><b>{a.name}</b></a>
                  {#if a.public}<span class="pub">public</span>{/if}
                  {#if a.expiresAt}<div class="muted small">deleted {fmtDate(a.expiresAt)}</div>{/if}
                </td>
                <td>{fmtBytes(a.size)}</td>
                <td>{a.status}</td>
                <td><div class="actions"><button class="danger sm" onclick={() => removeAsset(a)}>Delete</button></div></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  </main>
{:else if !error}
  <p class="muted loading">Loading…</p>
{/if}

<style>
  :global(:root) { --bg: #0a0c10; --fg: #e8edf2; --muted: #8c97a3; --accent: #6ea0ff; --card: #14181f; --border: #232a33; --green: #7df0c8; --red: #ff6b6b; }
  :global(body) { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 18px 28px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 19px; margin: 0; }
  h2 { font-size: 15px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  main { display: grid; gap: 22px; padding: 24px 28px; max-width: 980px; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px; }
  .count { background: var(--border); color: var(--fg); border-radius: 20px; padding: 1px 8px; font-size: 12px; margin-left: 6px; }
  .meta { display: flex; gap: 14px; align-items: center; color: var(--muted); font-size: 13.5px; }
  .name { font-family: ui-monospace, Menlo, monospace; color: var(--fg); }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 20px; text-transform: uppercase; letter-spacing: .03em; }
  .badge.free { background: #232a33; color: var(--muted); }
  .badge.paid { background: var(--green); color: #06231a; }
  .secret { display: flex; gap: 10px; align-items: flex-start; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }
  .secret code, .secret pre { flex: 1; margin: 0; font: 13px/1.5 ui-monospace, Menlo, monospace; word-break: break-all; white-space: pre-wrap; }
  button { background: var(--accent); color: #07111f; border: 0; border-radius: 8px; padding: 8px 13px; font-weight: 600; font-size: 13px; cursor: pointer; }
  button:hover { opacity: .9; }
  button:disabled { opacity: .4; cursor: default; }
  .rename { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
  .rename form { display: flex; gap: 8px; }
  .rename p { margin: 6px 0 0; }
  input { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font: 13px ui-monospace, Menlo, monospace; }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  button.danger { background: var(--red); color: #2a0707; }
  button.sm { padding: 5px 9px; font-size: 12px; white-space: nowrap; }
  a { color: var(--fg); }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 9px 8px; border-bottom: 1px solid var(--border); font-size: 13.5px; vertical-align: top; }
  tr.link td { padding-top: 0; }
  tr.down td b { text-decoration: line-through; opacity: .6; }
  .actions { display: flex; gap: 6px; justify-content: flex-end; }
  .toggle { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
  .pub { font-size: 11px; color: var(--green); margin-left: 6px; }
  .tomb { font-size: 11px; color: var(--red); margin-left: 6px; }
  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .loading { padding: 24px 28px; }
  .error { background: rgba(255, 107, 107, .12); color: var(--red); padding: 10px 28px; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--green); color: #06231a; padding: 11px 18px; border-radius: 10px; font-weight: 600; box-shadow: 0 6px 20px rgba(0, 0, 0, .3); }
</style>
