# Beam Editor — Architecture Reference

**AxtaBEAMS GSO Beam Footprint Editor** · v1.2 · 2026-07-08

Interactive tool for defining and visualising elliptical beam footprints from a geostationary (GSO) satellite. Renders on a rotatable, zoomable D3 orthographic globe. Supports up to 16 named beams, drag-to-repoint, and slant-range/elevation readouts.

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | React 18 + Vite 5 | Only tool in the repo that deviates from the single-file convention (see below) |
| Globe rendering | D3 v7 (geoOrthographic) | Fully imperative SVG, managed outside React's render cycle |
| Topology | TopoJSON + world-atlas@2 | Fetched from jsDelivr CDN at runtime |
| Math | Vanilla JS, WGS-84 | No WASM / no server — all geodesy runs in the browser |
| Styling | DM Mono + CSS custom properties | Light theme, mobile-first, iOS safe areas |

### Deviation from repo conventions

Every other tool in `html-tools/` is a **single self-contained HTML file** with inline CSS and JS, no build step. The beam editor uses a Vite+React multi-file build because:

- The 3-D geodesy math (`geodesy.js`) is large enough that co-locating it with rendering code would make the file unmanageable.
- The D3 render loop and React state machine each need their own scoped closure—splitting into component files makes the boundary explicit.
- `vite build` produces a deployable `dist/` that GitHub Pages can serve just like the other tools.

---

## Directory Layout

```
beam-editor/
  index.html              ← Vite entry (mounts #root)
  vite.config.js
  package.json
  src/
    main.jsx              ← React root (StrictMode → App)
    index.css             ← All CSS — design tokens, layout, component styles
    App.jsx               ← Central state machine (useReducer)
    lib/
      geodesy.js          ← WGS-84 math, beam geometry, ray-casting
      colors.js           ← 16-colour palette + hexToRgba
    components/
      GlobeCanvas.jsx     ← D3 SVG globe, all pointer/keyboard input
      ParamPanel.jsx      ← Vertical param editor (left of globe): cfg + beam table
      NumberInput.jsx     ← Shared uncontrolled numeric input (reset-safe on value change)
      HomeNav.jsx         ← Back-link to axta tools index
```

---

## State Architecture

All mutable application state lives in a single `useReducer` in `App.jsx`. There is no external state library, no context, no localStorage. State is ephemeral — refreshing the page resets everything.

### State shape

```js
{
  cfg: {
    satLon:  number,   // GSO satellite longitude, degrees E (−180…180)
    minElev: number,   // minimum elevation angle for footprint clip, degrees
  },
  beams: [
    {
      id:      number,  // monotonically increasing, never reused
      boreLat: number,  // boresight geodetic latitude, degrees
      boreLon: number,  // boresight geodetic longitude, degrees
      major:      number,  // half-beamwidth along major axis, degrees
      minor:      number,  // half-beamwidth along minor axis, degrees
      rot:        number,  // beam rotation from east, degrees (CCW positive)
      elliptical: boolean, // false = circular editing (single beamwidth field, major===minor); true = independent major/minor/rot fields exposed in ParamPanel
      enabled:    boolean, // false = beam is hidden from the globe render (footprint + ticks) but stays editable
      color:      string,  // hex colour from COLORS palette
    }
  ],
  selectedId: number | null,
  nextId:     number,
}
```

### Reducer actions

| Action | Payload | Description |
|---|---|---|
| `ADD_BEAM` | `boreLat?` | Appends a new beam, cloned from the last beam's size/shape. Capped at `MAX_BEAMS = 16`. |
| `DELETE_BEAM` | `id` | Removes beam; auto-selects the last remaining beam. |
| `SELECT_BEAM` | `id` | Changes `selectedId`. |
| `UPDATE_BEAM` | `id, patch` | Partial update (spread) of a beam object — used by `ParamPanel` (cfg/beamwidth/elliptical/enable edits) and drag-end. |
| `SET_SAT_LON` | `value` | Updates `cfg.satLon` **and** shifts every beam's `boreLon` by the same delta, preserving each beam's relative longitude from the satellite. |
| `SET_MIN_ELEV` | `value` | Updates `cfg.minElev` only; footprint is re-clipped on next redraw. |

### Data flow

