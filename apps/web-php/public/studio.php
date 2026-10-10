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
  <a class="brand" href="/qsyn/studio" aria-label="QSYN Studio"><span class="mark">Q</span><span>QSYN <small>TERMINAL</small></span></a>
  <nav class="top-nav" aria-label="Terminal navigation">
    <a href="#chart-workspace" aria-current="page">Charts</a>
    <a href="#analysis-workspace">Strategies</a>
    <a href="#risk-title">Analytics</a>
    <a href="#paper-title">Paper</a>
    <a href="#alert-title">Alerts</a>
  </nav>
  <div class="top-actions"><span class="environment" aria-label="Market data provenance">● SIMULATED</span>
    <button type="button" id="toolbar-theme" class="icon-button" aria-label="Toggle light or dark theme" title="Toggle theme">◐</button>
    <a href="/qsyn/admin/rust" class="icon-link" title="Rust diagnostics">Diagnostics</a>
  </div>
</header>
<div class="announcement" role="note"><strong>SIMULATION MODE</strong> Fictional quotes and expiries · No exchange feed · No broker connection · All orders disabled</div>
<main>
<section class="heading">
 <div><p class="eyebrow">QSYN OPTIONS · CHART WORKSPACE</p><h1>Trading Terminal <span class="subtitle">Synthetic Studio</span></h1></div>
 <div class="heading-meta"><div class="pulse">● OFFLINE MARKET SIMULATION</div><div class="clock-label" id="asof">Historical demonstration · no live exchange feed</div></div>
</section>
<div class="terminal-toolbar" role="toolbar" aria-label="QSYN chart and strategy controls">
  <button type="button" id="toolbar-builder" class="toolbar-primary" aria-controls="strategy-drawer" aria-expanded="false">☰ Strategy builder</button>
  <label class="toolbar-field">Symbol <select id="toolbar-underlying" aria-label="Chart underlying"><option value="NIFTY">NIFTY</option><option value="BANKNIFTY">BANKNIFTY</option><option value="FINNIFTY">FINNIFTY</option></select></label>
  <label class="toolbar-field">Timeframe <select id="toolbar-interval" aria-label="Chart timeframe"><option value="1m">1m</option><option value="5m">5m</option><option value="15m">15m</option></select></label>
  <label class="toolbar-field">Horizon <select id="toolbar-expiry" aria-label="Demonstration horizon"><option value="W1">Demo W1</option><option value="W2">Demo W2</option><option value="M1">Demo M1</option></select></label>
  <button type="button" id="toolbar-render" class="toolbar-accent">↻ Update chart</button>
  <span class="toolbar-divider" aria-hidden="true"></span>
  <button type="button" id="toolbar-replay">⏪ Replay</button>
  <button type="button" id="toolbar-workspaces">▦ Workspaces</button>
  <button type="button" id="toolbar-alerts">♧ Alerts</button>
  <button type="button" id="toolbar-paper">◇ Paper journal</button>
  <span class="toolbar-grow"></span>
  <span class="toolbar-badge">NO LIVE ORDERS</span>
</div>
<div class="workspace" id="chart-workspace">
<div class="drawer-backdrop" id="drawer-backdrop" hidden></div>
<aside class="sidebar" id="strategy-drawer" aria-label="Options strategy builder" aria-hidden="true">
 <div class="drawer-top"><strong>Strategy workspace</strong><button type="button" class="icon-button" id="drawer-close" aria-label="Close strategy builder">✕</button></div>
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
 <section class="panel saved" id="workspace-storage"><div class="panel-heading"><h2>Local workspaces</h2><span class="pill">This browser only</span></div>
  <label class="field">Workspace name<input id="workspace-name" maxlength="40" placeholder="My NIFTY setup" value="My Strategy"></label>
  <div class="field-row"><button type="button" class="secondary" id="save">Save layout</button><button type="button" class="secondary" id="clear-saved">Clear saved</button></div>
  <div id="saved-list" class="saved-list" aria-live="polite"></div>
  <p class="fine">Saved in browser localStorage. No account, server database or broker account is used.</p>
 </section>
