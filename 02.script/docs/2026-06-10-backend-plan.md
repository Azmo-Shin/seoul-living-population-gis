# GIS 대시보드 백엔드(FastAPI) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 또는 executing-plans 로 태스크 단위 실행. 체크박스(`- [ ]`)로 추적.

**Goal:** `shin_project` 마트/차원/GeoJSON을 조회하는 FastAPI API 서버를 만들어, 프론트(구→동→격자 드릴다운 + 일/주/월 시간집계 지도)에 데이터를 공급한다.

**Architecture:** `2026_05_text` 패턴 준수 — API 전용 FastAPI(포트 9601) + 프론트 별도(9600) + CORS. 라우트는 도메인별 분리(`meta`/`geo`/`query`). DB 접속은 기존 `00.input_data.py`의 커넥션 헬퍼 재사용. 월간=마트 조회, 주간/일간=원천+달력 조회.

**Tech Stack:** FastAPI 0.115, uvicorn, pydantic v2, mysql-connector-python, python-dotenv.

---

## File Structure

```
2026_06_GIS/02.script/backend/
├── main.py                 # FastAPI 앱, CORS, 라우터 등록, /healthz
├── config.py               # 포트·경로·CORS·메트릭 컬럼 매핑 상수
├── db.py                   # 커넥션 풀(00.input_data 재사용), 쿼리 헬퍼
├── api/
│   ├── __init__.py
│   ├── schemas.py          # pydantic 요청/응답 모델
│   ├── routes_meta.py      # 구/동 목록, 가용 기간
│   ├── routes_geo.py       # 구/동/격자 GeoJSON 서빙
│   └── routes_query.py     # 월/주/일 집계 조회 (핵심)
├── services/
│   ├── __init__.py
│   ├── metrics.py          # UI 선택(성별·연령) → 마트 컬럼 매핑·SUM식 생성
│   └── query_builder.py    # level/mode별 SQL 생성 + 실행
├── requirements.txt
└── tests/
    ├── test_metrics.py
    ├── test_query_builder.py
    └── test_api.py
```

GeoJSON은 `03.result/spatial/{시군구,행정동,격자}.geojson` 를 그대로 서빙.

---

## 핵심 계약 (Contracts)

### 메트릭 매핑 (services/metrics.py)
- 마트 measure 컬럼 = `생활인구합계` + 남/여 × 14연령대(28개).
- UI는 `성별`(전체/남/여) × `연령`(전체 또는 버킷 다중선택)을 보냄.
- 매핑 규칙:
  - 성별=전체 & 연령=전체 → `생활인구합계`
  - 성별 지정 & 연령=전체 → 해당 성별 14개 컬럼 합
  - 연령 버킷 지정 → 성별×버킷 컬럼들 합 (예: 남 20대 = `남자 20~24세`+`남자 25~29세`)
- 연령 그룹 UI 버킷(10세 단위) → 원자 컬럼 매핑 테이블을 config 에 둠.

### 집계 SQL (services/query_builder.py)
- **월간(month)**: `마트_월_시간` 사용.
  ```sql
  SELECT {code_expr} code, SUM({metric_sum}) AS 합계
  FROM `마트_월_시간`
  WHERE `연월`=%s AND `주중주말` IN ({wk}) AND `시간` IN ({hours})
    {scope_filter} GROUP BY code
  ```
  - `code_expr`(⚠ **데이터소스별 분기**): gu=`LEFT(행정동코드,5)` · dong=`행정동코드` · grid=**월간 `격자코드`(마트) / 주·일간 `250M격자`(원천)** — 안 나누면 주/일간 grid에서 `Unknown column '격자코드'`.
  - `scope_filter`: dong레벨=`AND LEFT(행정동코드,5)=%s` · grid레벨=**동스코프 `AND 행정동코드=%s` 또는 구스코프 `AND LEFT(행정동코드,5)=%s`** (요청에 dong 있으면 동스코프, gu만 있으면 **구 전체 격자**=A-2 토글)
  - **일평균 = 합계 ÷ 일수** — 일수는 **원천 실제 적재일 ∩ 선택 주중주말** 기준(달력 전일수 단독 금지: 마트는 적재 파티션만 합산하므로 부분월 왜곡). 산출: `달력` ∩ `_적재로그`(원천 distinct 일자), 또는 마트빌드 시 (연월,주중주말)별 distinct 적재일수 저장. 응답에 `부분월` 플래그.
  - **mode별 일수/일평균**: month=연월 적재일수 · week=연주 적재일수 · **day=일평균·주중주말 비적용**(시간축만).
- **주간(week)**: 원천+달력. ⚠ **사전조건 `ix_일자` 필수**(`00.input_data.py --build-indexes`로 생성; main 부팅 시 존재 점검 — 없으면 풀스캔으로 1.5s 미달). 주 = `달력.연주`로 날짜집합 선조회 → `생활인구_250m`을 `일자 IN(...)`(파티션 프루닝)로 필터.
  ```sql
  SELECT {code_expr} code, SUM({metric_sum}) 합계
  FROM `생활인구_250m` f JOIN `달력` d ON f.`일자`=d.`일자`
  WHERE d.`연주`=%s AND d.`주중주말` IN ({wk}) AND f.`시간` IN ({hours}) {scope}
  GROUP BY code
  ```