```
User input (drag, inputs, keyboard, checkboxes)
        │
        ▼
  GlobeCanvas / ParamPanel
        │   (callbacks: onSelect, onBeamRepoint, onCfgChange, onBeamChange, onAdd, onDelete)
        ▼
     App.jsx  dispatch(action)
        │
        ▼
    reducer()  ──→  new state
        │
        ▼
  props flow down to all children
        │
        ├──▶  GlobeCanvas  (useEffect → syncBeamElements + scheduleRedraw; skips disabled beams)
        └──▶  ParamPanel   (pure render; calls elevSlant() per beam row for the read-only columns)
```

---

## GlobeCanvas — Render Architecture

This is the most complex component. It bridges React's declarative model with D3's imperative SVG manipulation.

### Two-ref pattern

```js
// Mutable D3 rendering state — mutated directly, never causes re-renders
const d3s = useRef({ ready, projection, geoPath, layers, beamEls, W, H, ... })

// Always-current snapshot of React props — readable inside D3 closures
const stateRef = useRef({ cfg, beams, selectedId })
stateRef.current = { cfg, beams, selectedId }   // updated every render

// Always-current callbacks
const cbRef = useRef({ onSelect, onBeamDragEnd, onUpdateCfgSatLon })
cbRef.current = { ... }
```

`stateRef` / `cbRef` are assigned on every React render. D3 event handlers capture these refs, not the values, so they always see fresh props without needing to re-register listeners. This avoids stale-closure bugs that would otherwise require `useEffect` re-runs whenever props change.

### SVG layer order

```
<svg id="globe">
  <g lyrSphere>   ← ocean circle (clip boundary)
    <circle class="sphere">
  <g lyrGrat>     ← graticule (10° grid)
    <path class="graticule">
  <g lyrLand>     ← country polygons (loaded from CDN)
    <path class="land"> × N
  <g lyrBeam>     ← beam footprints + axis ticks (dynamic)
    <path class="beam-path"> × beams.length
    <line> × 2   (major + minor axis crosshair ticks)
    ...
```

Beams render on top of geography so footprints are always visible.

### Beam element lifecycle — `syncBeamElements(beams)`

Called from a `useEffect` whenever `beams` changes. It keeps `g.beamEls` (a `Map<id, {svgEl, tickEls}>`) in sync with the React beams array:

1. **Remove**: for each id in `g.beamEls` that's not in the current `beams`, remove the `<path>` and both `<line>` elements from the SVG and delete from the Map.
2. **Add**: for each beam not already in `g.beamEls`, append a new `<path>` (the footprint) and two `<line>` elements (axis crosshair) to `lyrBeam`.

Existing elements are reused across renders — only attribute values are updated during `redraw()`.

### Redraw pipeline — `redraw(dragging)`

Called via `scheduleRedraw()` which debounces through `requestAnimationFrame` (one pending frame maximum):

1. Reposition and resize the sphere `<circle>` per current W/H and zoom scale.
2. Re-compute and set the graticule `<path>`.
3. Update each land `<path>` via `geoPath(d)`.
4. For each beam:
   - During an active beam drag: substitute live `g.drag.boreLat/boreLon` for the beam's stored position (the React state is NOT updated mid-drag).
   - Call `computeBeam(...)` → GeoJSON Polygon coordinates.
   - Update fill opacity and stroke width (selected beam gets 2.25× thicker stroke, 2.25× denser fill).
   - Call `computeAxisTips(...)` → 4 axis-end points → set `x1/y1/x2/y2` on the two tick `<line>` elements.

### Input handling

All pointer and keyboard listeners are registered once in the `useEffect([], [])` (empty-deps, one-time setup). They read current state exclusively through `stateRef.current` and fire callbacks through `cbRef.current`.

#### Drag state machine

A single `g.drag` object tracks the active gesture:

```js
// Globe rotation drag
g.drag = { mode: 'globe', start: [cx, cy], rotOrigin: [...] }

// Beam repoint drag
g.drag = { mode: 'beam', beamId, px0, boreLat0, boreLon0, boreLat, boreLon }
```

Hit detection on `mousedown`/`touchstart` iterates `g.beamEls` to find if the pointer landed on a beam path. If so, `mode = 'beam'`; otherwise `mode = 'globe'`.

