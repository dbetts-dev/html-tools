import { useRef, useEffect } from 'react'

export default function NumberInput({ label, value, min, max, step, onChange, compact }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) {
      ref.current.value = value
    }
  }, [value])

  function commit(raw) {
    const v = Math.max(min, Math.min(max, +raw))
    onChange(v)
  }

  return (
    <div className={compact ? 'num-field num-field--compact' : 'num-field'}>
      {label && <span className="lbl">{label}</span>}
      <input
        ref={ref}
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        onClick={e => e.stopPropagation()}
        onInput={e => commit(e.target.value)}
        onChange={e => commit(e.target.value)}
      />
    </div>
  )
}