</aside>
<section class="content" aria-label="QSYN chart workspace">
 <section class="panel chart-card hero-chart" id="primary-chart-section">
  <div class="panel-heading"><div><p class="eyebrow">SYNTHETIC PREMIUM</p><h2 id="basket-title">Combined options basket</h2><p class="fine">Time-aligned leg samples; synthetic highs/lows are not sums of leg candle extrema.</p></div><span class="pill accent">120 BARS</span></div>
  <div id="basket-chart" class="chart main-chart" aria-label="Combined premium candlestick chart"></div>
 </section>
 <div class="metrics">
  <div class="metric"><span>Basket premium</span><strong id="premium">—</strong><small>Fictional points · unsigned sum</small></div>
  <div class="metric"><span>Entry cashflow</span><strong id="entry">—</strong><small>Notional points · not INR</small></div>
  <div class="metric"><span>Active legs</span><strong id="leg-count">—</strong><small>Max 4 contracts</small></div>
  <div class="metric"><span>Data status</span><strong class="positive">SIMULATED</strong><small>No orders · No API keys</small></div>
 </div>
 <div class="two-col" id="leg-chart-grid" aria-label="All strategy leg charts">
  <section class="panel chart-card" id="leg-panel-0"><div class="panel-heading"><h2 id="leg-title-0">Leg 1</h2><span class="pill">SIM</span></div><div id="leg-chart-0" class="chart leg-chart" aria-label="Simulated leg 1 candlestick chart"></div></section>
  <section class="panel chart-card" id="leg-panel-1"><div class="panel-heading"><h2 id="leg-title-1">Leg 2</h2><span class="pill">SIM</span></div><div id="leg-chart-1" class="chart leg-chart" aria-label="Simulated leg 2 candlestick chart"></div></section>
  <section class="panel chart-card" id="leg-panel-2" hidden><div class="panel-heading"><h2 id="leg-title-2">Leg 3</h2><span class="pill">SIM</span></div><div id="leg-chart-2" class="chart leg-chart" aria-label="Simulated leg 3 candlestick chart"></div></section>
  <section class="panel chart-card" id="leg-panel-3" hidden><div class="panel-heading"><h2 id="leg-title-3">Leg 4</h2><span class="pill">SIM</span></div><div id="leg-chart-3" class="chart leg-chart" aria-label="Simulated leg 4 candlestick chart"></div></section>
 </div>
 <div class="two-col lower" id="analysis-workspace">
  <section class="panel"><div class="panel-heading"><div><p class="eyebrow">SCENARIO ANALYSIS</p><h2>Hypothetical expiry payoff</h2></div><span class="pill">NO ORDERS</span></div>
   <canvas id="payoff" height="260" aria-label="Hypothetical expiry profit or loss over fictional settlement prices" role="img"></canvas>
   <p class="fine">Payoff excludes contract lot size, fees, taxes, slippage, volatility and real expiry dates. Illustrative premium points only.</p>
  </section>
  <section class="panel"><div class="panel-heading"><div><p class="eyebrow">OPTION CHAIN SNAPSHOT</p><h2>Nearby fictional strikes</h2></div><span class="pill">W1 REFERENCE</span></div>
    <div class="chain-wrap"><table><thead><tr><th>CE price</th><th>Strike</th><th>PE price</th></tr></thead><tbody id="chain"></tbody></table></div>
    <p class="fine">Chain previews use the W1 simulation, independent of selected payoff horizon. Never exchange LTP.</p>
  </section>
 </div>
 <div class="lab-section" id="terminal-lab">
 <section class="panel risk-panel" aria-labelledby="risk-title">
  <div class="panel-heading"><div><p class="eyebrow">SCENARIO + MODEL</p><h2 id="risk-title">Risk &amp; Greeks laboratory</h2></div><span class="pill">FICTIONAL MODEL</span></div>
  <div class="risk-grid">
   <div class="risk-item"><span>Sampled minimum P&amp;L</span><strong id="risk-min">—</strong></div>
   <div class="risk-item"><span>Sampled maximum P&amp;L</span><strong id="risk-max">—</strong></div>
   <div class="risk-item"><span>Sampled breakevens</span><strong id="risk-breakeven">—</strong></div>
   <div class="risk-item"><span>Premium max drawdown</span><strong id="risk-drawdown">—</strong></div>
  </div>
  <div class="greek-grid">
   <div><span>Model Δ (delta)</span><strong id="greek-delta">—</strong></div>
   <div><span>Model Γ (gamma)</span><strong id="greek-gamma">—</strong></div>
   <div><span>Model Vega / 1% vol</span><strong id="greek-vega_per_pct">—</strong></div>
   <div><span>Model Theta / day</span><strong id="greek-theta_per_day">—</strong></div>
  </div>
  <p class="fine" id="risk-warning">Illustrative risk analytics, not market values.</p>
 </section>
 <section class="panel" aria-labelledby="replay-title">
  <div class="panel-heading"><div><p class="eyebrow">HISTORICAL SIMULATION</p><h2 id="replay-title">120-bar strategy replay</h2></div><span class="pill">LOCAL TIMELINE</span></div>
  <p class="fine">Move through previously generated fictional candles. Only the basket chart rewinds; component panels retain their full histories. The slider does not request a live exchange feed.</p>
  <div class="replay-controls">
    <input id="replay-position" type="range" min="19" max="119" value="119" aria-label="Replay bar position">
    <output id="replay-marker" aria-live="polite">120 / 120 · full history</output>
    <div class="replay-buttons">
      <button type="button" id="replay-start" class="secondary">Start</button>
      <button type="button" id="replay-play" class="secondary">Play replay</button>
      <button type="button" id="replay-end" class="secondary">Latest</button>
    </div>
  </div>
 </section>
 <section class="panel" aria-labelledby="paper-title">
  <div class="panel-heading"><div><p class="eyebrow">PAPER EXECUTION ONLY</p><h2 id="paper-title">Simulated position journal</h2></div><span class="pill">BROWSER-LOCAL</span></div>
  <p class="fine">Practice opening and closing a fictional strategy at displayed leg premiums. P&amp;L is in premium points, not INR. No trade requests, server orders, holdings or broker accounts are created.</p>
  <div class="paper-actions">
    <button type="button" id="paper-open" class="primary">Open paper position only</button>
    <button type="button" id="paper-clear" class="secondary">Clear closed journal</button>
  </div>
  <div class="paper-overview">Open simulated positions: <strong id="paper-open-count">0</strong> / 5 · Per-position fictional premium cap 20,000</div>
  <div id="paper-positions" class="lab-records" aria-live="polite">No simulated paper positions recorded.</div>
 </section>
 <section class="panel" aria-labelledby="alert-title">
  <div class="panel-heading"><div><p class="eyebrow">FOREGROUND PRICE STUDY</p><h2 id="alert-title">Strategy alerts</h2></div><span class="pill">NOT SERVER MONITORED</span></div>
  <p class="fine">Set a simulated basket-premium threshold. Alerts evaluate when you view or replay candles in this tab only; they cannot notify you while the browser is closed.</p>
  <div class="alert-controls">
    <select id="alert-direction" aria-label="Alert direction"><option value="above">At or above</option><option value="below">At or below</option></select>
    <input id="alert-threshold" type="number" min="0.01" max="1000000" step="0.01" value="100" aria-label="Simulated premium threshold">
    <button type="button" id="alert-add" class="secondary">Add alert</button>
    <button type="button" id="alert-clear" class="secondary">Clear alerts</button>
  </div>
  <div id="alert-records" class="lab-records" aria-live="polite">No foreground simulation alerts yet.</div>
 </section>
 </div>
 <div id="status" role="status" aria-live="polite" class="status">Loading simulated strategy…</div>
</section>
</div>
<footer>QSYN Studio · Strategy simulation, not investment advice or a trading account. No Upstox/OpenAlgo credentials are requested.</footer>
</main>
<div class="terminal-dock" role="navigation" aria-label="Workspace shortcuts">
 <button type="button" data-panel="builder">Strategy <span id="dock-leg-count">2</span></button>
 <button type="button" data-panel="paper">Paper positions <span id="dock-paper-count">0</span></button>
 <button type="button" data-panel="risk">Greeks &amp; Risk</button>
 <button type="button" data-panel="replay">Replay</button>
 <button type="button" data-panel="alerts">Alerts</button>
 <span class="dock-spacer"></span><strong>SIMULATED · BROKER DISCONNECTED</strong>
</div>
</div>
<script src="/qsyn/assets/studio.js?v=<?= rawurlencode($jsVersion) ?>" defer></script>
</body></html>
