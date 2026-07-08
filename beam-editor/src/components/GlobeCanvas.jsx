import { useRef, useEffect } from 'react'
import * as d3 from 'd3'
import * as topojson from 'topojson-client'
import { computeBeamAndTips, wrapLon, LAT_CLAMP } from '../lib/geodesy.js'
import { hexToRgba } from '../lib/colors.js'

const GLOBE_RATIO = 0.47
const GLOBE_SENS  = 0.25
const ZOOM_MIN    = 0.5
const ZOOM_MAX    = 8
const ZOOM_WHEEL  = 1.12
const ZOOM_BTN    = 1.25

function getXY(evt, svgEl) {
  const src  = evt.touches ? evt.touches[0] : evt
  const rect = svgEl.getBoundingClientRect()
  return [src.clientX - rect.left, src.clientY - rect.top]
}

function pxToDeg(dpx, dpy, scale) {
  const R2D = 180 / Math.PI
  return [dpy / scale * R2D, dpx / scale * R2D]
}

export default function GlobeCanvas({ cfg, beams, selectedId, onSelect, onBeamRepoint }) {
  const wrapRef = useRef(null)
  const svgRef  = useRef(null)

  // Mutable D3 state — never causes re-renders
  const d3s = useRef({
    ready:      false,
    projection: null,
    geoPath:    null,
    lyrBeam:    null,
    lyrLand:    null,
    lyrGrat:    null,
    lyrSphere:  null,
    sphereEl:   null,
    gratEl:     null,
    landPaths:  null,
    beamEls:    new Map(),   // id → { svgEl, tickEls }
    W: 0, H: 0, baseR: 0,
    zoomScale:  1,
    rafId:      null,
    rafDragging: false,
    drag:       null,        // active drag state
    pinchD0:    null,
  })

  // Always-current view of React state, readable by D3 handlers without re-registration
  const stateRef = useRef({ cfg, beams, selectedId })
  stateRef.current = { cfg, beams, selectedId }

  // Always-current callbacks
  const cbRef = useRef({ onSelect, onBeamRepoint })
  cbRef.current = { onSelect, onBeamRepoint }

  // ── Redraw ─────────────────────────────────────────────────────────────────
  function redraw(dragging = false) {
    const g = d3s.current
    if (!g.ready) return
    const { cfg: c, beams: bs, selectedId: selId } = stateRef.current

    const { W, H, projection, geoPath, sphereEl, gratEl, landPaths } = g
    sphereEl.attr('cx', W/2).attr('cy', H/2).attr('r', g.baseR * g.zoomScale)
    gratEl.attr('d', geoPath(d3.geoGraticule()()))
    if (landPaths) landPaths.attr('d', d => geoPath(d))

    bs.forEach(beam => {
      const els = g.beamEls.get(beam.id)
      if (!els) return
      const isSel = beam.id === selId

      if (beam.enabled === false) {
        els.svgEl.attr('d', '')
        els.tickEls.forEach(t => t.attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 0))
        return
      }

      // During drag, use the live drag position for the dragged beam
      let boreLat = beam.boreLat, boreLon = beam.boreLon
      if (g.drag && g.drag.mode === 'beam' && g.drag.beamId === beam.id) {
        boreLat = g.drag.boreLat
        boreLon = g.drag.boreLon
      }

      const { coords, tips } = computeBeamAndTips(c.satLon, boreLat, boreLon, beam.major, beam.minor, beam.rot, c.minElev)
      els.svgEl
        .attr('fill',         hexToRgba(beam.color, isSel ? 0.18 : 0.08))
        .attr('stroke',       beam.color)
        .attr('stroke-width', isSel ? 0.625 : 0.375)
        .classed('dragging',  dragging && isSel)

      if (coords) {
        els.svgEl
          .datum({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } })
          .attr('d', geoPath)
      } else {
        els.svgEl.attr('d', '')
      }

      ;[[0, 1], [2, 3]].forEach(([ai, bi], tickIdx) => {
        const tipA = tips[ai], tipB = tips[bi]
        const el   = els.tickEls[tickIdx]
        if (tipA && tipB) {
          const pA = projection([tipA[0], tipA[1]])
          const pB = projection([tipB[0], tipB[1]])
          if (pA && pB) {
            el.attr('x1', pA[0]).attr('y1', pA[1])
              .attr('x2', pB[0]).attr('y2', pB[1])
              .attr('stroke-width', isSel ? 0.8 : 0.4)
              .attr('opacity', 0.9)
            return
          }
        }
        el.attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 0)
      })
    })
  }

  function scheduleRedraw(dragging = false) {
    const g = d3s.current
    if (dragging) g.rafDragging = true
    if (g.rafId !== null) return
    g.rafId = requestAnimationFrame(() => {
      g.rafId = null
      const d = g.rafDragging
      g.rafDragging = false
      redraw(d)
    })
  }

  function applyZoom() {
    const g = d3s.current
    g.projection.translate([g.W/2, g.H/2]).scale(g.baseR * g.zoomScale)
    scheduleRedraw()
  }

  // ── Sync D3 SVG elements with React beams state ────────────────────────────
  function syncBeamElements(beams) {
    const g = d3s.current
    if (!g.ready) return

    const currentIds = new Set(beams.map(b => b.id))

    // Remove stale elements
    for (const [id, els] of g.beamEls) {
      if (!currentIds.has(id)) {
        els.svgEl.remove()
        els.tickEls.forEach(t => t.remove())
        g.beamEls.delete(id)
      }
    }

    // Add new elements (preserve order by inserting before the next sibling)
    beams.forEach(beam => {
      if (g.beamEls.has(beam.id)) return
      const svgEl = g.lyrBeam.append('path')
        .attr('class', 'beam-path')
        .attr('fill',   hexToRgba(beam.color, 0.12))
        .attr('stroke', beam.color)
        .datum({ id: beam.id })

      const tickEls = [0, 1].map(() =>
        g.lyrBeam.append('line')
          .attr('stroke',         beam.color)
          .attr('stroke-width',   0.8)
          .attr('stroke-linecap', 'round')
      )

      g.beamEls.set(beam.id, { svgEl, tickEls })
    })
  }

  // ── One-time D3 initialisation ─────────────────────────────────────────────
  useEffect(() => {
    const g    = d3s.current
    const wrap = wrapRef.current
    const svgEl = svgRef.current
    const svg  = d3.select(svgEl)

    g.W = wrap.clientWidth
    g.H = wrap.clientHeight
    g.baseR = Math.min(g.W, g.H) * GLOBE_RATIO

    const projection = d3.geoOrthographic().clipAngle(90)
    const geoPath    = d3.geoPath(projection)
    g.projection = projection
    g.geoPath    = geoPath

    svg.attr('width', g.W).attr('height', g.H)
    projection.translate([g.W/2, g.H/2]).scale(g.baseR)

    const lyrSphere = svg.append('g')
    const lyrGrat   = svg.append('g')
    const lyrLand   = svg.append('g')
    const lyrBeam   = svg.append('g')

    g.lyrSphere = lyrSphere
    g.lyrGrat   = lyrGrat
    g.lyrLand   = lyrLand
    g.lyrBeam   = lyrBeam
    g.sphereEl  = lyrSphere.append('circle').attr('class', 'sphere')
    g.gratEl    = lyrGrat.append('path').attr('class', 'graticule')
    g.ready     = true

    // Load world atlas
    d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
      .then(topo => {
        g.landPaths = lyrLand.selectAll('path')
          .data(topojson.feature(topo, topo.objects.countries).features)
          .join('path').attr('class', 'land')
        scheduleRedraw()
      })
      .catch(e => console.error('World atlas load failed:', e))

    projection.rotate([-stateRef.current.cfg.satLon, -20])

    // ── Resize ───────────────────────────────────────────────────────────────
    function onResize() {
      g.W = wrap.clientWidth
      g.H = wrap.clientHeight
      g.baseR = Math.min(g.W, g.H) * GLOBE_RATIO
      svg.attr('width', g.W).attr('height', g.H)
      projection.translate([g.W/2, g.H/2]).scale(g.baseR * g.zoomScale)
      scheduleRedraw()
    }
    window.addEventListener('resize', onResize)

    // ── Drag ─────────────────────────────────────────────────────────────────
    svg.on('mousedown touchstart', function(evt) {
      if (evt.touches && evt.touches.length === 2) return
      evt.preventDefault()

      const [cx, cy] = getXY(evt, svgEl)
      const { beams: bs } = stateRef.current
      const src = evt.touches ? evt.touches[0] : evt
      const target = document.elementFromPoint(src.clientX, src.clientY)
      const hitBeam = bs.find(b => {
        const els = g.beamEls.get(b.id)
        return els && els.svgEl.node() === target
      })

      if (hitBeam) {
        g.drag = {
          mode:     'beam',
          beamId:   hitBeam.id,
          px0:      [cx, cy],
          boreLat0: hitBeam.boreLat,
          boreLon0: hitBeam.boreLon,
          boreLat:  hitBeam.boreLat,
          boreLon:  hitBeam.boreLon,
        }
        if (hitBeam.id !== stateRef.current.selectedId) {
          cbRef.current.onSelect(hitBeam.id)
        }
        scheduleRedraw(true)
      } else {
        g.drag = {
          mode:      'globe',
          start:     [cx, cy],
          rotOrigin: projection.rotate().slice(),
        }
      }
    }, { passive: false })

    svg.on('mousemove touchmove', function(evt) {
      if (!g.drag) return
      if (evt.touches && evt.touches.length === 2) return
      evt.preventDefault()

      const [cx, cy] = getXY(evt, svgEl)

      if (g.drag.mode === 'beam') {
        const [dLat, dLon] = pxToDeg(cx - g.drag.px0[0], cy - g.drag.px0[1], g.projection.scale())
        g.drag.boreLat = Math.max(-LAT_CLAMP, Math.min(LAT_CLAMP, g.drag.boreLat0 - dLat))
        g.drag.boreLon = wrapLon(g.drag.boreLon0 + dLon)
        scheduleRedraw(true)

      } else if (g.drag.mode === 'globe') {
        const sens = GLOBE_SENS / g.zoomScale
        projection.rotate([
          g.drag.rotOrigin[0] + (cx - g.drag.start[0]) * sens,
          g.drag.rotOrigin[1] - (cy - g.drag.start[1]) * sens,
        ])
        scheduleRedraw(true)
      }
    }, { passive: false })

    svg.on('mouseup mouseleave touchend touchcancel', function(evt) {
      if (!g.drag) return
      // mouseleave during a beam drag: keep dragging until mouseup
      if (evt.type === 'mouseleave' && g.drag.mode === 'beam') return
      if (g.drag.mode === 'beam') {
        cbRef.current.onBeamRepoint(g.drag.beamId, g.drag.boreLat, g.drag.boreLon)
      }
      g.drag = null
      scheduleRedraw(false)
    })

    // ── Scroll zoom ───────────────────────────────────────────────────────────
    svg.on('wheel', function(evt) {
      evt.preventDefault()
      g.zoomScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX,
        g.zoomScale * (evt.deltaY < 0 ? ZOOM_WHEEL : 1 / ZOOM_WHEEL)))
      applyZoom()
    }, { passive: false })

    // ── Pinch zoom ────────────────────────────────────────────────────────────
    svg.on('touchstart.pinch', function(evt) {
      if (evt.touches.length !== 2) return
      evt.preventDefault()
      g.drag   = null
      g.pinchD0 = Math.hypot(
        evt.touches[0].clientX - evt.touches[1].clientX,
        evt.touches[0].clientY - evt.touches[1].clientY,
      )
    }, { passive: false })

    svg.on('touchmove.pinch', function(evt) {
      if (evt.touches.length !== 2 || !g.pinchD0) return
      evt.preventDefault()
      const d = Math.hypot(
        evt.touches[0].clientX - evt.touches[1].clientX,
        evt.touches[0].clientY - evt.touches[1].clientY,
      )
      g.zoomScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, g.zoomScale * (d / g.pinchD0)))
      g.pinchD0 = d
      applyZoom()
    }, { passive: false })

    svg.on('touchend.pinch touchcancel.pinch', () => { g.pinchD0 = null })

    // ── Keyboard nudge ────────────────────────────────────────────────────────
    function onKeyDown(evt) {
      const { beams: bs, selectedId: selId } = stateRef.current
      const beam = bs.find(b => b.id === selId)
      if (!beam) return
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return
      const ARROWS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 }
      if (!ARROWS[evt.key]) return
      evt.preventDefault()
      const step = (evt.shiftKey ? 10 : 1) * 0.1
      let lat = beam.boreLat, lon = beam.boreLon
      switch (evt.key) {
        case 'ArrowUp':    lat = Math.max(-LAT_CLAMP, Math.min(LAT_CLAMP, lat + step)); break
        case 'ArrowDown':  lat = Math.max(-LAT_CLAMP, Math.min(LAT_CLAMP, lat - step)); break
        case 'ArrowRight': lon = wrapLon(lon + step); break
        case 'ArrowLeft':  lon = wrapLon(lon - step); break
      }
      cbRef.current.onBeamRepoint(beam.id, lat, lon)
    }
    document.addEventListener('keydown', onKeyDown)

    scheduleRedraw()

    return () => {
      window.removeEventListener('resize', onResize)
      document.removeEventListener('keydown', onKeyDown)
      if (g.rafId !== null) cancelAnimationFrame(g.rafId)
      svg.on('mousedown touchstart mousemove touchmove mouseup mouseleave touchend touchcancel wheel touchstart.pinch touchmove.pinch touchend.pinch touchcancel.pinch', null)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync beam SVG elements + redraw on state changes ──────────────────────
  useEffect(() => {
    syncBeamElements(beams)
    scheduleRedraw()
  }, [beams, selectedId, cfg]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Zoom buttons ──────────────────────────────────────────────────────────
  function zoomIn()  {
    const g = d3s.current
    g.zoomScale = Math.min(ZOOM_MAX, g.zoomScale * ZOOM_BTN)
    applyZoom()
  }
  function zoomOut() {
    const g = d3s.current
    g.zoomScale = Math.max(ZOOM_MIN, g.zoomScale / ZOOM_BTN)
    applyZoom()
  }

  return (
    <div ref={wrapRef} id="globe-wrap">
      <svg ref={svgRef} id="globe" />
      <div id="zoom-btns">
        <button className="zoom-btn" onClick={zoomIn} aria-label="Zoom in">+</button>
        <button className="zoom-btn" onClick={zoomOut} aria-label="Zoom out">−</button>
      </div>
      <div id="hint">DRAG BEAM · DRAG GLOBE TO ROTATE · SCROLL/PINCH TO ZOOM · ARROWS TO NUDGE</div>
    </div>
  )
}
