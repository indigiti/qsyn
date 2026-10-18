# QSYN Terminal — lean navigation (18 October 2026)

The four core sections are Dashboard, Markets, Data Providers and Diagnostics. The dashboard shows the working browser subscription toggle, safe source verification links, and no duplicate synthetic chart or fake broker-connectivity KPIs.

Optional functionality remains on its own protected path: `/qsyn/terminal/strategy` (simulated research), `/qsyn/terminal/workspaces` (saved browser/private opt-in layouts), `/qsyn/terminal/private-live` (private CE/PE) and `/qsyn/terminal/operations` (administrator-only Rust controls).

Existing bookmarks redirect without losing saved workspaces:

| Retired URL | Destination |
| --- | --- |
| `/qsyn/terminal/trading` | `/qsyn/terminal/workspaces` |
| `/qsyn/terminal/tools` | `/qsyn/terminal/markets` |
| `/qsyn/terminal/routes` | `/qsyn/terminal/diagnostics` |

The existing `/qsyn/studio`, `/qsyn/admin/rust`, and `/qsyn/legacy-chart` aliases remain. Source access/entitlement verification, Rust services, Wick Science, OHLC backfill, and browser state isolation are unchanged. Source changes and a successful release artifact do not verify Cloudways deployment or remove old files from an overlay deployment.
