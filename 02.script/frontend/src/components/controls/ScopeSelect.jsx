// ScopeSelect — the unified 지역 control. The 구 selector is a MULTI-CHECK control that
// drives BOTH the single-gu drill AND the multi-gu grid comparison from one place —
// there is NO separate "여러 구 격자 비교" picker anymore (its logic moved here, via the
// store's setMultiGridGus).
//
// PRESENTATION: the 구 control is a CLICK-TO-EXPAND DROPDOWN, not an always-open list.
// A closed trigger (styled like the Select primitive) shows the current SELECTION
// SUMMARY ("서울 전체" / the 구명 / "N개 구 선택") + a caret; clicking it expands a flat,
// hairline-framed panel below holding the 25 구 as native checkboxes (scrollable). The
// panel stays open while toggling several 구 at once, and closes on: re-click, Escape,
// or a click OUTSIDE the control. `open` is LOCAL presentation state only — it never
// touches the store.
//
// The CHECKED set is DERIVED FROM STATE (not local component state) so the control always
// reflects the store:
//   data.multiGrid.gus.length → those gus (multi-gu grid view is active)
//   else selection.gu          → [selection.gu] (single-gu drill)
//   else                        → [] (서울 전체, gu level)
//
// Toggling a checkbox recomputes the next checked set and dispatches by COUNT:
//   0 구 → resetScope()                       (서울 전체)
//   1 구 → drillTo('dong', gu) + clear multi  (single-gu: that 구's 동 choropleth)
//   2+구 → setMultiGridGus(checkedGus)         (merged grids + 구 경계/라벨)
//
// 동 selector: kept for the SINGLE-gu case only (exactly 1 구 checked, not multi). It
// drills 동→격자 as before. Hidden in multi-gu mode.
//
// Chrome is ink/hairline only (green-free, no shadow); the native checkbox focus ring is
// fine. The trigger gets the sanctioned green FOCUS ring (border swap), like Select.
import { useEffect, useRef, useState } from 'react'
import FieldGroup from './FieldGroup.jsx'
import Select from '../ui/Select.jsx'
import useStore from '../../store/useStore.js'

const ALL_GU = '__all_gu__' // 동 select: 구 전체 (back to the gu's dong level)

// 가나다(ko) name comparator — the backend lists 구/동 in CODE order (구코드/행정동코드),
// but users scan the 지역 control by NAME, so we sort the rendered lists 가나다 by 구명/
// 행정동명. localeCompare('ko') gives correct Hangul collation. Sorts a COPY (never the
// store arrays). The selection summary's find() is order-independent, so only the
// rendered checkbox list + 동 options need sorting.
const byKoName = (key) => (a, b) =>
  String(a?.[key] ?? '').localeCompare(String(b?.[key] ?? ''), 'ko')

