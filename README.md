wme-segment-validator# WME Segment Validator

A Tampermonkey userscript for the [Waze Map Editor](https://www.waze.com/editor) that finds segment problems in the current view, a managed area, a drive area, or a polygon you draw or import. Problems are highlighted under the roads on the map and listed in a clickable error list. It uses the official WME SDK only.

## Features

- **Scopes:** viewport, managed areas, drive areas, or a custom polygon (draw on the map, or import a shapefile `.zip`, GeoJSON, WKT or CSV).
- **Sweep area:** visits a whole area tile by tile, because WME only keeps segments near the screen in memory. The sweep can be **paused, resumed or stopped**.
- **Three severity tiers:** errors (red), warnings (amber), notes (blue).
- **Re-checks after saving:** edited segments and their neighbours are re-validated when a save finishes.
- **Clickable error list:** filter by severity or rule, sort by severity, distance or segment id, hide visited items, jump to a segment and optionally select it.
- **Export:** copy the list, download a CSV, or open the list in a separate sortable window.
- **Waze map problems:** driver-reported problems near segments are included as a rule.
- **Debug log:** copy the log and diagnostics from the panel instead of using F12.
- Settings and imported polygons are remembered per browser.

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. Open [wme-segment-validator.user.js](https://raw.githubusercontent.com/dinkaftac/wme-segment-validator/main/wme-segment-validator.user.js). Tampermonkey will offer to install it, and will check for updates automatically.
3. Open the Waze Map Editor. A **Validator** tab appears in the sidebar.

The script loads [shpjs](https://github.com/calvinmetcalf/shapefile-js) from unpkg for shapefile import.

## Rules

Rules are grouped by category in the panel. Each can be switched on or off.

#### Missing Info & Naming

| Rule | Severity | Default | Check |
|---|---|---|---|
| `NO_NAME` | Warning | on | No street name |
| `NO_CITY` | Warning | on | No city |
| `LOWERCASE` | Note | on | Street name starts lowercase |
| `ABBREV` | Note | off | Abbreviated name (pattern is editable) |
| `EMPTY_ALT` | Warning | on | Empty alternate street |
| `NO_SPEED` | Note | on | No speed limit |
| `NO_HN` | Note | off | No house numbers |
| `LOCKED_ABOVE_RANK` | Note | off | Segment locked above your rank (read-only) |
| `UNVERIFIED_SPEED` | Warning | on | Unverified speed limit |

#### Geometry & Direction

| Rule | Severity | Default | Check |
|---|---|---|---|
| `UNKNOWN_DIR` | Error | on | Direction unknown (not routable) |
| `SHORT` | Warning | on | Shorter than 5 m (not a dead end) |
| `TWOWAY_FWY` | Error | on | Two-way Freeway / Ramp |
| `ELEV_FWY` | Note | on | Freeway not at ground level |
| `CITY_RAIL_FWY` | Warning | on | City set on Railroad / Freeway |
| `NAME_ROUNDABOUT` | Warning | on | Street name on roundabout |

#### Topology & Connectivity

| Rule | Severity | Default | Check |
|---|---|---|---|
| `LOOP` | Error | on | Segment closes on itself, or 2 segments share both nodes |
| `UNCONNECTED` | Error | on | Not connected to any other segment |
| `SOFT_TURNS` | Warning | on | Unverified (soft) turns |
| `ONEWAY_TRAP` | Warning | on | One-way leads nowhere (no exit) |
| `ONEWAY_NOENTRY` | Warning | on | One-way cannot be entered |
| `UNNEEDED_NODE` | Warning | on | Node joining 2 identical segments, remove 1 node |
| `NEAR_MISS` | Error | off | Loose end within 10 m of another road (slow) |
| `OVERLAP` | Warning | off | Overlapping segments at the same elevation (slow) |
| `UTURN_DEAD_END` | Warning | off | U-turn enabled at dead end (slow) |

#### Type Continuity

| Rule | Severity | Default | Check |
|---|---|---|---|
| `JUMP` | Warning | on | Abrupt jump: Street > Highway > Street |
| `FWY_TO_STREET` | Warning | on | Freeway meets Street without ramp |
| `RBT_TYPE` | Warning | on | Roundabout type lower than connected roads |
| `RAMP_SAME` | Warning | on | Ramp joins two roads of the same type |

#### Restrictions & Closures

| Rule | Severity | Default | Check |
|---|---|---|---|
| `EXPIRED_RESTR` | Warning | on | Expired restriction |
| `HAS_RESTR` | Note | off | Has restrictions |
| `HAS_CLOSURE` | Note | off | Has closures |
| `ACTIVE_CLOSURE` | Error | on | Segment has an active closure |
| `CLOSED_NAME` | Warning | on | Name contains "(closed)" |

#### Waze Map Problems

| Rule | Severity | Default | Check |
|---|---|---|---|
| `MP_OPEN` | Warning | on | Open Waze map problem at this segment |

## Optional: background map-problem scan (unofficial)

The panel includes a separate, opt-in scan that asks WME's own feature service for open map problems without moving the map. It is not part of the SDK and can stop working after any WME update. The SDK-based **Sweep area** is the supported route.

## Notes

- Road type ids used by the rules (Street 1, Primary 2, Freeway 3, Ramp 4, Major Hwy 6, Minor Hwy 7, Railroad 18) follow WME's usual ids. Use **Copy diagnostics** in the Debug log section if a rule behaves oddly in your region.
- Neighbour-based rules are skipped for segments whose neighbours are not loaded yet, to avoid false dead-end reports.

## Contributing

Issues and pull requests are welcome. When reporting a bug, include the output of **Copy diagnostics** from the Debug log section.

## License

MIT, see [LICENSE](LICENSE).
