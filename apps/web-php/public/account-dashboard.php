<?php
declare(strict_types=1);
// Included only from the three-switch development-only gate in index.php.
$dashboardJsVersion = (string) (@filemtime(__DIR__ . '/assets/account-dashboard.js') ?: '0');
$dashboardCssVersion = (string) (@filemtime(__DIR__ . '/assets/account-dashboard.css') ?: '0');
$chartJsVersion = (string) (@filemtime(__DIR__ . '/assets/account-chart.js') ?: '0');
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>QSYN — Mock Account Workspace</title>
  <link rel="stylesheet" href="/qsyn/assets/account-dashboard.css?v=<?= rawurlencode($dashboardCssVersion) ?>">
  <script src="/qsyn/assets/account-chart.js?v=<?= rawurlencode($chartJsVersion) ?>" defer></script>
  <script src="/qsyn/assets/account-dashboard.js?v=<?= rawurlencode($dashboardJsVersion) ?>" defer></script>
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <a href="/qsyn/" class="brand" aria-label="QSYN foundation home"><span class="brand-mark">Q</span><span>QSYN</span></a>
      <span class="environment-label">DEVELOPMENT / SIMULATED ONLY</span>
      <div class="topbar-end">
        <span id="session-label" class="session-label"></span>
        <button id="signout-button" class="button ghost" type="button" hidden>Sign out</button>
      </div>
    </header>
    <main class="layout">
      <div id="page-message" role="status" aria-live="polite" class="message">Checking private QSYN identity…</div>
      <section id="sign-in" class="login-panel" hidden aria-labelledby="signin-title">
        <div class="eyebrow">PRIVATE TEST WORKSPACE</div>
        <h1 id="signin-title">Sign in to QSYN</h1>
        <p class="muted">Use a test-only identity seeded privately by a developer. No broker credentials or live accounts are accepted.</p>
        <form id="login-form">
          <label for="tenant-input">Test tenant</label>
          <input id="tenant-input" name="tenant" required autocomplete="off" minlength="2" maxlength="64" placeholder="tenant-one">
          <label for="user-input">Username</label>
          <input id="user-input" name="username" required autocomplete="username" minlength="3" maxlength="48" placeholder="alice">
          <label for="password-input">Test password</label>
          <input id="password-input" name="password" type="password" required autocomplete="current-password">
          <button id="login-button" class="button primary full" type="submit">Sign in</button>
        </form>
        <p class="small-muted">Account registration, Upstox OAuth and order execution are not available in this phase.</p>
      </section>
      <div id="workspace" hidden>
        <div class="intro">
          <div>
            <div class="eyebrow">ACCOUNT WORKSPACE · PHASE 1.5</div>
            <h1>Connected mock accounts</h1>
            <p class="muted">Select a simulated broker identity to preview its own synthetic chart fixture. This is never real market data.</p>
          </div>
          <div class="intro-actions"><button id="show-accounts-button" type="button" class="button ghost">Show accounts</button> <button id="refresh-button" type="button" class="button ghost">Refresh</button></div>
        </div>
        <div id="workspace-grid" class="workspace-grid">
          <section class="panel accounts-panel" aria-labelledby="accounts-title">
            <div class="panel-top"><div><h2 id="accounts-title">Accounts</h2><span class="small-muted">Scoped to your QSYN test identity</span></div><span id="account-count" class="count">0</span></div>
            <ul id="account-list" class="account-list" aria-label="Mock broker accounts"></ul>
            <p id="empty-accounts" class="empty-text" hidden>No mock accounts yet. Add a simulated identity below.</p>
            <div id="account-write-panel" class="form-wrap">
              <h3>Add mock account</h3>
              <form id="add-form">
                <label for="broker-input">Broker (mock)</label>
                <select id="broker-input" required>
                  <option value="upstox">Upstox — simulated</option>
                  <option value="dhan">Dhan — simulated</option>
                  <option value="zerodha">Zerodha — simulated</option>
                </select>
                <label for="reference-input">Mock reference</label>
                <input id="reference-input" required placeholder="mock-upstox-a" pattern="mock-[a-zA-Z0-9_-]{1,32}" maxlength="37">
                <label for="label-input">Display label</label>
                <input id="label-input" required maxlength="60" placeholder="Upstox A">
                <button id="add-button" type="submit" class="button primary full">Add simulated account</button>
              </form>
            </div>
            <p id="readonly-message" class="small-muted" hidden>Viewer access: you can inspect accounts but cannot change them.</p>
          </section>
          <section class="panel chart-panel" aria-labelledby="chart-title">
            <div class="panel-top chart-heading">
              <div>
                <div class="eyebrow">ACCOUNT-SCOPED PREVIEW</div>
                <h2 id="chart-title">Synthetic candlestick fixture</h2>
              </div>
              <span class="pill">NO ORDERS</span>
            </div>
            <div id="chart-source-label" class="source-label">No mock chart source selected</div>
            <form id="workspace-form" class="workspace-preferences" hidden>
              <div class="workspace-preferences-title">Saved chart workspace <span id="workspace-revision" class="small-muted"></span></div>
              <div class="workspace-fields">
                <div><label for="workspace-theme">Chart theme</label><select id="workspace-theme"><option value="dark">Dark</option><option value="light">Light</option></select></div>
                <div><label for="workspace-visible">Visible bars</label><select id="workspace-visible"><option value="60">60 candles</option><option value="100">100 candles</option><option value="120">120 candles</option></select></div>
                <div><label for="workspace-layout">Workspace layout</label><select id="workspace-layout"><option value="split">Split view</option><option value="focus">Chart focus</option></select></div>
                <button id="workspace-save" type="submit" class="button primary">Save chart view</button>
              </div>
            </form>
            <div id="chart-empty" class="chart-empty"><div class="empty-icon">▥</div><strong>Select a mock account</strong><p>Only the selected account's server-authorized demonstration candles will load here.</p></div>
            <div id="account-chart" hidden aria-label="Account scoped mock candlestick chart"></div>
            <p class="small-muted chart-footnote">Synthetic OHLC values generated locally by QSYN for each mock identity. Not Upstox quotes, not exchange ticks, and not a trading interface. No real-time subscriptions.</p>
          </section>
        </div>
      </div>
    </main>
  </div>
</body>
</html>
