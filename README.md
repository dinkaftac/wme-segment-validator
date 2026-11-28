# WME Segment Validator

A Tampermonkey userscript for the Waze Map Editor that finds segment and place problems in the current view, a managed area, a drive area, or a polygon you draw or import. Problems are highlighted under the roads on the map and listed in a clickable error list. It uses the official WME SDK only.

## Features

- **Scopes:** viewport, managed areas, drive areas, or a custom polygon (draw on the map, or import a shapefile `.zip`, GeoJSON, WKT or CSV).
- **Sweep area:** visits a whole area tile by tile, because WME only keeps segments near the screen in memory. The sweep can be **paused, resumed or stopped**. Large areas can be split into smaller cells.
- **Three severity tiers:** errors (red), warnings (amber), notes (blue).
- **Re-checks after saving:** edited segments and their neighbours are re-validated when a save finishes.
- **Clickable error list:** filter by severity or rule, sort by severity, distance or segment id, hide visited items, jump to a segment and optionally select it.
- **Export:** copy the list, download a CSV, or open the list in a separate sortable window. Importing a results CSV restores its issues.
- **Place checks:** a separate **Places** tab with built-in and custom rules.
- **Waze map problems:** driver-reported problems near segments are included as a rule.
- **Debug log:** copy the log and diagnostics from the panel instead of using F12.
- Settings, polygons, results, custom checks and place marks are remembered per browser.

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [wme-segment-validator.user.js](https://raw.githubusercontent.com/dinkaftac/wme-segment-validator/main/wme-segment-validator.user.js) and confirm the installation. Your userscript manager can then check for updates.
3. Open the Waze Map Editor using an address that includes a language, such as `https://www.waze.com/en-US/editor`. A **Validator** tab appears in the sidebar.

## Usage

1. In the **Roads** tab, choose an **Area**. To use your own, press **Draw** or **Import**.
2. Press **Scan Now** for what is loaded, or **Sweep area** for a whole area.
3. Click an item in the **Error list**, or use **Prev** and **Next**.
4. Fix and save in WME. **Re-check list** visits listed issues again and removes fixed ones.

The script loads [shpjs](https://github.com/calvinmetcalf/shapefile-js) from unpkg for shapefile import.

## Road rules

Rules are grouped by category in the **Roads** tab. Each can be switched on or off. Defaults apply until you change them.

#### Missing Info & Naming

| Rule | Severity | Default | Check |
|---|---|---|---|
| `NO_NAME` | Error | on | No address at all (no street, no city, no state) |
| `NO_STREET_CITY` | Warning | off | No street and no city (only the state is set) |
| `NO_STREET` | Warning | off | No street name (even if WME shows a city or state) |
| `NO_STATE` | Warning | on | City has no state |
| `NO_CITY` | Warning | on | No city |
| `LOWERCASE` | Note | on | Street name starts lowercase |
| `ABBREV` | Note | off | Abbreviated name (pattern below) |
| `EMPTY_ALT` | Warning | on | Empty alternate street |
| `NO_SPEED` | Note | on | No speed limit |
| `NO_HN` | Note | off | No house numbers |
| `LOCKED_ABOVE_RANK` | Note | off | Segment locked above your rank (read-only) |

#### Geometry & Direction

| Rule | Severity | Default | Check |
|---|---|---|---|
| `UNKNOWN_DIR` | Error | on | Direction unknown (not routable) |
| `SHORT` | Warning | on | Shorter than 5 m (not a dead end) |
| `MEDIAN_UTURN` | Warning | on | Median U-turn too short: one median segment under 16 m |
| `TWOWAY_FWY` | Error | on | Two-way Freeway / Ramp |
| `ELEV_FWY` | Note | on | Freeway not at ground level |
| `CITY_RAIL_FWY` | Warning | on | City set on Railroad / Freeway |
| `NAME_ROUNDABOUT` | Warning | on | Street name on roundabout |
| `ZERO_LEN` | Error | on | Zero-length segment (under 1 m) |
| `STUCK_VERTEX` | Warning | on | Stuck vertex: a geometry point sits on the end node |
| `SHARP_ANGLE` | Warning | off | Sharp geometry angle (under 90 degrees inside one segment) |

#### Topology & Connectivity

| Rule | Severity | Default | Check |
|---|---|---|---|
| `LOOP_SELF` | Error | on | Loop: one segment joins itself (A to B, B back to A). Split it so the loop has 3+ segments |
| `LOOP` | Warning | on | Loop: 2 segments share both end nodes (A and B of one = A and B of the other). Add a junction node |
| `BDP` | Warning | on | Big Detour Prevention: off-and-on detour beside a direct highway route (penalised by Waze) |
| `UNCONNECTED` | Error | on | Not connected to any other segment |
| `SOFT_TURNS` | Warning | on | Unverified (soft) turns |
| `ONEWAY_TRAP` | Warning | on | One-way leads nowhere (no exit) |
| `ONEWAY_NOENTRY` | Warning | on | One-way cannot be entered |
| `UNNEEDED_NODE` | Warning | on | Unneeded node: 2 identical segments, remove 1 node |
| `NEAR_MISS` | Error | off | Loose end close to another road (distance in panel) (slow) |
| `OVERLAP` | Warning | off | Overlapping segments (same elevation) (slow) |
| `DUP_SEG` | Error | on | Duplicate segment: same nodes and same line, one hides the other (slow) |
| `OVERLAP_ALONG` | Warning | on | Lies on top of another road (the road underneath is hidden) (slow) |
| `COINCIDENT_ENDS` | Error | on | Ends exactly on another road's end but not connected (missing junction) (slow) |
| `CROSS_NO_JUNCTION` | Warning | on | Crosses another road at the same level without a junction (slow) |
| `UTURN_DEAD_END` | Warning | off | U-turn enabled at dead end (slow) |

#### Type Continuity

| Rule | Severity | Default | Check |
|---|---|---|---|
| `BC_NOT_STRAIGHT` | Warning | on | Best continuation is not the straightest road at this split (name/type match picks the angled branch) |
| `BC_TIE` | Note | on | Best continuation tie at a split: 2+ branches match the incoming road equally, so both get a Keep instruction |
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

#### Waze Map Problems (reported by drivers)

| Rule | Severity | Default | Check |
|---|---|---|---|
| `MP_OPEN` | Error | on | Open Waze map problem at this segment |

The distance for `NEAR_MISS` is set in the panel (1 to 30 m, default 5 m). The pattern for `ABBREV` is editable.

## Place checks

Open the **Places** tab and tick **Check places** (off by default). The place scan is then added to every scan and sweep, using the area chosen in the **Roads** tab.

- Filter by severity, mark or rule, sort the list, and search by name or ID.
- **G** opens Google Maps so you can review the place. **⚑** marks it as checked, closed or moved.
- **Custom checks (regex):** add your own checks, test them on places in view, and see them marked with ★.
- **Export CSV** saves the listed places with their issues, marks and links.
- Google closed-status rules depend on the Google place data that WME provides.

Rules marked **(MY)** follow Malaysian conventions.

<details>
<summary>All place rules</summary>

| Rule | Severity | Default | Check |
|---|---|---|---|
| `P_NO_NAME` | Warning | on | Place has no name |
| `P_NAME_SPACE` | Note | on | Name has extra spaces |
| `P_NAME_CAPS` | Note | on | Name is ALL CAPS |
| `P_NAME_LOWER` | Note | on | Name starts lowercase |
| `P_NO_CAT` | Warning | on | No category |
| `P_NO_STREET` | Warning | on | Address: no street |
| `P_NO_CITY` | Warning | on | Address: no city |
| `P_NO_STATE` | Warning | on | Address: no state |
| `P_NO_HN` | Note | off | Address: no house number |
| `P_HN_SPACE` | Warning | on | House number has a space (e.g. "12 A"; use 12A or 12-1) |
| `P_HN_WORDS` | Warning | on | House number holds a street/area/building name (only the number belongs here) |
| `P_HN_PLACEHOLDER` | Note | on | House number looks like a placeholder or phone number (leave blank if unknown) |
| `P_HN_CASE` | Note | on | House number has lowercase letters (community standard: uppercase, e.g. 123A) |
| `P_HN_DASHLETTER` | Note | on | Sub-letter written with a hyphen (123-A; use 123A) |
| `P_HN_FORMAT` | Warning | on | House number has odd symbols or a stray - / at the start or end |
| `P_CITY_AREA` | Warning | on | City field looks like a Taman / Kampung / Zone (use the official city or council name) |
| `P_NAME_ADDRESS` | Warning | on | Name has an address, phone or website in it (name only, no details) |
| `P_SCHOOL_PREFIX` | Note | on | School name should use the short prefix (SK, SMK, SJK (C)...) (MY) |
| `P_SCHOOL_NO_ALT` | Note | on | School has no alternate name (put the full spelled-out name there) (MY) |
| `P_STREET_AREA` | Warning | on | Street field has Taman / Kampung / Seksyen, a number or the city name (street name only) (MY) |
| `P_PHONE_MY` | Note | on | Phone not in WazeMY format, e.g. 012-345 6789 or 03-1234 5678 (one number, no +60) (MY) |
| `P_URL_FORMAT` | Note | on | Website has http(s):// or tracking parameters (use www.example.com) |
| `G_CLOSED_LINKED` | Error | on | Google says this place is permanently closed, and it is linked to a Waze place (WME data) |
| `G_TEMP_LINKED` | Warning | on | Google says this place is temporarily closed, and it is linked to a Waze place (WME data) |
| `G_NOT_IN_WAZE` | Note | off | Google place shown by WME with no Waze place linked yet (check it, add it if it is real) |
| `P_NO_EXT` | Note | on | Not linked to a Google place (check it exists) |
| `P_DUP_LINK` | Warning | on | Same Google place linked to 2+ places |
| `P_DUP_NEAR` | Warning | on | Same name within 30 m |
| `P_PUR` | Warning | on | Pending update request / not yet approved |
| `P_NO_CONTACT` | Note | off | No phone and no website |
| `P_NO_HOURS` | Note | off | No opening hours |
| `P_OLD_IMAGE` | Note | off | No photo, or newest photo is old (years in panel) |

</details>

## Optional: background map-problem scan (unofficial)

The panel includes a separate, opt-in scan that asks WME's own feature service for open map problems without moving the map. It is not part of the SDK and can stop working after any WME update. The SDK-based **Sweep area** is the supported route.

## Notes

- Road type ids used by the rules (Street 1, Primary 2, Freeway 3, Ramp 4, Major Hwy 6, Minor Hwy 7, Railroad 18) follow WME's usual ids. Use **Copy diagnostics** in the Debug log section if a rule behaves oddly in your region.
- Neighbour-based rules are skipped for segments whose neighbours are not loaded yet, to avoid false dead-end reports.

## Contributing

Issues and pull requests are welcome. When reporting a bug, include the output of **Copy diagnostics** from the Debug log section.

## License

MIT, see [LICENSE](LICENSE).
