# Native OpenAlgo Charts workspaces and indicator templates — QSYN

QSYN uses pinned `openalgo-charts@2.6.0`. This implementation passes an actual
`WorkspaceRepository` from `openalgo-charts/workspace` into the native
`createWidget({ workspaces })` API. It is not a QSYN-cloned menu.

## What is enabled

- **Public chart-only homepage (`/qsyn/`)**: the native Layouts button appears
  as a compact icon in the chart toolbar. It saves, opens, renames, deletes,
  duplicates and optionally autosaves **single-chart** layouts. The native
  Indicators picker has a Templates button for saving and reapplying indicator
  sets, including replace/append handling and library-provided undo semantics.
- **Simulated Terminal (`/qsyn/terminal?view=trading`)**: native *indicator
  templates* are enabled on its browser-scoped primary and secondary widgets.
  `layouts:false` deliberately keeps the existing QSYN saved layout controls
  authoritative: the OpenAlgo native controller otherwise auto-reopens the
  previously active chart on every remount, interfering with the QSYN instrument
  picker and two-chart comparison. A future chart-grid migration can replace
  this dual system after legacy state compatibility is tested.
- **Private chart sessions**: no native browser workspace store is provided.
  The pre-existing authenticated private-file logic remains separate.

## Persistence model

Stores are `WorkspaceRepository(createIndexedDbWorkspaceStorage(window.indexedDB))`,
backed by the database `qsyn-simulated-openalgo-workspaces-v1` and a single
public-simulation namespace `qsyn-public-simulated-v1-charts`. The homepage
uses its Layouts menu; the simulated Terminal shares indicator templates
without auto-opening a layout. All are local to this browser + origin; no Python app,
SQL, Upstox credentials, network sync or broker session is involved.

If IndexedDB is not available, the native repository is not passed in, rather
than advertising a Save button that writes to ephemeral RAM. If storage is
blocked or corrupt, OpenAlgo reports the load/save failure; existing catalogs
are never silently overwritten.

Older QSYN layouts under `qsyn-terminal-browser-workspaces-v2` are untouched.
The two formats are **not** silently migrated or deleted. Existing QSYN
two-chart layouts can still be selected in the full Terminal. Native homepage
layouts are separate, single-chart documents. Native indicator templates are shared across public simulated charts.

## Boundaries and future work

The feed is still a whitelist of simulated `QSYN` instruments and 1m bars.
Restoring/importing a native workspace does not authorize new instruments,
licensed market data, a broker or orders. The native workspace codec excludes
credentials/orders/positions; QSYN must also never place secrets into drawing
annotations or custom values. Production authenticated workspaces need an
account-scoped `WorkspaceStore` server adapter with validated access control.

Native multi-chart layouts, layout import/export UI, automatic migration of
older QSYN layouts and cross-account synchronization are intentionally not
activated in this phase. Those belong to a separately tested `createChartGrid`
adoption, not a change to the homepage chart.