During `mousemove`:
- **Beam mode**: convert pixel delta to degree delta via `pxToDeg` (accounts for current zoom scale), clamp latitude to ±85°, wrap longitude to ±180°. Update `g.drag.boreLat/boreLon` and call `scheduleRedraw(true)`. React state is **not** touched.
- **Globe mode**: compute new rotation from pixel delta scaled by `GLOBE_SENS / zoomScale` (lower sensitivity at higher zoom). Apply directly to `projection.rotate()`.

On `mouseup`/`touchend`: if mode is `beam`, fire `cbRef.current.onBeamDragEnd(id, lat, lon)` → this dispatches `UPDATE_BEAM` to React, committing the final position.

#### Zoom

| Gesture | Mechanism |
|---|---|
| Mouse wheel | `wheel` event → multiply `zoomScale` by `ZOOM_WHEEL = 1.12` |
| Pinch | Two-finger `touchmove` → ratio of current/previous touch span → `zoomScale` |
| Buttons | `zoomIn()`/`zoomOut()` → multiply by `ZOOM_BTN = 1.25` |

All three routes call `applyZoom()` → `projection.scale(baseR × zoomScale)` → `scheduleRedraw()`.

#### Keyboard nudge

`ArrowUp/Down/Left/Right` nudge the selected beam's boresight by 0.1° (or 1.0° with Shift). Fires `onBeamDragEnd` directly (same path as pointer drag-end). Input elements suppress nudge via `document.activeElement.tagName === 'INPUT'` guard.

---

## Geodesy Library — `lib/geodesy.js`

All geometry uses WGS-84 (not spherical Earth). Constants:

```js
WGS84     = { a: 6378137.0, b: 6356752.3142 }  // semi-axes, metres
GSO_ALT_M = 35786000                            // metres above equator
N_VERTS   = 360                                 // polygon vertex count
```

### Coordinate systems

| Symbol | Meaning |
|---|---|
| LLA | Geodetic (lat°, lon°, alt m) |
| ECEF | Earth-centred Earth-fixed Cartesian (x, y, z) in metres |

`lla2ecef` / `ecef2lla` convert between them using the WGS-84 Normal radius formula (Bowring method for inverse).

### Beam geometry pipeline

`computeBeam(satLon, boreLat, boreLon, majorDeg, minorDeg, rotDeg, minElev)` → `[[lon,lat], ...]` or `null`

```
1. beamFrame()
   ├─ Satellite position: lla2ecef(0, satLon, GSO_ALT_M) → satE
   ├─ Boresight direction: norm(lla2ecef(boreLat,boreLon,0) − satE) → boreDir
   ├─ North-in-beam-plane: project world-Z onto boreDir plane → north_hat
   └─ East-in-beam-plane: cross(north_hat, boreDir) → east_hat

2. Rotate north/east by rotDeg (rotation matrix in 2-D beam-plane)
   → major_hat, minor_hat

3. For each vertex i ∈ [0, N_VERTS):
   φ = 2π·i/N_VERTS
   r = polar ellipse radius at angle φ:
         r = (a·b) / √((b·cosφ)² + (a·sinφ)²)    where a=major/2, b=minor/2 (radians)
   sweepDir = normalise(cosφ·major_hat + sinφ·minor_hat)
   ray      = normalise(rodrigues(boreDir, sweepDir, r))
   hit      = rayEllipsoid(satE, ray)             ← ray-WGS84 intersection
   if hit:
     [lat,lon] = ecef2lla(hit)
     if elevAtLatLon(satE, lat, lon) >= minElev:
       push [lon, lat]
     else:
       push null                                  ← below horizon / min-elev clip

4. Close the polygon, skip if fewer than 3 valid points
```

`computeAxisTips` uses the same `beamFrame` + `rodrigues` + `rayEllipsoid` pipeline for just 4 points (±major, ±minor axis tips) to drive the crosshair tick marks.

### Elevation and slant range

`elevSlant(satLon, lat, lon)` → `{ elev (°), slantKm }` for the InfoBar:

```
S = lla2ecef(0, satLon, GSO_ALT_M)   ← satellite
G = lla2ecef(lat, lon, 0)             ← ground point
toSat = S − G
elev = arcsin(dot(norm(toSat), up))   ← up = local geodetic vertical at G
slantKm = |toSat| / 1000
```

