import { useReducer } from 'react'
import { COLORS } from './lib/colors.js'
import { wrapLon, LAT_CLAMP } from './lib/geodesy.js'
import HomeNav from './components/HomeNav.jsx'
import GlobeCanvas from './components/GlobeCanvas.jsx'
import ParamPanel from './components/ParamPanel.jsx'

export const MAX_BEAMS = 16

const initialState = {
  cfg:        { satLon: 33, minElev: 5 },
  beams:      [{ id: 1, boreLat: 20, boreLon: 33, major: 2.0, minor: 2.0, rot: 0, elliptical: false, enabled: true, color: COLORS[0] }],
  selectedId: 1,
  nextId:     2,
}

function makeBeam(id, boreLat, boreLon, major, minor, rot, elliptical = false) {
  return { id, boreLat, boreLon, major, minor, rot, elliptical, enabled: true, color: COLORS[(id - 1) % COLORS.length] }
}

function reducer(state, action) {
  switch (action.type) {

    case 'ADD_BEAM': {
      if (state.beams.length >= MAX_BEAMS) return state
      const prev       = state.beams.at(-1)
      const id         = state.nextId
      const boreLon    = prev ? prev.boreLon    : state.cfg.satLon
      const major      = prev ? prev.major      : 2.0
      const minor      = prev ? prev.minor      : 2.0
      const rot        = prev ? prev.rot        : 0
      const elliptical = prev ? prev.elliptical : false
      const boreLat    = action.boreLat ?? 20
      const beam       = makeBeam(id, boreLat, boreLon, major, minor, rot, elliptical)
      return { ...state, beams: [...state.beams, beam], selectedId: id, nextId: id + 1 }
    }

    case 'DELETE_BEAM': {
      const beams = state.beams.filter(b => b.id !== action.id)
      const selectedId = state.selectedId === action.id
        ? (beams.at(-1)?.id ?? null)
        : state.selectedId
      return { ...state, beams, selectedId }
    }

    case 'SELECT_BEAM':
      return { ...state, selectedId: action.id }

    case 'UPDATE_BEAM': {
      const beams = state.beams.map(b =>
        b.id === action.id ? { ...b, ...action.patch } : b
      )
      return { ...state, beams }
    }

    case 'SET_SAT_LON': {
      const delta  = action.value - state.cfg.satLon
      const beams  = state.beams.map(b => ({ ...b, boreLon: wrapLon(b.boreLon + delta) }))
      return { ...state, cfg: { ...state.cfg, satLon: action.value }, beams }
    }

    case 'SET_MIN_ELEV':
      return { ...state, cfg: { ...state.cfg, minElev: action.value } }

    default:
      return state
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { cfg, beams, selectedId } = state

  function handleCfgChange(key, value) {
    if (key === 'satLon') dispatch({ type: 'SET_SAT_LON', value })
    else if (key === 'minElev') dispatch({ type: 'SET_MIN_ELEV', value })
  }

  function handleBeamChange(id, patch) {
    dispatch({ type: 'UPDATE_BEAM', id, patch })
  }

  function handleBeamRepoint(id, boreLat, boreLon) {
    dispatch({ type: 'UPDATE_BEAM', id, patch: { boreLat, boreLon } })
  }

  return (
    <div id="app">
      <HomeNav />
      <header>
        <h1>GSO Beam Footprint</h1>
        <span className="sub">D3 · WGS-84 · Drag beams to repoint</span>
        <span className="ver">V2</span>
      </header>

      <div id="main">
        <ParamPanel
          cfg={cfg}
          beams={beams}
          selectedId={selectedId}
          onCfgChange={handleCfgChange}
          onBeamChange={handleBeamChange}
          onSelect={id => dispatch({ type: 'SELECT_BEAM', id })}
          onAdd={() => dispatch({ type: 'ADD_BEAM' })}
          onDelete={id => dispatch({ type: 'DELETE_BEAM', id })}
        />

        <GlobeCanvas
          cfg={cfg}
          beams={beams}
          selectedId={selectedId}
          onSelect={id => dispatch({ type: 'SELECT_BEAM', id })}
          onBeamRepoint={handleBeamRepoint}
        />
      </div>
    </div>
  )
}
