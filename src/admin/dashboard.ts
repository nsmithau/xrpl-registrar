/**
 * The read-only operator dashboard, embedded as a single self-contained HTML
 * document (no build step, no external assets). Served on the admin port.
 *
 * The shell carries no data; it prompts for the admin bearer token and reads
 * the same authenticated `/admin/issuances` endpoints the API exposes, so the
 * dashboard can never drift from the API and account data stays behind auth.
 * Read-only in v1: it shows progress and coverage, and mutates nothing.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>xrpl-ingestor · operator dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; }
  header { padding: 16px 24px; border-bottom: 1px solid #8883; display: flex; align-items: baseline; gap: 12px; }
  header h1 { font-size: 18px; margin: 0; }
  header .sub { color: #888; font-size: 13px; }
  main { padding: 24px; }
  #auth { padding: 24px; display: flex; gap: 8px; align-items: center; }
  input { padding: 6px 8px; border: 1px solid #8886; border-radius: 6px; font: inherit; min-width: 280px; background: transparent; color: inherit; }
  button { padding: 6px 14px; border: 1px solid #8886; border-radius: 6px; background: #4472ff; color: #fff; cursor: pointer; font: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #8882; white-space: nowrap; }
  th { color: #888; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .ok { color: #17924a; } .bad { color: #cc3344; } .muted { color: #888; }
  .bar { display: inline-block; height: 8px; border-radius: 4px; background: #8883; width: 90px; vertical-align: middle; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: #4472ff; }
  #meta { color: #888; margin-top: 16px; font-size: 12px; }
  #err { color: #cc3344; }
</style>
</head>
<body>
<header><h1>xrpl-ingestor</h1><span class="sub">operator dashboard · read-only</span></header>
<div id="auth">
  <input id="token" type="password" placeholder="Admin bearer token" autocomplete="off" />
  <button id="connect">Connect</button>
  <span id="err"></span>
</div>
<main id="app" hidden>
  <div id="summary" class="muted"></div>
  <table>
    <thead><tr>
      <th>ID</th><th>Kind</th><th>Identifier</th><th>Strategy</th><th>Enabled</th>
      <th>Accounts</th><th>Backfill</th><th>Coverage</th><th>Reconciliation</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="meta"></div>
</main>
<script>
(function () {
  var token = sessionStorage.getItem("adminToken") || "";
  var el = function (id) { return document.getElementById(id); };
  function headers() { return { authorization: "Bearer " + token }; }
  function short(s) { return s ? (s.length > 18 ? s.slice(0, 12) + "\\u2026" + s.slice(-4) : s) : "\\u2014"; }
  function cell(tr, v, cls) { var td = document.createElement("td"); if (cls) td.className = cls; td.textContent = String(v); tr.appendChild(td); return td; }

  function renderRow(s) {
    var i = s.issuance, bf = s.backfill;
    var total = bf.pending + bf.running + bf.completed + bf.failed;
    var tr = document.createElement("tr");
    cell(tr, i.id);
    cell(tr, i.kind);
    cell(tr, i.kind === "mpt" ? short(i.mptIssuanceId) : (i.currency + " / " + short(i.issuerAccount)), "mono");
    cell(tr, i.discoveryStrategy);
    cell(tr, i.enabled ? "yes" : "no", i.enabled ? "" : "muted");
    cell(tr, s.accounts);
    var bfTd = document.createElement("td");
    var pct = total ? Math.round((bf.completed / total) * 100) : 0;
    bfTd.innerHTML = '<span class="bar"><span style="width:' + pct + '%"></span></span> ';
    var t = document.createElement("span");
    t.textContent = bf.completed + "/" + total + " jobs, " + bf.totalTx + " tx" + (bf.failed ? (" · " + bf.failed + " failed") : "");
    bfTd.appendChild(t); tr.appendChild(bfTd);
    cell(tr, s.coverage ? (s.coverage.min + "\\u2013" + s.coverage.max) : "\\u2014", "mono");
    if (!s.lastReconciliation) cell(tr, "\\u2014", "muted");
    else cell(tr, s.lastReconciliation.passed ? "\\u2713 passed" : ("\\u2717 " + s.lastReconciliation.discrepancies + " off"),
              s.lastReconciliation.passed ? "ok" : "bad");
    return tr;
  }

  async function load() {
    try {
      var res = await fetch("/admin/issuances", { headers: headers() });
      if (res.status === 401) { el("err").textContent = "Invalid token"; el("app").hidden = true; token = ""; return; }
      var data = await res.json();
      var statuses = await Promise.all(data.issuances.map(function (i) {
        return fetch("/admin/issuances/" + i.id, { headers: headers() }).then(function (r) { return r.json(); });
      }));
      var rows = el("rows"); rows.textContent = "";
      statuses.forEach(function (s) { rows.appendChild(renderRow(s)); });
      el("summary").textContent = data.issuances.length + " issuance(s) tracked";
      el("meta").textContent = "updated " + new Date().toLocaleTimeString();
      el("err").textContent = "";
    } catch (e) { el("err").textContent = String(e); }
  }

  function connect() {
    token = el("token").value.trim();
    sessionStorage.setItem("adminToken", token);
    el("app").hidden = false;
    load();
  }
  el("connect").onclick = connect;
  el("token").addEventListener("keydown", function (e) { if (e.key === "Enter") connect(); });
  if (token) { el("app").hidden = false; load(); }
  setInterval(function () { if (token) load(); }, 3000);
})();
</script>
</body>
</html>
`;
