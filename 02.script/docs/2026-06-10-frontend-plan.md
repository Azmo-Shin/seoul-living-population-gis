# GIS 대시보드 프론트엔드(React+deck.gl) 구현 계획 — NVIDIA 디자인 적용

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 또는 executing-plans. 체크박스(`- [ ]`)로 추적.

**Goal:** 백엔드 API 위에 **구→동→격자 드릴다운 지도 + 일/주/월 시간집계** 대시보드를 만들되, `nvidia_frontend_DESIGN.md`의 디자인 시스템(블랙/화이트/그레이 + NVIDIA 그린, Inter, 2px 라디우스, 플랫·각진 에디토리얼)을 **대시보드 UI로 변환** 적용한다.

**Architecture:** React 19 + Vite(포트 9600) + zustand(상태) + deck.gl(지도 1만 격자 GPU렌더) + react-map-gl/MapLibre(베이스맵) + Plotly(차트). 백엔드(9601) REST 호출. `2026_05_text` 프론트 구조 준수.

**Tech Stack:** react, react-dom, vite, zustand, deck.gl, @deck.gl/react, react-map-gl, maplibre-gl, plotly.js-dist, react-plotly.js.

---

## 디자인 시스템 → 대시보드 변환 원칙

마케팅 시스템(히어로/푸터/제품카드)을 **그대로** 쓰지 않고 **시각 언어**(색·타이포·2px·플랫 헤어라인·그린 절제·다크 크롬바·코너스퀘어·굵기 기반 위계)를 **대시보드 컴포넌트**(필터패널·지도·범례·KPI·표)에 적용한다.

