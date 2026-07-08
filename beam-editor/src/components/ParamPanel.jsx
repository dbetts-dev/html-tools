import { Fragment } from 'react'
import { MAX_BEAMS } from '../App.jsx'
import { elevSlant } from '../lib/geodesy.js'
import NumberInput from './NumberInput.jsx'

function fmtLat(v) { return Math.abs(v).toFixed(1) + '°' + (v >= 0 ? 'N' : 'S') }
function fmtLon(v) { return Math.abs(v).toFixed(1) + '°' + (v >= 0 ? 'E' : 'W') }

function BeamRow({ beam, index, cfg, isSelected, onSelect, onBeamChange, onDelete }) {
  const { elev, slantKm } = elevSlant(cfg.satLon, beam.boreLat, beam.boreLon)

  function toggleEnabled(e) {
    e.stopPropagation()
    onBeamChange(beam.id, { enabled: !beam.enabled })
  }

  function toggleElliptical(e) {
    e.stopPropagation()
    if (beam.elliptical) onBeamChange(beam.id, { elliptical: false, minor: beam.major })
    else onBeamChange(beam.id, { elliptical: true })
  }

  return (
    <Fragment>
      <tr
        className={`beam-row${isSelected ? ' selected' : ''}${beam.enabled ? '' : ' disabled'}`}
        onClick={() => onSelect(beam.id)}
      >
        <td className="c-en">
          <input type="checkbox" checked={beam.enabled} onChange={toggleEnabled} onClick={e => e.stopPropagation()} />
        </td>
        <td className="c-num">
          <span className="swatch" style={{ background: beam.color }} />
          {index + 1}
        </td>
        <td className="c-bore">{fmtLat(beam.boreLat)} {fmtLon(beam.boreLon)}</td>
        <td className="c-elev">{elev.toFixed(1)}°</td>
        <td className="c-slant">{slantKm.toFixed(0)}</td>
        <td className="c-bw">
          {beam.elliptical ? (
            <span className="bw-ell">ellipt.</span>
          ) : (
            <NumberInput
              compact
              value={beam.major}
              min={0.1} max={20} step={0.1}
              onChange={v => onBeamChange(beam.id, { major: v, minor: v })}
            />
          )}
        </td>
        <td className="c-ell">
          <input type="checkbox" checked={beam.elliptical} onChange={toggleElliptical} onClick={e => e.stopPropagation()} />
        </td>
        <td className="c-del">
          <span
            className="del-btn"
            onClick={e => { e.stopPropagation(); onDelete(beam.id) }}
            onTouchEnd={e => { e.stopPropagation(); e.preventDefault(); onDelete(beam.id) }}
          >
            ×
          </span>
        </td>
      </tr>

      {beam.elliptical && (
        <tr className={`beam-detail-row${isSelected ? ' selected' : ''}`} onClick={() => onSelect(beam.id)}>
          <td colSpan={7}>
            <div className="detail-fields">
              <NumberInput
                compact label="Major °"
                value={beam.major}
                min={0.1} max={20} step={0.1}
                onChange={v => onBeamChange(beam.id, { major: v })}
              />
              <NumberInput
                compact label="Minor °"
                value={beam.minor}
                min={0.1} max={20} step={0.1}
                onChange={v => onBeamChange(beam.id, { minor: v })}
              />
              <NumberInput
                compact label="Rot °"
                value={beam.rot}
                min={-180} max={180} step={1}
                onChange={v => onBeamChange(beam.id, { rot: v })}
              />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  )
}

export default function ParamPanel({ cfg, beams, selectedId, onCfgChange, onBeamChange, onSelect, onAdd, onDelete }) {
  const full = beams.length >= MAX_BEAMS

  return (
    <aside id="param-panel">
      <section id="common-params">
        <h2 className="panel-h">Parameters</h2>
        <div className="param-row">
          <NumberInput
            label="Sat Lon °"
            value={cfg.satLon}
            min={-180} max={180} step={1}
            onChange={v => onCfgChange('satLon', v)}
          />
          <NumberInput
            label="Min Elev °"
            value={cfg.minElev}
            min={0} max={30} step={1}
            onChange={v => onCfgChange('minElev', v)}
          />
        </div>
      </section>

      <section id="beam-section">
        <div className="beam-section-head">
          <h2 className="panel-h">Beams</h2>
          <button
            id="add-beam-btn"
            className={full ? 'disabled' : ''}
            onClick={full ? undefined : onAdd}
            disabled={full}
            title="Add beam"
          >
            {full ? String(MAX_BEAMS) : '+ Beam'}
          </button>
        </div>

        <div className="beam-table-wrap">
          <table id="beam-table">
            <thead>
              <tr>
                <th className="c-en" title="Enable"></th>
                <th className="c-num">#</th>
                <th className="c-bore">Boresight</th>
                <th className="c-elev">Elev</th>
                <th className="c-slant">Slant km</th>
                <th className="c-bw">Beamwidth °</th>
                <th className="c-ell" title="Elliptical">Ell</th>
                <th className="c-del"></th>
              </tr>
            </thead>
            <tbody>
              {beams.map((beam, i) => (
                <BeamRow
                  key={beam.id}
                  beam={beam}
                  index={i}
                  cfg={cfg}
                  isSelected={beam.id === selectedId}
                  onSelect={onSelect}
                  onBeamChange={onBeamChange}
                  onDelete={onDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </aside>
  )
}