function ScopeSelect() {
  const gu = useStore((s) => s.selection.gu)
  const dong = useStore((s) => s.selection.dong)
  const districts = useStore((s) => s.data.districts)
  const dongs = useStore((s) => s.data.dongs)
  const multiGridGus = useStore((s) => s.data.multiGrid.gus)
  const drillTo = useStore((s) => s.drillTo)
  const resetScope = useStore((s) => s.resetScope)
  const setMultiGridGus = useStore((s) => s.setMultiGridGus)

  // LOCAL presentation state — the dropdown open/closed. Never persisted to the store
  // (the store owns the SELECTION; this only owns whether the checkbox panel is showing).
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false) // trigger focus ring (mirrors Select)
  const rootRef = useRef(null) // the control wrapper — for the click-away hit test

  // Derive the current checked set FROM STATE (string codes for O(1) lookup):
  //   multi-grid active → its gus ; else a single drilled gu → [gu] ; else none.
  const checkedGus =
    multiGridGus.length > 0
      ? multiGridGus.map((g) => String(g))
      : gu
        ? [String(gu)]
        : []
  const checked = new Set(checkedGus)
  const count = checked.size
  const isMulti = count >= 2

  // Close the panel on Escape or a click/tap OUTSIDE the control. Mounted only while
  // OPEN so the listeners aren't live when closed (mirrors App.jsx's drawer pattern).
  // The click-away uses `mousedown` (fires before the next click's focus shuffle) and a
  // containment test against rootRef so toggling checkboxes INSIDE keeps the panel open.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  // Toggle one 구 in/out of the derived set, then dispatch by the NEW count. The panel
  // deliberately stays OPEN so the user can check several 구 in a row before closing.
  const toggle = (code) => {
    const c = String(code)
    const next = new Set(checked)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    const arr = Array.from(next)

    if (arr.length === 0) {
      resetScope() // 서울 전체 (also exits multi-grid via the store)
    } else if (arr.length === 1) {
      // single-gu drill — drillTo already clears the multi-grid view (mutually
      // exclusive), so we don't need an extra setMultiGridGus([]) here.
      drillTo('dong', arr[0])
    } else {
      setMultiGridGus(arr) // 2+ → merged multi-gu grid view
    }
  }

  // 구 전체 (동 select) → back to the gu's dong level. A real 행정동 → drill to 격자.
  const onDongChange = (v) => {
    if (v === ALL_GU) drillTo('dong', gu)
    else drillTo('grid', v)
  }

  const dongOptions = [
    { value: ALL_GU, label: '구 전체' },
    ...[...dongs]
      .sort(byKoName('행정동명'))
      .map((d) => ({ value: d.행정동코드, label: d.행정동명 })),
  ]

  // 동 selector shows ONLY in the single-gu case: a gu is drilled in AND we're not in
  // the multi-gu grid view. Hidden for 서울 전체 (no gu) and for 2+ 구 (multi mode).
  const showDong = !!gu && !isMulti

  // Trigger summary: the current selection at a glance. 0 → 서울 전체, 1 → the 구명,
  // 2+ → "N개 구 선택". Derived from the SAME checked set the panel renders.
  const selectedGuName =
    count === 1
      ? districts.find((d) => String(d.구코드) === checkedGus[0])?.구명 ?? '1개 구 선택'
      : null
  const summary =
    count === 0 ? '서울 전체' : isMulti ? `${count}개 구 선택` : selectedGuName

  return (
    <FieldGroup label="지역">
      {/* 구 control = closed trigger + (when open) an expanding checkbox panel. The
          wrapper is position:relative so the panel can anchor below it; rootRef on it
          powers the click-away containment test. A 해제 button sits beside the trigger
          when any 구 is checked. */}
      <div
        ref={rootRef}
        style={{ position: 'relative', display: 'flex', gap: 'var(--sp-xs)' }}
      >
        {/* Trigger — styled like the Select primitive: canvas bg, 1px hairline (2px green
            on focus), 2px radius, ~30px dense height, ink text, a caret. Toggles `open`;
            re-clicking while open closes it. aria-expanded reflects the panel state. */}
        <button
          type="button"
          className="t-body-sm"
          aria-expanded={open}
          aria-haspopup="true"
          aria-label="자치구 선택"
          onClick={() => setOpen((o) => !o)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--sp-xs)',
            minHeight: 30,
            padding: focused ? '0 7px' : '0 8px',
            background: 'var(--canvas)',
            color: 'var(--ink)',
            border: focused
              ? '2px solid var(--green)'
              : '1px solid var(--hairline)',
            borderRadius: 'var(--r)',
            cursor: 'pointer',
            fontFamily: 'var(--font)',
            textAlign: 'left',
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary}
          </span>
          {/* Caret — rotates to indicate open/closed. Plain ink chevron, no green. */}
          <span
            aria-hidden="true"
            style={{
              flexShrink: 0,
              fontSize: 10,
              lineHeight: 1,
              color: 'var(--mute)',
              transform: open ? 'rotate(180deg)' : 'none',
            }}
          >
            ▾
          </span>
        </button>

        {/* 해제 — clear to 서울 전체. Shown beside the trigger whenever any 구 is checked.
            Green-free: hairline border + ink text, no fill. */}
        {count > 0 && (
          <button
            type="button"
            className="t-caption-sm"
            onClick={resetScope}
            aria-label="지역 선택 해제 (서울 전체)"
            style={{
              flexShrink: 0,
              padding: '2px 8px',
              background: 'transparent',
              color: 'var(--ink)',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r)',
              cursor: 'pointer',
              fontFamily: 'var(--font)',
            }}
          >
            해제
          </button>
        )}

        {/* Expanding panel — flat (no shadow), hairline border, 2px radius. Absolutely
            positioned just below the trigger so it overlays the rail instead of pushing
            it. Bounded height (~240px) keeps it from swallowing the viewport; it scrolls.
            Holds the 25 구 as native checkboxes (check 1 → drill, 2+ → grid compare, 0 →
            서울 전체). The checkbox is the native control (its focus ring is the sanctioned
            green; inputs only). */}
        {open && (
          <div
            role="group"
            aria-label="자치구 다중 선택"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 20,
              maxHeight: 240,
              overflowY: 'auto',
              background: 'var(--canvas)',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r)',
              padding: 'var(--sp-xxs)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {[...districts].sort(byKoName('구명')).map((d) => {
              const code = String(d.구코드)
              const isChecked = checked.has(code)
              return (
                <label
                  key={code}
                  className="t-body-sm"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--sp-xs)',
                    padding: '4px 6px',
                    cursor: 'pointer',
                    color: 'var(--body)',
                    borderRadius: 'var(--r)',
                    // Checked rows get a faint tint so the active set is scannable.
                    background: isChecked ? 'var(--surface-soft)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(code)}
                    aria-label={`${d.구명} 선택`}
                  />
                  <span>{d.구명}</span>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {/* 동 selector — single-gu only (drills 동→격자). Hidden in 서울 전체 / multi mode. */}
      {showDong && (
        <Select
          aria-label="행정동 선택"
          value={dong ?? ALL_GU}
          options={dongOptions}
          onChange={onDongChange}
        />
      )}
    </FieldGroup>
  )
}

export default ScopeSelect
