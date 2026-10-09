<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QSYN — Rust Service Administration</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{background:#0b111b;color:#e9f1ff;font:14px system-ui,sans-serif;margin:0}
header{padding:18px max(20px,calc((100vw - 900px)/2));border-bottom:1px solid #303b4b;background:#0d1625;display:flex;align-items:center;gap:18px}
a{color:#9bc6ff;text-decoration:none}main{max-width:900px;margin:35px auto;padding:0 22px}h1{font-size:24px}h2{font-size:16px;margin:0 0 8px}
.card{border:1px solid #334155;border-radius:12px;background:#111c2d;padding:22px;margin:20px 0}
.muted{color:#a5b9d0;line-height:1.6}.grid{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
button{border:1px solid #4b8bd8;background:#235ca5;color:white;cursor:pointer;border-radius:7px;padding:11px 18px;font-weight:600}
button:disabled{opacity:.45;cursor:not-allowed}button.danger{background:#732d36;border-color:#9a4d57}
button.secondary{background:#243246;border-color:#44546e}
input{background:#0c1625;border:1px solid #54647c;border-radius:7px;padding:12px;color:white;max-width:100%;min-width:260px}
label{display:block;margin-bottom:10px;font-weight:600}code{color:#b6daff}.status{font-weight:700;color:#ffd28a}
#feedback{min-height:24px;margin:15px 0;white-space:pre-wrap}[hidden]{display:none!important}
</style>
</head>
<body>
<header><strong>QSYN · Admin</strong><a href="/qsyn/">← Back to charts</a></header>
<main>
<h1>Rust service control</h1>
<p class="muted">Manage only the <code>qsyn-stream</code> service. Commands are restricted to an approved local service manager. This page does not provide shell access.</p>
<section class="card" id="admin-login">
  <h2>Administrator sign-in</h2>
  <p class="muted" id="login-help">Checking whether administrator control is configured…</p>
  <form id="login-form">
    <label for="admin-password">Administrator password</label>
    <div class="grid"><input type="password" id="admin-password" autocomplete="current-password" required><button type="submit" id="login-button">Sign in</button></div>
  </form>
</section>
<section class="card" id="admin-panel" hidden>
  <div class="grid" style="justify-content:space-between"><h2>Service: <code>qsyn-stream</code></h2><button type="button" id="logout" class="secondary">Sign out</button></div>
  <p class="muted">Address: <code>127.0.0.1:10251</code> (localhost only)</p>
  <p>Manager: <span class="status" id="manager-status">Checking…</span></p>
  <div class="grid">
    <button type="button" id="service-start" disabled>Start</button>
    <button type="button" id="service-stop" class="danger" disabled>Stop</button>
    <button type="button" id="service-restart" class="secondary" disabled>Restart</button>
    <button type="button" id="service-refresh" class="secondary">Refresh status</button>
  </div>
  <p class="muted">If controls are unavailable, Cloudways must enable the approved restricted runtime: direct Rust mode or Supervisor. Starting a binary requires PHP execution permission and host support; without a watchdog it will not auto-restart after a crash or reboot.</p>
</section>
<section class="card">
  <h2>Live connectivity</h2>
  <p class="muted">Checks whether PHP can reach the Rust HTTP endpoint and optional WebSocket handshake.</p>
  <div class="grid"><button type="button" class="secondary" id="probe-rust">Test Rust health</button><output class="status" id="probe-result">Not checked</output></div>
</section>
<section class="card">
  <h2>Demo WebSocket stream</h2>
  <p class="muted">Samples exactly two simulated quotes from Rust through PHP. Not connected to Upstox or a public WebSocket.</p>
  <div class="grid"><button type="button" class="secondary" id="rust-stream-test">Test demo stream</button><output class="status" id="rust-stream-result" role="status">Not tested</output></div>
  <p class="muted" id="rust-stream-samples" aria-live="polite">Demo streaming is disabled by default until Rust is started with QSYN_ENABLE_DEMO_WS=1.</p>
</section>
<p id="feedback" class="muted" role="status" aria-live="polite"></p>
</main>
<script src="/qsyn/assets/rust-admin.js" defer></script>
<script src="/qsyn/assets/rust-stream-test.js" defer></script>
</body>
</html>