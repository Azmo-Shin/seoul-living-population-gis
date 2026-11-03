// ModeTabs — 일/주/월 집계 단위 선택. Store-wired (replaces the old local nav state).
// Active pill = current selection.mode (ink inversion via PillTab, never a green
// fill). Renders inside the DARK TopBar → pass `onDark`. setMode also resets period
// to a valid default for the new mode (store handles that coupling).
import PillTab from '../ui/PillTab.jsx'
import useStore from '../../store/useStore.js'

// label → store mode. Default selection.mode is 'month' (월 active initially).
const MODES = [
  ['일', 'day'],
  ['주', 'week'],
  ['월', 'month'],
]

function ModeTabs() {
  const mode = useStore((s) => s.selection.mode)
  const setMode = useStore((s) => s.setMode)

  return (
    <div
      style={{ display: 'flex', gap: 'var(--sp-xs)' }}
      role="group"
      aria-label="집계 단위"
    >
      {MODES.map(([label, value]) => (
        <PillTab
          key={value}
          active={mode === value}
          onDark
          onClick={() => setMode(value)}
        >
          {label}
        </PillTab>
      ))}
    </div>
  )
}

export default ModeTabs