### Ray–ellipsoid intersection — `rayEllipsoid(O, D)`

Standard quadratic method on the scaled ellipsoid (`x²/a² + y²/a² + z²/b² = 1`). Returns the nearest positive-t intersection, or `null` if the ray misses or exits (geometry faces away from satellite).

---

## Component Reference

### `App.jsx`

Root component and sole owner of application state. Provides pure handler functions (`handleCfgChange`, `handleBeamChange`, `handleBeamRepoint`) as named callbacks so child components remain agnostic of dispatch details. Renders `#main` as a flex row containing `ParamPanel` (left) and `GlobeCanvas` (right); the CSS collapses this to a column below 680px viewport width.

### `GlobeCanvas.jsx`

Props: `cfg`, `beams`, `selectedId`, `onSelect`, `onBeamRepoint`

Renders: `<div#globe-wrap> → <svg#globe> + zoom buttons + hint label`

Side effects: resizes with window, registers global `keydown` for arrow nudge. Cleans up all listeners and pending `rAF` on unmount.

Beams with `enabled: false` are skipped in `redraw()` — their `<path>`/tick `<line>` elements are kept in the DOM (via `syncBeamElements`) but given an empty `d` / zeroed coordinates, so they're invisible and non-hittable without touching the sync lifecycle.

### `ParamPanel.jsx`

The vertical parameter editor docked to the left of the globe (`#param-panel`). Two sections:

1. **Common params** — two `NumberInput` fields bound to `cfg.satLon` and `cfg.minElev`.
2. **Beam table** (`#beam-table`) — one row per beam, columns: enable checkbox, auto-numbered index (`i + 1` from array position, not the stable `beam.id` — so numbering stays 1..N top-to-bottom even after deletions), colour swatch, read-only boresight/elevation/slant-range (via `elevSlant()`), an editable beamwidth `NumberInput` (writes `{major: v, minor: v}` together), an "Ell" checkbox, and a delete button. Checking "Ell" swaps the single beamwidth field for an "ellipt." label and inserts a detail `<tr>` below with independent Major/Minor/Rot `NumberInput`s. Unchecking it snaps `minor` back to `major` and collapses the detail row. All interactive controls call `e.stopPropagation()` so clicking them doesn't also trigger the row's `onSelect`.

### `NumberInput.jsx`

Shared uncontrolled numeric input (used by both `ParamPanel` sections and the beam detail row). A `useEffect` writes `value` into the DOM node whenever it changes, unless the input is currently focused — this keeps the field editable while typing without needing `key`-based remounts, and without making the input fully controlled (which would hurt mobile input UX on every keystroke).

### `HomeNav.jsx`

Static. Back-link (`../`) to the tools index. Version and date stamped manually.

---

## CSS Design System

All design tokens defined as CSS custom properties on `:root`:

```css
--bg:     #f5f5f0   /* page background, warm off-white */
--panel:  #ffffff   /* header / bottom panels */
--border: #d0cfc8   /* grid lines, dividers */
--accent: #1a6ab5   /* primary interactive colour */
--accent2:#c94a0a   /* warning / secondary accent (used for elevation, slant) */
--text:   #1a1a18   /* body text */
--muted:  #7a7870   /* labels, secondary text */
```

The `#app` flex column fills the viewport height with no scroll: `header` and footer panels are `flex-shrink: 0`; `#globe-wrap` takes `flex: 1` and clips overflow. `overflow: hidden` on `html, body` suppresses elastic over-scroll on iOS.

---

## Known Limitations / Future Work

- **No URL persistence**: beam configuration is not encoded in the URL. A `URLSearchParams` serialiser would make sessions shareable (aligns with repo convention).
- **No export**: no JSON/CSV/KML export of beam parameters or footprint polygons.
- `SET_SAT_LON` shifts all beam boreLon by the delta but does **not** adjust the globe rotation to follow — the user must manually re-center the view.
- The beam polygon uses `N_VERTS = 360` uniformly-spaced vertices. At large beamwidths (>10°) or near the horizon, the ellipse approximation degrades and explicit clipping artefacts may appear.
