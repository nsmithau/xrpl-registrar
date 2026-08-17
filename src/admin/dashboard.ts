/**
 * The read-only operator dashboard, embedded as a single self-contained HTML
 * document (no build step, no external assets, no network dependency). Served
 * on the admin port.
 *
 * The shell carries no data; it prompts for the admin bearer token and reads
 * the same authenticated `/admin/issuances` endpoints the API exposes, so the
 * dashboard can never drift from the API and account data stays behind auth.
 * Read-only in v1: it shows progress and coverage, and mutates nothing.
 *
 * The colour palette is defined inline (design tokens as CSS custom
 * properties) with a system light/dark theme; the IBM Plex fonts load from
 * Google Fonts (the one external dependency), with system fallbacks.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>XRPL Ingestor · operator dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root {
    --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --radius: 0.5rem;
    --background: 210 20% 98%;
    --foreground: 222 47% 11%;
    --card: 0 0% 100%;
    --primary: 206 98% 35%;
    --primary-foreground: 0 0% 100%;
    --muted: 210 25% 94%;
    --muted-foreground: 215 16% 40%;
    --success: 160 84% 30%;
    --destructive: 0 72% 51%;
    --border: 214 28% 86%;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: 222 35% 7%;
      --foreground: 210 30% 96%;
      --card: 222 30% 10%;
      --primary: 206 98% 48%;
      --muted: 217 28% 16%;
      --muted-foreground: 215 16% 62%;
      --success: 160 64% 42%;
      --destructive: 0 72% 55%;
      --border: 217 25% 20%;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-sans);
    background: hsl(var(--background));
    color: hsl(var(--foreground));
    margin: 0;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 16px 24px; border-bottom: 1px solid hsl(var(--border));
  }
  header .logo { height: 22px; width: auto; color: hsl(var(--primary)); }
  header h1 { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  header .sub { color: hsl(var(--muted-foreground)); font-size: 13px; }
  /* Combined Login/Logout control, top-right. */
  header .authbtn { margin-left: auto; display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-width: 104px; padding: 7px 14px; font-size: 13px; font-weight: 500; cursor: pointer; color: hsl(var(--primary-foreground)); background: hsl(var(--primary)); border: none; border-radius: var(--radius); }
  header .authbtn svg { width: 15px; height: 15px; display: block; }
  header .authbtn:hover { filter: brightness(1.05); }
  #auth { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 24px; }
  input {
    padding: 8px 10px; min-width: 300px; font: inherit; color: inherit;
    background: hsl(var(--card)); border: 1px solid hsl(var(--border)); border-radius: var(--radius);
  }
  input:focus { outline: 2px solid hsl(var(--primary) / 0.5); outline-offset: 1px; }
  button {
    padding: 8px 16px; font: inherit; font-weight: 500; cursor: pointer;
    color: hsl(var(--primary-foreground)); background: hsl(var(--primary));
    border: none; border-radius: var(--radius);
  }
  button:hover { filter: brightness(1.05); }
  button.copy {
    margin-left: 8px; padding: 3px; line-height: 0; vertical-align: middle;
    color: hsl(var(--muted-foreground)); background: transparent;
    border: 1px solid hsl(var(--border)); border-radius: 5px;
  }
  button.copy svg { display: block; width: 14px; height: 14px; }
  button.copy:hover { filter: none; color: hsl(var(--foreground)); border-color: hsl(var(--muted-foreground)); }
  button.copy.copied { color: hsl(var(--success)); border-color: hsl(var(--success)); }
  main { padding: 0 24px 24px; }
  .card {
    background: hsl(var(--card)); border: 1px solid hsl(var(--border));
    border-radius: var(--radius); overflow-x: auto;
  }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid hsl(var(--border)); white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  th { color: hsl(var(--muted-foreground)); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  /* The issuance data is all monospaced. */
  td { font-family: var(--font-mono); font-size: 13px; }
  .ok { color: hsl(var(--success)); font-weight: 500; }
  .bad { color: hsl(var(--destructive)); font-weight: 500; }
  .muted { color: hsl(var(--muted-foreground)); }
  .bar { display: inline-block; height: 6px; border-radius: 3px; background: hsl(var(--muted)); width: 84px; vertical-align: middle; overflow: hidden; margin-right: 8px; }
  .bar > span { display: block; height: 100%; background: hsl(var(--primary)); border-radius: 3px; }
  /* Monitors: three separate bordered badges, left-aligned to match the table
     below. The row shows only while signed in. */
  #status { display: none; align-items: center; gap: 10px; }
  #status.on { display: inline-flex; }
  .counter { display: none; align-items: center; gap: 6px; padding: 6px 10px; font-size: 13px; white-space: nowrap; color: hsl(var(--muted-foreground)); border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--card)); }
  .counter.live { display: inline-flex; }
  .counter .dot { width: 7px; height: 7px; border-radius: 50%; background: hsl(var(--success)); animation: pulse 2s infinite; }
  .counter .num { font-family: var(--font-mono); color: hsl(var(--foreground)); }
  /* Activity pills: dim + steady when idle, primary + pulsing when running. */
  .pill { display: none; align-items: center; gap: 6px; padding: 6px 10px; font-size: 13px; white-space: nowrap; color: hsl(var(--muted-foreground)); border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--card)); }
  .pill.show { display: inline-flex; }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: hsl(var(--muted-foreground)); }
  .pill.active { color: hsl(var(--foreground)); }
  .pill.active .dot { background: hsl(var(--primary)); animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  /* Sign-in modal. */
  .modal-backdrop { position: fixed; inset: 0; background: hsl(222 40% 4% / 0.55); display: none; align-items: center; justify-content: center; padding: 24px; z-index: 50; }
  .modal-backdrop.open { display: flex; }
  .modal { background: hsl(var(--card)); border: 1px solid hsl(var(--border)); border-radius: var(--radius); padding: 22px 22px 18px; width: min(420px, 92vw); box-shadow: 0 10px 40px hsl(222 40% 4% / 0.35); }
  .modal h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
  .modal p { margin: 0; color: hsl(var(--muted-foreground)); font-size: 13px; }
  .modal input { margin-top: 16px; width: 100%; min-width: 0; }
  .modal .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .modal-err { color: hsl(var(--destructive)); font-size: 13px; min-height: 18px; margin-top: 8px; }
  button.ghost { color: hsl(var(--foreground)); background: transparent; border: 1px solid hsl(var(--border)); }
  button.ghost:hover { filter: none; border-color: hsl(var(--muted-foreground)); }
  #summary { color: hsl(var(--muted-foreground)); font-size: 13px; margin: 4px 0 12px; }
  #meta { color: hsl(var(--muted-foreground)); margin-top: 14px; font-size: 12px; }
  #err { color: hsl(var(--destructive)); font-size: 13px; }
</style>
</head>
<body>
<header>
  <svg class="logo" viewBox="0 0 298 225" xmlns="http://www.w3.org/2000/svg" aria-label="XRPL">
    <path fill="currentColor" d="M68.5456 13.9416H73.9673V0.000139238H68.5456C62.7975 -0.00495441 57.1047 1.12348 51.7931 3.32086C46.4815 5.51824 41.6553 8.74144 37.5907 12.806C33.5262 16.8706 30.303 21.6968 28.1056 27.0084C25.9082 32.32 24.7798 38.0127 24.7849 43.7609V75.5165C24.7965 82.2404 22.2357 88.7141 17.6273 93.6105C13.019 98.5068 6.71227 101.455 0 101.85L0.387264 108.821L0 115.792C6.71227 116.187 13.019 119.136 17.6273 124.032C22.2357 128.928 24.7965 135.402 24.7849 142.126V178.722C24.7643 190.866 29.566 202.521 38.1348 211.126C46.7035 219.731 58.3382 224.582 70.482 224.613V210.671C62.0614 210.666 53.9872 207.319 48.033 201.365C42.0788 195.411 38.7315 187.336 38.7264 178.916V142.126C38.7322 135.558 37.1293 129.088 34.0577 123.282C30.986 117.477 26.5392 112.512 21.1059 108.821C26.5237 105.115 30.9588 100.147 34.0285 94.3446C37.0983 88.5425 38.7106 82.0807 38.7264 75.5165V43.7609C38.762 35.8633 41.9151 28.2994 47.4996 22.7149C53.0841 17.1304 60.6481 13.9773 68.5456 13.9416Z"/>
    <path fill="currentColor" d="M229.648 13.9414H224.227V-6.10352e-05H229.648C241.227 0.0307156 252.32 4.65727 260.489 12.8629C268.659 21.0685 273.236 32.1819 273.215 43.7607V75.5163C273.204 82.2402 275.765 88.7139 280.373 93.6103C284.981 98.5066 291.288 101.455 298 101.85L297.613 108.821L298 115.792C291.288 116.187 284.981 119.135 280.373 124.032C275.765 128.928 273.204 135.402 273.215 142.126V178.722C273.236 190.866 268.434 202.521 259.865 211.126C251.297 219.731 239.662 224.582 227.518 224.613V210.671C235.939 210.666 244.013 207.319 249.967 201.365C255.921 195.41 259.269 187.336 259.274 178.916V142.126C259.268 135.557 260.871 129.088 263.943 123.282C267.014 117.476 271.461 112.511 276.894 108.821C271.477 105.115 267.041 100.147 263.972 94.3444C260.902 88.5423 259.29 82.0805 259.274 75.5163V43.7607C259.294 39.8554 258.543 35.9844 257.064 32.37C255.585 28.7556 253.407 25.4688 250.654 22.6983C247.902 19.9278 244.629 17.7281 241.024 16.2254C237.42 14.7226 233.554 13.9465 229.648 13.9414Z"/>
    <path fill="currentColor" d="M199.828 56.1533H220.547L177.367 96.6224C169.62 103.632 159.544 107.514 149.097 107.514C138.649 107.514 128.573 103.632 120.826 96.6224L77.6465 56.1533H98.3651L131.089 86.7471C135.976 91.232 142.367 93.7204 149 93.7204C155.633 93.7204 162.024 91.232 166.911 86.7471L199.828 56.1533Z"/>
    <path fill="currentColor" d="M98.1717 168.459H77.4531L120.827 127.796C128.531 120.7 138.622 116.761 149.097 116.761C159.571 116.761 169.663 120.7 177.367 127.796L220.741 168.459H200.022L167.105 137.478C162.218 132.993 155.826 130.505 149.194 130.505C142.561 130.505 136.169 132.993 131.283 137.478L98.1717 168.459Z"/>
  </svg>
  <h1>XRPL Ingestor</h1>
  <span class="sub">operator dashboard · read-only</span>
  <button id="authbtn" class="authbtn">Login</button>
</header>
<div id="auth">
  <span id="status">
    <span id="act-backfill" class="pill"></span>
    <span id="act-discovery" class="pill"></span>
    <span id="ledger" class="counter"></span>
  </span>
  <span id="err"></span>
</div>
<div id="modal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="modal">
    <h2 id="modal-title">Admin sign-in</h2>
    <p>Enter the admin bearer token to access the dashboard.</p>
    <input id="token" type="password" placeholder="Admin bearer token" autocomplete="off" />
    <div id="modal-err" class="modal-err"></div>
    <div class="row">
      <button id="cancel" class="ghost" type="button">Cancel</button>
      <button id="submit" type="button">Sign in</button>
    </div>
  </div>
</div>
<main id="app" hidden>
  <div id="summary"></div>
  <div class="card">
    <table>
      <thead><tr>
        <th>ID</th><th>Kind</th><th>Identifier</th><th>Strategy</th><th>Enabled</th>
        <th>Accounts</th><th>Txns</th><th>Latest</th><th>Backfill</th><th>Coverage</th><th>Reconciliation</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div id="meta"></div>
</main>
<script>
(function () {
  // The admin token is never held here: it is exchanged at /admin/login for an
  // httpOnly, SameSite=Strict session cookie the browser sends automatically.
  // The cookie is invisible to JS, so 'live' just tracks whether we are in.
  var live = false;
  var el = function (id) { return document.getElementById(id); };
  // Icons from Lucide (ISC). Inlined to keep the page self-contained.
  var copyIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  var checkIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var loginIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg>';
  var logoutIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>';
  // Same-origin fetch; the session cookie rides along automatically.
  function api(path, opts) { var o = opts || {}; o.credentials = "same-origin"; return fetch(path, o); }
  function short(s) { return s ? (s.length > 18 ? s.slice(0, 12) + "\\u2026" + s.slice(-4) : s) : "\\u2014"; }
  function cell(tr, v, cls) { var td = document.createElement("td"); if (cls) td.className = cls; td.textContent = String(v); tr.appendChild(td); return td; }

  function copyText(text, btn) {
    var done = function () {
      btn.innerHTML = checkIcon; btn.classList.add("copied");
      setTimeout(function () { btn.innerHTML = copyIcon; btn.classList.remove("copied"); }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }
  // Identifier cell: truncated display + a button that copies the full value.
  function identifierCell(tr, label, full) {
    var td = document.createElement("td"); td.className = "mono";
    var span = document.createElement("span"); span.textContent = label; td.appendChild(span);
    if (full) {
      var btn = document.createElement("button"); btn.type = "button"; btn.className = "copy";
      btn.innerHTML = copyIcon; btn.title = "Copy " + full; btn.setAttribute("aria-label", "Copy " + full);
      btn.onclick = function () { copyText(full, btn); };
      td.appendChild(btn);
    }
    tr.appendChild(td);
  }

  function renderRow(s) {
    var i = s.issuance, bf = s.backfill;
    var total = bf.pending + bf.running + bf.completed + bf.failed;
    var tr = document.createElement("tr");
    cell(tr, i.id);
    cell(tr, i.kind);
    if (i.kind === "mpt") identifierCell(tr, short(i.mptIssuanceId), i.mptIssuanceId);
    else identifierCell(tr, i.currency + " / " + short(i.issuerAccount), i.issuerAccount);
    cell(tr, i.discoveryStrategy);
    cell(tr, i.enabled ? "yes" : "no", i.enabled ? "" : "muted");
    cell(tr, s.accounts);
    cell(tr, s.transactions);
    cell(tr, s.latestLedger === null ? "\\u2014" : s.latestLedger, "mono");
    var bfTd = document.createElement("td");
    var pct = total ? Math.round((bf.completed / total) * 100) : 0;
    bfTd.innerHTML = '<span class="bar"><span style="width:' + pct + '%"></span></span>';
    var t = document.createElement("span");
    t.textContent = bf.completed + "/" + total + " jobs, " + bf.totalTx + " tx" + (bf.failed ? (" \\u00b7 " + bf.failed + " failed") : "");
    bfTd.appendChild(t); tr.appendChild(bfTd);
    var covTd = cell(tr, s.coverage ? (s.coverage.min + "\\u2013" + s.coverage.max) : "\\u2014", "mono");
    covTd.title = "Conservative coverage: the ledger range over which every in-scope account is complete.";
    if (!s.lastReconciliation) cell(tr, "\\u2014", "muted");
    else cell(tr, s.lastReconciliation.passed ? "\\u2713 passed" : ("\\u2717 " + s.lastReconciliation.discrepancies + " off"),
              s.lastReconciliation.passed ? "ok" : "bad");
    return tr;
  }

  function setLoggedIn(yes) {
    el("authbtn").innerHTML = (yes ? logoutIcon : loginIcon) + "<span>" + (yes ? "Logout" : "Login") + "</span>";
  }

  function showSignedOut(msg) {
    live = false;
    setLoggedIn(false);
    el("app").hidden = true;
    el("status").classList.remove("on");
    el("err").textContent = msg || "";
    el("ledger").className = "counter";
    renderPill("act-backfill", null);
    renderPill("act-discovery", null);
  }

  async function load() {
    try {
      var res = await api("/admin/issuances");
      // Distinguish an expired session (was live) from a fresh page load (just
      // prompt, no error styling).
      if (res.status === 401) { showSignedOut(live ? "Session expired \\u2014 sign in again" : ""); return; }
      var data = await res.json();
      var statuses = await Promise.all(data.issuances.map(function (i) {
        return api("/admin/issuances/" + i.id).then(function (r) { return r.json(); });
      }));
      live = true;
      setLoggedIn(true);
      el("app").hidden = false;
      el("status").classList.add("on");
      var rows = el("rows"); rows.textContent = "";
      statuses.forEach(function (s) { rows.appendChild(renderRow(s)); });
      el("summary").textContent = data.issuances.length + " issuance(s) tracked";
      var act = data.activity || {};
      var bp = data.backfillProgress;
      var backfillLabel = bp && typeof bp.total === "number"
        ? "backfilling (" + bp.done + "/" + bp.total + ")"
        : "backfilling\\u2026";
      renderPill("act-backfill", act.backfill, backfillLabel, "backfill idle");
      renderPill("act-discovery", act.discovery, "new holder\\u2026", "discovery idle");
      var led = el("ledger");
      if (typeof data.latestLedger === "number") {
        led.innerHTML = '<span class="dot"></span><span>subscribed at ledger</span> <span class="num">' + data.latestLedger.toLocaleString() + "</span>";
        led.classList.add("live");
      } else {
        led.classList.remove("live");
      }
      el("meta").textContent = "updated " + new Date().toLocaleTimeString();
      el("err").textContent = "";
    } catch (e) { el("err").textContent = String(e); }
  }

  // An activity indicator: a labelled dot that pulses (primary) while the work
  // is running and sits dim + steady when idle. The detail / last-run time goes
  // in the tooltip to keep the inline label short.
  function renderPill(id, snap, activeLabel, idleLabel) {
    var p = el(id);
    if (!snap) { p.className = "pill"; p.textContent = ""; p.title = ""; return; }
    var active = !!snap.running;
    p.className = "pill show" + (active ? " active" : "");
    p.innerHTML = '<span class="dot"></span><span>' + (active ? activeLabel : idleLabel) + "</span>";
    if (active) p.title = snap.detail || activeLabel;
    else if (snap.lastFinishedAt) p.title = "last finished " + new Date(snap.lastFinishedAt).toLocaleString();
    else p.title = "not run yet";
  }

  function openModal() {
    el("modal-err").textContent = "";
    el("token").value = "";
    el("modal").classList.add("open");
    el("token").focus();
  }
  function closeModal() {
    el("modal").classList.remove("open");
    el("token").value = ""; // never leave the secret in the field
  }

  // Exchange the token for a session cookie. The token is sent once, in the
  // request body, and never stored — the cookie carries auth from here on.
  async function submitLogin() {
    var value = el("token").value.trim();
    if (!value) { el("modal-err").textContent = "Enter a token"; return; }
    el("modal-err").textContent = "";
    try {
      var res = await fetch("/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token: value }),
      });
      if (!res.ok) { el("modal-err").textContent = "Invalid token"; return; }
      closeModal();
      await load();
    } catch (e) { el("modal-err").textContent = String(e); }
  }

  async function signout() {
    try { await api("/admin/logout", { method: "POST" }); } catch (e) { /* ignore */ }
    showSignedOut("");
  }

  // One button toggles between opening the sign-in modal and logging out.
  el("authbtn").onclick = function () { if (live) signout(); else openModal(); };
  el("submit").onclick = submitLogin;
  el("cancel").onclick = closeModal;
  el("token").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitLogin();
    else if (e.key === "Escape") closeModal();
  });
  // Click outside the dialog (on the backdrop) dismisses it.
  el("modal").addEventListener("click", function (e) { if (e.target === el("modal")) closeModal(); });

  setLoggedIn(false); // render the Login icon+label before the first probe
  // Resume an existing session if the httpOnly cookie is still valid (a 401 just
  // leaves the Login button showing). Poll only while signed in.
  load();
  setInterval(function () { if (live) load(); }, 3000);
})();
</script>
</body>
</html>
`;