- **일간(day)**: 특정일 시간대 변동. `WHERE f.일자=%s GROUP BY f.시간, code` → 시간축 시계열.

### 응답 스키마 (api/schemas.py)
```python
class QueryRequest(BaseModel):
    level: Literal["gu","dong","grid"]
    mode: Literal["month","week","day"]
    period: str                      # '202506' | '2025-23' | '20250605'
    gu: str | None = None            # dong/grid 레벨 스코프
    dong: str | None = None
    hours: list[int] = list(range(24))
    weekday: Literal["주중","주말","전체"] = "전체"
    sex: Literal["전체","남","여"] = "전체"
    ages: list[str] = []             # [] = 전체연령

class QueryFeature(BaseModel):
    code: str; 합계: float; 일평균: float | None = None
class QueryResponse(BaseModel):
    level: str; mode: str; 일수: int | None
    features: list[QueryFeature]
class DayPoint(BaseModel):
    code: str; 시간: int; 값: float
```

### GeoJSON ↔ 응답 code 조인키 (프론트와 공유 — 드릴다운 미스매치 방지)
| level | geojson property | 응답 feature.code |
|---|---|---|
| gu | `구코드` | `LEFT(행정동코드,5)` (5자리 구코드) |
| dong | `행정동코드` (=ADSTRD_CD) | `행정동코드` |
| grid | `격자코드` (=CELL_ID) | 월간 `격자코드` / 주·일간 `250M격자` (값·포맷 동일) |

