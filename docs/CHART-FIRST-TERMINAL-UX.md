# QSYN chart-first terminal UX — operator and acceptance notes

The OpenAlgo trading-terminal screenshot is a **workflow benchmark**: information hierarchy, compact controls, chart-first space, auxiliary panels and chart utility access. QSYN retains its own branding, standalone frontend and explicitly simulated market data. It does not copy OpenAlgo's full application shell or falsely implement live order controls.

## User-facing design changes

- **Primary chart first:** A full-width, large synthetic premium chart, followed by compact accountless metrics, available leg charts (up to four), option-chain/payoff, Greeks/risk, historical replay, browser-local paper journal and foreground alerts.
- **Single sticky chart toolbar:** symbol, candle interval, simulated expiry horizon, update-chart, replay, workspaces, alerts and paper-journal shortcuts.
- **Offcanvas strategy builder:** collapses by default to preserve chart space, opens from the toolbar/dock, closes with Escape/backdrop, uses ARIA expanded/hidden state and a basic keyboard focus loop. Strategy values remain synchronized with the toolbar controls.
- **Light default + dark option:** Theme is local browser preference; the OpenAlgo Charts widgets are reconstructed with the selected corresponding theme.
- **Persistent slim bottom dock:** navigates to strategies, paper positions, Greeks, replay and alerts, while showing simulation/non-broker status.
- **Responsive:** compact top navigation and safe button sizing on tablets/phones, no forced horizontal page scroll, reduced-motion support.

## Operational boundaries

No real order controls, login prompts, broker credentials, account activation, Supervisor changes, Rust restart, CSS/JS from third parties, database migration, or new backend routes were introduced. The quote/pricing APIs and their security contracts are unchanged. Full widget keyboard behavior remains provided by OpenAlgo Charts.

## CI evidence required

Chromium acceptance checks:
1. The first chart is at least 1,100 pixels wide at a 1,512px desktop viewport and the builder starts closed.
2. Symbol, interval, and horizon controls synchronize with the strategy state.
3. Drawer opens, reports its accessibility state and closes on Escape.
4. Light/dark theme toggling rebuilds charts without throwing, and no pages falsely advertise a live feed.
5. Four-leg configuration renders four OpenAlgo canvas chart widgets and Gamma precision is preserved.
6. Existing synthetic scenario, replay widget cleanup, paper open/close, threshold alerts, browser-only workspace storage, and private mock-account 404 tests remain passing.

This is a UI/UX release, **not** a live-market-data milestone. The separate operator-only OpenAlgo bridge introduced in the prior release remains off; actual authorized broker streaming still requires credentials, approved provider environment and validated subscription entitlements.
