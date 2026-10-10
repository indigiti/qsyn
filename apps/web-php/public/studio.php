<?php
declare(strict_types=1);
// Public read-only demo: no test users, broker sessions, orders or subscriptions.
$jsVersion = (string) (@filemtime(__DIR__ . '/assets/studio.js') ?: '0');
$cssVersion = (string) (@filemtime(__DIR__ . '/assets/studio.css') ?: '0');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#07111c">
<title>QSYN — Options & Synthetic Studio (Simulated)</title>
<link rel="stylesheet" href="/qsyn/assets/studio.css?v=<?= rawurlencode($cssVersion) ?>">
</head>
<body>
<div class="app">
<header class="topbar">
  <a class="brand" href="/qsyn/studio" aria-label="QSYN Studio"><span class="mark">Q</span><span>QSYN <small>STUDIO</small></span></a>
  <span class="environment">SIMULATED · NO ORDERS</span>
  <nav><a href="/qsyn/">Demo terminal</a><a href="/qsyn/admin/rust">Rust status</a></nav>
</header>
<div class="announcement" role="note"><strong>DEVELOPMENT SANDBOX</strong> All prices, strikes, expiry labels, charts and payoff values are fictional. No broker login, actual market feed, exchange option contracts or order execution.</div>
<main>
<section class="heading">
 <div><p class="eyebrow">MULTI-LEG OPTIONS LAB</p><h1>Options &amp; Synthetic Studio</h1><p>Build premium baskets, compare legs and explore simulated expiry payoff.</p></div>
 <div class="heading-meta"><div class="pulse">● OFFLINE MARKET SIMULATION</div><div class="clock-label" id="asof">Deterministic data · no live exchange feed</div></div>
</section>
<div class="workspace">
<aside class="sidebar">
 <section class="panel"><div class="panel-heading"><h2>Strategy builder</h2><span class="pill">1–4 legs</span></div>
  <label class="field">Underlying
   <select id="underlying"><option value="NIFTY">NIFTY (demo)</option><option value="BANKNIFTY">BANK NIFTY (demo)</option><option value="FINNIFTY">FIN NIFTY (demo)</option></select>
  </label>
  <div class="field-row">
   <label class="field">Simulated horizon<select id="expiry"><option value="W1">Demo W1</option><option value="W2">Demo W2</option><option value="M1">Demo M1</option></select></label>
   <label class="field">Candle interval<select id="interval"><option value="1m">1 minute</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option></select></label>
  </div>
  <div class="market-spot"><span>Fictional underlying level</span><strong id="spot">—</strong><small id="atm">ATM reference pending</small></div>
  <div class="panel-heading legs-heading"><h3>Option legs</h3><button id="add-leg" class="quiet" type="button">+ Add leg</button></div>
  <div id="legs" class="legs" aria-label="Strategy legs"></div>
  <div class="builder-actions"><button type="button" id="render" class="primary">Render synthetic basket <span>↗</span></button>
    <button type="button" id="straddle" class="secondary">ATM Straddle</button>
    <button type="button" id="strangle" class="secondary">OTM Strangle</button>
    <button type="button" id="reset" class="secondary">Reset</button></div>
  <div class="strategy-notes">BUY and SELL affect the hypothetical expiry payoff. The basket chart always shows the <strong>sum of positive leg premiums</strong> using synchronized simulated observations.</div>
 </section>
 <section class="panel saved"><div class="panel-heading"><h2>Local workspaces</h2><span class="pill">This browser only</span></div>
  <label class="field">Workspace name<input id="workspace-name" maxlength="40" placeholder="My NIFTY setup" value="My Strategy"></label>
  <div class="field-row"><button type="button" class="secondary" id="save">Save layout</button><button type="button" class="secondary" id="clear-saved">Clear saved</button></div>
  <div id="saved-list" class="saved-list" aria-live="polite"></div>
  <p class="fine">Saved in browser localStorage. No account, server database or broker account is used.</p>
 </section>
</aside>
<section class="content">
 <div class="metrics">
  <div class="metric"><span>Basket premium</span><strong id="premium">—</strong><small>Fictional points · unsigned sum</small></div>
  <div class="metric"><span>Entry cashflow</span><strong id="entry">—</strong><small>Notional points · not INR</small></div>
  <div class="metric"><span>Active legs</span><strong id="leg-count">—</strong><small>Max 4 contracts</small></div>
  <div class="metric"><span>Data status</span><strong class="positive">SIMULATED</strong><small>No orders · No API keys</small></div>
 </div>
 <section class="panel chart-card">
  <div class="panel-heading"><div><p class="eyebrow">SYNTHETIC PREMIUM</p><h2 id="basket-title">Combined options basket</h2><p class="fine">Time-aligned leg samples; synthetic highs/lows are not sums of leg candle extrema.</p></div><span class="pill accent">120 BARS</span></div>
  <div id="basket-chart" class="chart main-chart" aria-label="Combined premium candlestick chart"></div>
 </section>
 <div class="two-col">
  <section class="panel chart-card"><div class="panel-heading"><h2 id="leg-title-0">Leg 1</h2><span class="pill">SIM</span></div><div id="leg-chart-0" class="chart leg-chart"></div></section>
  <section class="panel chart-card"><div class="panel-heading"><h2 id="leg-title-1">Leg 2</h2><span class="pill">SIM</span></div><div id="leg-chart-1" class="chart leg-chart"></div></section>
 </div>
 <div class="two-col lower">
  <section class="panel"><div class="panel-heading"><div><p class="eyebrow">SCENARIO ANALYSIS</p><h2>Hypothetical expiry payoff</h2></div><span class="pill">NO ORDERS</span></div>
   <canvas id="payoff" height="260" aria-label="Hypothetical expiry profit or loss over fictional settlement prices" role="img"></canvas>
   <p class="fine">Payoff excludes contract lot size, fees, taxes, slippage, volatility and real expiry dates. Illustrative premium points only.</p>
  </section>
  <section class="panel"><div class="panel-heading"><div><p class="eyebrow">OPTION CHAIN SNAPSHOT</p><h2>Nearby fictional strikes</h2></div><span class="pill">W1 REFERENCE</span></div>
    <div class="chain-wrap"><table><thead><tr><th>CE price</th><th>Strike</th><th>PE price</th></tr></thead><tbody id="chain"></tbody></table></div>
    <p class="fine">Chain previews use the W1 simulation, independent of selected payoff horizon. Never exchange LTP.</p>
  </section>
 </div>
 <div id="status" role="status" aria-live="polite" class="status">Loading simulated strategy…</div>
</section>
</div>
<footer>QSYN Studio · Strategy simulation, not investment advice or a trading account. No Upstox/OpenAlgo credentials are requested.</footer>
</main>
</div>
<script src="/qsyn/assets/studio.js?v=<?= rawurlencode($jsVersion) ?>" defer></script>
</body></html>