### API 엔드포인트
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/healthz` | 상태 |
| GET | `/api/meta/range` | 가용 월·주·일 min/max (일·주는 `_적재로그` 원천 distinct 일자 기준 — 달력은 미적재기간 포함하므로 사용 금지) |
| GET | `/api/meta/districts` | 구 목록(공간_시군구) |
| GET | `/api/meta/dongs?gu=` | 구의 동 목록(공간_행정동) |
| GET | `/api/geo/districts` | 시군구.geojson |
| GET | `/api/geo/dongs` | 행정동.geojson (옵션 `?gu=` 필터) |
| GET | `/api/geo/grids?dong=` 또는 `?gu=` | 격자.geojson 필터 (동의 격자 / **구 전체 격자**=A-2; 마트 distinct 격자) |
| POST | `/api/query` | 월/주 집계(레벨별) |
| POST | `/api/query/day` | 일간 시간대 시계열 |

---

## Tasks

### Task 1: 프로젝트 스캐폴드 + 헬스체크
**Files:** Create `backend/{main.py,config.py,requirements.txt,api/__init__.py}`
- [ ] requirements.txt 작성(fastapi,uvicorn[standard],pydantic,mysql-connector-python,python-dotenv).
- [ ] config.py: `API_PORT=9601`, `FRONT_ORIGINS=["http://localhost:9600","http://127.0.0.1:9600"]`, `SPATIAL_DIR=../../03.result/spatial`, 연령 버킷→컬럼 매핑 dict.
- [ ] main.py: FastAPI 앱 + CORS + `/healthz` 반환 `{"ok":True}`.
- [ ] 검증: `cd backend && uvicorn main:app --port 9601` 후 `curl localhost:9601/healthz` → `{"ok":true}`.
- [ ] Commit.

### Task 2: DB 레이어 (db.py)
**Files:** Create `backend/db.py`, `backend/tests/test_api.py`
- [ ] db.py: `00.input_data.py`를 importlib로 로드해 `connect()/load_db_config()` 재사용. `fetch_all(sql, params)`·`fetch_one` 헬퍼(커넥션 풀 or per-request 커넥션).
- [ ] 검증 테스트: `SELECT COUNT(*) FROM 마트_월_시간` > 0.
- [ ] Commit.

### Task 3: 메타 라우트 (routes_meta.py)
**Files:** Create `backend/api/routes_meta.py`; Modify `main.py`(라우터 등록)
- [ ] `/api/meta/districts` → `SELECT 구코드,구명 FROM 공간_시군구 ORDER BY 구코드`.
- [ ] `/api/meta/dongs` → `SELECT 행정동코드,행정동명 FROM 공간_행정동 WHERE 구코드=%s ORDER BY 행정동코드`.
- [ ] `/api/meta/range` → 마트 `MIN/MAX 연월`, 달력 최신 일자.
- [ ] 검증: `curl /api/meta/districts` → 25건, 종로구 포함.
- [ ] Commit.

### Task 4: GeoJSON 라우트 (routes_geo.py)
**Files:** Create `backend/api/routes_geo.py`
- [ ] 구/동 geojson은 파일 FileResponse(필요 시 `?gu=`로 동 features 필터해 반환).
- [ ] `/api/geo/grids?dong=` → `SELECT DISTINCT 격자코드 FROM 마트_월_시간 WHERE 행정동코드=%s` 로 격자집합 → `격자.geojson` 필터 반환.
- [ ] `/api/geo/grids?gu=` (**A-2 구 전체 격자**) → `WHERE LEFT(행정동코드,5)=%s` 로 구 전체 격자집합(~400~600) → 동일 필터 반환.
- [ ] 검증: `curl '/api/geo/grids?dong=11110515'` → FeatureCollection, features>0.
- [ ] Commit.

### Task 5: 메트릭 매핑 (services/metrics.py) — TDD
**Files:** Create `backend/services/metrics.py`, `backend/tests/test_metrics.py`
- [ ] 실패 테스트: `metric_sum(sex="남", ages=["20대"])` == "`남자 20~24세`+`남자 25~29세`" (백틱 SUM식).
- [ ] 구현: 성별×연령 선택 → 마트 컬럼 SUM식 문자열 생성. 전체=생활인구합계.
- [ ] 테스트 통과. Commit.

### Task 6: 쿼리 빌더 (services/query_builder.py) — TDD
**Files:** Create `backend/services/query_builder.py`, `backend/tests/test_query_builder.py`
- [ ] 실패 테스트: `build_month_sql(level="gu",...)` 가 기대 SQL/파라미터 생성(코드식·스코프·시간 IN·주중주말 IN).
- [ ] 구현: month/week/day별 SQL+params. 시간 리스트·주중주말 안전 바인딩.
- [ ] 테스트 통과. Commit.

### Task 7: 쿼리 라우트 (routes_query.py) — 통합
**Files:** Create `backend/api/routes_query.py`, extend `tests/test_api.py`
- [ ] `/api/query` (month/week): query_builder 실행 → features + 일수(달력) → 일평균 계산.
- [ ] `/api/query/day`: 일간 시간대 시계열.
- [ ] 통합 테스트: 서울 구별(202506 주중 6~22시) → 25건, 강남구 최상위(앞서 검증된 패턴).
- [ ] 검증: 응답시간 < 1.5s.
- [ ] Commit.

### Task 8: 실행 스크립트 + 문서
**Files:** Create `backend/run.md`(또는 README)
- [ ] 실행법: `uvicorn main:app --host 0.0.0.0 --port 9601 --reload`.
- [ ] 전체 엔드포인트 수동 검증 체크리스트.
- [ ] Commit.

---

## 교차검토 반영 (2026-06-10, superpowers 코드리뷰 5에이전트)
**필수(critical/major) — 위 계약/태스크에 반영됨:**
1. 주/일간 grid `code_expr` 데이터소스 분기(원천=`250M격자`). Task6 테스트에 `week/day grid==250M격자` 단언 추가.
2. GeoJSON↔응답 조인키 계약표 추가(프론트와 공유).
3. 월간/주간 일평균 일수 = 원천 실제 적재일 기준(부분월 왜곡 방지) + `부분월` 플래그.
4. week/day는 `ix_일자` 사전조건 + 부팅 점검.
5. `/api/meta/range` 월·주·일 min/max를 `_적재로그` 기준.
6. **구 스코프 격자 히트맵 = A-2 확정(2026-06-11)**: 구 화면에 "격자로 보기" 토글 → 구 전체 격자 히트맵. 위 `/api/geo/grids?gu=` + grid `scope_filter`의 구스코프 분기로 반영됨. (요청에 dong 없으면 gu 스코프 grid 집계.)

**보강(minor):**
- config `SPATIAL_DIR`은 `Path(__file__).resolve()` 절대경로(03.build_spatial 패턴). cwd 의존 제거.
- IN절 바인딩: `metric_sum`=화이트리스트 컬럼만, `hours`=0~23 검증 후 placeholder, `ages`=enum 검증. Task6에 주입 테스트.
- `db.py`는 `importlib.util.spec_from_file_location`로 `00.input_data.py` 로드(숫자시작 모듈명). env 위치(02.script `.env` 우선, stitch_ml 폴백) run.md에 기재.
- Task6/7에 '마트 주중주말 일수 ↔ 달력(공휴일→주말) 교집합' 검증 + period(week) `YYYY-WW`(예 2025-23) 파싱 단위테스트. (공휴일→주말은 `02.build_calendar.py`에서 이미 처리 — 검증만.)

## Self-Review 메모
- 스펙 커버: 구/동/격자 드릴다운(Task7 level), 일/주/월(mode), 성별·연령(metrics), 시간선택(hours), 주중/주말·일평균 — 모두 태스크 존재. (구-스코프 격자히트맵은 위 6번 결정 대상.)
- 타입 일관성: `code_expr`(데이터소스 분기)/`metric_sum`/`weekday` 명칭 통일. 조인키 계약표로 프론트와 정합.
- 격자→동 매핑은 마트 distinct로 해결(별도 테이블 불필요). 라이브 검증: 컬럼명·연주·구 25개·코드체계 일치.
