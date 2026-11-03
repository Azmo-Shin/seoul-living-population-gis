// SexAgeFilter — 성별 (전체/남/여 PillTabs → setSex) + 연령 (8 bucket badges, multi-
// select → setAges). Active state is INK INVERSION (bg ink, text white), never green.
// Empty ages = 전체 연령 (the "전체" badge is active when ages is empty and clears it).
import FieldGroup from './FieldGroup.jsx'
import PillTab from '../ui/PillTab.jsx'
import useStore from '../../store/useStore.js'

const SEXES = ['전체', '남', '여']
const AGE_BUCKETS = [
  '0대',
  '10대',
  '20대',
  '30대',
  '40대',
  '50대',
  '60대',
  '70대이상',
]

// Static style base hoisted out of render; only background/color depend on `active`.
// DENSE: compact padding + small font (height comes from the rail CSS, ~28px). The
// 44px touch floor is intentionally relaxed for this dense DESKTOP filter panel (per
// the explicit compactness request) — chips stay clearly clickable/readable.
const BADGE_BASE = {
  padding: '2px 8px',
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 'var(--r)',
  border: '1px solid transparent',
  cursor: 'pointer',
  fontFamily: 'var(--font)',
}

// Badge — small toggle chip. Selected: ink bg / white text. Unselected: badge-tag
// (soft surface, body text). 2px radius, .t-caption-sm, compact padding.
function Badge({ active, onClick, children }) {
  return (
    <button
      type="button"
      className="t-caption-sm"
      aria-pressed={active}
      onClick={onClick}
      style={{
        ...BADGE_BASE,
        background: active ? 'var(--ink)' : 'var(--surface-soft)',
        color: active ? 'var(--on-dark)' : 'var(--body)',
      }}
    >
      {children}
    </button>
  )
}

// SexAgeFilter — `scope` selects which selection it reads/writes:
//   'A' (default) → selection.sex/ages + setSex/setAges (the normal A control).
//   'B'           → selectionB.sex/ages + setBSex/setBAges (compare mode's B side).
// When scope==='B' but compare is off (selectionB null) the control renders nothing
// (it's only mounted under compareMode, but guard defensively).
function SexAgeFilter({ scope = 'A' }) {
  const isB = scope === 'B'
  const selA = useStore((s) => s.selection)
  const selB = useStore((s) => s.selectionB)
  const setSexA = useStore((s) => s.setSex)
  const setAgesA = useStore((s) => s.setAges)
  const setSexB = useStore((s) => s.setBSex)
  const setAgesB = useStore((s) => s.setBAges)

  const sel = isB ? selB : selA
  // Defensive: scope 'B' with compare off (selectionB null) → render nothing.
  if (!sel) return null
  const sex = sel.sex
  const ages = sel.ages
  const setSex = isB ? setSexB : setSexA
  const setAges = isB ? setAgesB : setAgesA

  const toggleAge = (bucket) => {
    setAges(
      ages.includes(bucket)
        ? ages.filter((a) => a !== bucket)
        : [...ages, bucket],
    )
  }

  const allAges = ages.length === 0

  return (
    <>
      {/* 성별 — label + pills on ONE row (inline) to save a line. */}
      <FieldGroup label="성별" inline>
        <div
          style={{ display: 'flex', gap: 'var(--sp-xs)' }}
          role="group"
          aria-label="성별"
        >
          {SEXES.map((s) => (
            <PillTab key={s} active={sex === s} onClick={() => setSex(s)}>
              {s}
            </PillTab>
          ))}
        </div>
      </FieldGroup>

      {/* 연령 — 8 buckets + 전체, tight wrap to ~2 rows. The 전체 chip's active state
          already communicates "no selection", so the old text hint is dropped. */}
      <FieldGroup label="연령">
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-xs)' }}
          role="group"
          aria-label="연령대 (다중 선택)"
        >
          {/* 전체 affordance — active when no buckets selected; clears ages. */}
          <Badge active={allAges} onClick={() => setAges([])}>
            전체
          </Badge>
          {AGE_BUCKETS.map((bucket) => (
            <Badge
              key={bucket}
              active={ages.includes(bucket)}
              onClick={() => toggleAge(bucket)}
            >
              {bucket}
            </Badge>
          ))}
        </div>
      </FieldGroup>
    </>
  )
}

export default SexAgeFilter