- **2-모드 표면**: 상단 유틸바·네비·범례 헤더는 `surface-dark(#000)`, 본문(필터·지도패널·카드)은 `canvas(#fff)`/`surface-soft(#f7f7f7)`.
- **그린 예산(green budget)**: choropleth가 그린을 **데이터 인코딩**으로 점유하므로, chrome 강조는 그린이 아니라 **ink(#000) 반전/굵은 보더**로 중화한다. 활성 탭=ink반전(pill-tab-active), **선택 구=ink 굵은 외곽선**(`getLineColor=[0,0,0]`, lineWidth↑ — 데이터 그린과 색충돌 방지), KPI 숫자=ink. 솔리드 그린은 **화면당 1개**(primary CTA·코너스퀘어). Plotly 차트도 ink 단색+그린 1계열(colorway 모노크롬 오버라이드). → "1-accent" 원칙 보존.
- **각진 2px**: 모든 버튼/카드/인풋/탭 `border-radius:2px`. 그림자 없음 → 1px `hairline(#ccc)` 보더로 구분.
- **위계는 굵기/크기로**: Inter 400/700. 색 틴팅으로 위계 만들지 않음.
- **베이스맵**: CARTO Positron(밝은 그레이) — "페이퍼 화이트 캔버스" 미학과 합치, 그린 데이터가 도드라짐.

## File Structure

```
2026_06_GIS/02.script/frontend-react/
├── index.html              # Inter 폰트, #root
├── vite.config.js          # 포트 9600, proxy /api → 9601
├── package.json
└── src/
    ├── main.jsx
    ├── App.jsx             # 셸: 유틸바+네비+(필터레일|지도|KPI)
    ├── styles/
    │   ├── tokens.css      # NVIDIA 토큰 → CSS 변수 (아래 계약)
    │   └── base.css        # 리셋, 타이포 유틸클래스(.t-display-xl 등)
    ├── store/
    │   └── useStore.js     # zustand: 선택상태 + 데이터 + 액션
    ├── api/
    │   └── client.js       # fetch 래퍼 (meta/geo/query)
    ├── components/
    │   ├── chrome/UtilityBar.jsx  PrimaryNav.jsx  Breadcrumb.jsx
    │   ├── controls/ModeTabs.jsx  PeriodPicker.jsx  ScopeSelect.jsx
    │   │            SexAgeFilter.jsx  HourRange.jsx  WeekdayToggle.jsx  GridToggle.jsx
    │   ├── map/MapView.jsx  Legend.jsx  MapTooltip.jsx
    │   ├── panel/KpiCallout.jsx  CompareBar.jsx  HourlyLine.jsx
    │   └── ui/Card.jsx  PillTab.jsx  Button.jsx  Select.jsx  CornerSquare.jsx
    └── lib/colorScale.js   # 값→그린 스케일(choropleth)
```

---

## 핵심 계약

### tokens.css (NVIDIA → CSS 변수)
```css
:root{
  --green:#76b900; --green-dark:#5a8d00; --green-pale:#bff230; --on-primary:#000;
  --ink:#000; --body:#1a1a1a; --canvas:#fff; --surface-dark:#000;
  --surface-soft:#f7f7f7; --surface-elevated:#1a1a1a;
  --hairline:#ccc; --hairline-strong:#5e5e5e;
  --mute:#757575; --stone:#898989; --ash:#a7a7a7;
  --on-dark:#fff; --on-dark-mute:rgba(255,255,255,.7);
  --link:#0046a4; --error:#e52020; --warning:#df6500; --success:#3f8500;
  --r:2px; --r-none:0;
  --sp-xxs:2px; --sp-xs:4px; --sp-sm:8px; --sp-md:12px; --sp-lg:16px; --sp-xl:24px; --sp-xxl:32px; --sp-section:64px;
  --font:'Inter',Arial,Helvetica,sans-serif;
}
```
타이포 유틸(디자인 **12티어 전체** 정의): `.t-display-xl{700 48px/1.25}` … `.t-card-title{700 17px/1.47}` `.t-body{400 16px/1.5}` `.t-caption{700 14px/1.43 uppercase}`. ⚠ **예외 명시**: `heading-lg`=**weight 400** 22px/1.75, `button-sm`=14.4px/1 **letter-spacing:0.144px**(PillTab/ModeTabs — 시스템 유일 자간).

### 상태 (store/useStore.js)
```
selection: { level:'gu'|'dong'|'grid', gu:null, dong:null,
  mode:'month'|'week'|'day', period:'202506',
  hours:[0..23], weekday:'전체', sex:'전체', ages:[] }
data: { districtsGeo, dongsGeo, gridsGeo, values:[], dayseries:[], 일수, loading, error }
actions: setMode, setPeriod, drillTo(level,code), toggleGridView(), setSex, setAges, setHours, setWeekday, fetchAll()
```
`drillTo`: gu클릭→level=dong,gu=code / dong클릭→level=grid(동스코프),dong=code / breadcrumb 상위복귀.
`toggleGridView`(구 화면 전용): level을 **dong↔grid(구스코프, dong=null)** 전환 → **구 전체 격자 히트맵(A-2)**. grid+dong=null이면 백엔드 `?gu=`/구스코프 집계 호출.

### 레이아웃 (App.jsx)
```
┌ UtilityBar (dark 32px: "서울 생활인구 대시보드" · 데이터기간) ┐
├ PrimaryNav  (dark 64px: 그린 워드마크 · ModeTabs[일|주|월])   ┤
├ Breadcrumb  (soft 48px: 서울 > 강남구 > 역삼1동)              ┤
├──────────────┬───────────────────────────┬─────────────────┤
│ 필터레일 320 │   MapView (deck.gl)        │ KPI/차트 패널   │
│ (canvas,     │   + Legend(좌하)           │ KpiCallout ×N   │
│  hairline)   │   + Tooltip                │ CompareBar      │
│ PeriodPicker │                            │ HourlyLine(일간)│
│ ScopeSelect  │                            │ (corner-square) │
│ SexAgeFilter │                            │                 │
│ HourRange    │                            │                 │
│ WeekdayToggle│                            │                 │
└──────────────┴───────────────────────────┴─────────────────┘
```

### 지도 (map/MapView.jsx)
- `DeckGL` + `react-map-gl/maplibre` 베이스맵(Positron).
- 레이어: 현재 level GeoJSON(`GeoJsonLayer`). **조인키(레벨별 property=응답 code)**: gu=`구코드` · dong=`행정동코드` · grid=`격자코드` → `getFillColor=colorScale(values[feature.properties[키]])`. `stroked` `getLineColor=[204,204,204]`(hairline), 구경계·**선택 강조=ink 굵은 보더**(`[0,0,0]`, lineWidth↑ — 그린 금지).
- `onClick` → `drillTo`. `onHover` → MapTooltip(코드·이름·값·일평균).
- `colorScale.js`: 단색 그린 시퀀셜(흰→`#76b900`→`#5a8d00`), 분위수(quantile) 6단계.

### API (api/client.js)
- `getDistricts/getDongs(gu)/getRange`, `getGeo(level,scope)`, `postQuery(selection)`, `postDay(selection)`.
- vite proxy `/api`→`http://localhost:9601`.

---

## Tasks

### Task 1: 스캐폴드 + 디자인 토큰
**Files:** Create `frontend-react/{package.json,vite.config.js,index.html,src/main.jsx,src/styles/tokens.css,src/styles/base.css}`
- [ ] `npm create vite@latest frontend-react -- --template react` 후 deps 설치(deck.gl react-map-gl maplibre-gl zustand plotly.js-dist react-plotly.js).
- [ ] vite.config: server.port=9600, proxy `/api`→9601.
- [ ] index.html: Inter 웹폰트(@fontsource 또는 CDN), `<div id=root>`.
- [ ] tokens.css/base.css: 위 계약 변수 + 타이포 유틸. App.jsx에 "Hello" 렌더.
- [ ] 검증: `npm run dev` → 9600 접속, 그린 버튼 1개 보임(토큰 적용 확인).
- [ ] Commit.

### Task 2: 셸 크롬 (UtilityBar/PrimaryNav/Breadcrumb)
**Files:** Create `src/components/chrome/*`, `src/components/ui/{Button,PillTab,CornerSquare}.jsx`; Modify App.jsx
- [ ] UtilityBar(dark 32px), PrimaryNav(dark 64px, 그린 워드마크), Breadcrumb(soft 48px) — 디자인 토큰 적용(2px, hairline, 그린 절제).
- [ ] Button(primary 그린/outline 그린보더), PillTab(active=ink반전), CornerSquare(12px 그린).
- [ ] 검증: 레이아웃 3바 + 본문 영역, 다크/캔버스 2모드 확인.
- [ ] Commit.

### Task 3: 상태 + API 클라이언트
**Files:** Create `src/store/useStore.js`, `src/api/client.js`
- [ ] zustand 스토어(위 계약). client.js fetch 래퍼.
- [ ] 앱 마운트 시 `getRange`+`getDistricts`+`getGeo('gu')` 로드.
- [ ] 검증: 콘솔에 구 25건·구 geojson 로드 확인.
- [ ] Commit.

### Task 4: 컨트롤 패널 (필터레일)
**Files:** Create `src/components/controls/*`, `src/components/ui/Select.jsx`
- [ ] ModeTabs(일/주/월 pill-tab), PeriodPicker(mode별: 월=YYYY-MM, 주=주선택, 일=날짜), ScopeSelect(구/동 드롭다운), SexAgeFilter(성별 pill + 연령 버킷 badge 다중), HourRange(0~23 듀얼 슬라이더, "새벽 제외" 프리셋), WeekdayToggle(전체/주중/주말).
- [ ] 각 변경 → store 액션 → `fetchAll()` 디바운스.
- [ ] 검증: 필터 바꾸면 store.selection 갱신.
- [ ] Commit.

### Task 5: 지도 렌더 + 범례
**Files:** Create `src/components/map/{MapView,Legend,MapTooltip}.jsx`, `src/lib/colorScale.js`
- [ ] DeckGL+MapLibre(Positron) + GeoJsonLayer(현재 level). colorScale 그린 분위수 6단계.
- [ ] Legend(좌하, 단계별 그린 + 값 구간), Tooltip(hover 코드·이름·값).
- [ ] 초기: 서울 전체 구 choropleth(202506 기본).
- [ ] 검증: 25개 구가 그린 농담으로 칠해짐, hover 값 표시.
- [ ] Commit.

### Task 6: 드릴다운 인터랙션
**Files:** Modify MapView, useStore, Breadcrumb
- [ ] 구 클릭→동 레벨(그 구 동 geojson 로드+질의), 동 클릭→격자 레벨. Breadcrumb로 상위 복귀.
- [ ] level 바뀌면 해당 geojson + values 재질의, 지도 뷰포트 해당 영역 fit.
- [ ] 검증: 서울→강남구→역삼동→격자 히트맵까지 클릭 드릴다운.
- [ ] Commit.

### Task 7: KPI/차트 패널
**Files:** Create `src/components/panel/{KpiCallout,CompareBar,HourlyLine}.jsx`, `src/components/ui/Card.jsx`
- [ ] KpiCallout(callout-stat: 큰 그린 숫자 — 합계·일평균), CompareBar(현재 level 상위 비교, Plotly 그린 막대), HourlyLine(일간 모드: 시간대 시계열 Plotly).
- [ ] 카드에 corner-square, hairline 보더, 그림자 없음.
- [ ] 검증: 구별 막대 + 합계/일평균 KPI 표시. 일간 모드 시 시간대 라인.
- [ ] Commit.

### Task 8: 통합 + 상태(로딩/빈/에러)
**Files:** Modify App.jsx, useStore
- [ ] selection 변경 → query → 지도/차트/KPI 동시 갱신. 로딩 스피너(그린), 빈/에러 메시지(error 토큰).
- [ ] 일/주/월 모드별 패널 구성 전환(일간=시간라인 강조).
- [ ] 검증: 전 시나리오(서울 구별 월간 → 강남 동별 주간 → 동 격자 일간) 동작.
- [ ] Commit.

### Task 9: 반응형 + 디자인 마감
**Files:** Modify styles, components
- [ ] 1280 기준, <1024 필터레일 접기/패널 하단 이동(디자인 doc breakpoint).
- [ ] 44px 터치타깃, 헤어라인/2px/코너스퀘어 점검, 그린 1개 원칙 점검(do/don't).
- [ ] 검증: 디자인 doc Do/Don't 대조 셀프리뷰.
- [ ] Commit.

---

## 교차검토 반영 (2026-06-10, superpowers 코드리뷰 5에이전트)
**위 본문에 반영됨:** 그린 예산(chrome 강조 ink 중화)·선택 구 ink 보더·레벨별 조인키(property=code)·spacing `xxs:2px`·타이포 예외(heading-lg 400, button-sm 0.144px).
**보강(태스크 진입 전):**
- Task3: 백엔드(9601) 먼저 기동 → 프론트 부팅 시 `/healthz` precheck. features 배열→`{code:값}` 변환 위치(client.js or store) 고정.
- Task5/7: MapLibre `NavigationControl`·Plotly `modebar`·툴팁의 기본 `border-radius`/`box-shadow`를 2px·none으로 CSS 오버라이드(각진 플랫 원칙). Plotly `colorway` 모노크롬(ink/mute/stone) + 강조 그린 1계열.
- Task1: Inter는 `@fontsource/inter` weight 400·700 self-host(서브셋 latin, font-display:swap).
- `--link`(#0046a4)은 인라인 프로즈 전용 — chrome/버튼 금지(base.css 주석).
- **구 화면 격자 히트맵 = A-2 확정(2026-06-11)**: 구(동별) 화면에 `GridToggle`("격자로 보기") → `toggleGridView()`로 구 전체 격자 히트맵 전환(동별↔격자 자유). Task4에 GridToggle 추가, Task6에 'gu 스코프 격자(dong=null) 로딩+질의' 반영. 백엔드 `?gu=`/구스코프 집계와 연동.

## Self-Review 메모
- 스펙 커버: 공간 드릴다운(Task6) · 일/주/월(Task4,7) · 성별·연령(Task4) · 시간선택(Task4) · 주중주말·일평균(Task4,7) · 지도/차트(Task5,7) — 모두 태스크 존재.
- 디자인 doc 커버: 2모드 표면(Task2) · 그린 절제·choropleth(Task5) · 2px/헤어라인/코너스퀘어(Task2,7) · Inter/타이포 위계(Task1) · 반응형(Task9).
- 타입 일관성: store 키(level/gu/dong/mode/period/hours/weekday/sex/ages) 전 태스크 동일. colorScale 시그니처 통일.
- 의존: 백엔드 계획의 엔드포인트와 client.js 1:1.
```
