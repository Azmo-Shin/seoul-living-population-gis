# 서울 생활인구 GIS 백엔드 실행 가이드

## 1. 개요

FastAPI 기반 API 전용 서버. 서울 250m 격자 생활인구 드릴다운 분석 데이터를 제공한다.

| 항목 | 값 |
|------|-----|
| 포트 | **9601** (API 전용) |
| DB | `shin_project` @ <DB_SERVER_IP> (MariaDB/MySQL) |
| 프론트 | 별도 서버 `:9600` (CORS 허용) |
| 주요 데이터 | 마트_월_시간, 생활인구_250m, 달력, _적재로그, 공간_시군구, 공간_행정동 |

---

## 2. 사전조건

### 2-1. 패키지 설치

```bash
cd 02.script/backend
pip install -r requirements.txt
```

의존 패키지: `fastapi==0.115.0`, `uvicorn[standard]==0.30.0`, `pydantic>=2.7`, `mysql-connector-python>=8.2.0`, `python-dotenv>=1.0.1`

---

### 2-2. DB 접속정보 `.env`

`db.py`는 `00.input_data.py`의 `load_db_config`를 재사용한다.  
`.env` 파일 탐색 순서는 해당 함수 로직을 따른다.

**권장 위치**: `2026_06_GIS/.env` (프로젝트 루트)  
**폴백**: `00.input_data.py` 내 stitch_ml 경로 (기존 설정 재사용)

```dotenv
DB_HOST=<DB_SERVER_IP>
DB_PORT=3306
DB_USER=<계정>
DB_PASSWORD=<비밀번호>
```

---

### 2-3. 공간 GeoJSON 파일

`config.py`의 `SPATIAL_DIR`는 `2026_06_GIS/03.result/spatial/`을 가리킨다.  
아래 3개 파일이 모두 존재해야 한다 (없으면 서버 시작 시 경로 경고 출력, geo 엔드포인트 500).

```
2026_06_GIS/03.result/spatial/
├── 시군구.geojson
├── 행정동.geojson
└── 격자.geojson
```

생성 방법: 프로젝트 루트의 `03.build_spatial.py` 실행.

---

### 2-4. 원천 인덱스 확인 (week/일간/추이 모드 성능)

`POST /api/query` week 모드와 `POST /api/query/day`는 `생활인구_250m` 원천(수억 행, 월별 RANGE 파티션)을 직접 조회한다.
공간 전체를 훑는 이 쿼리들은 날짜창(`일자`)만으로 충분하므로 `ix_일자` 가 핵심이다.

> **이미 빌드됨** — 신규 환경 배포 시에만 아래 중 하나 실행.

```bash
# 방법 A: 인제스트 스크립트 플래그
python 00.input_data.py --build-indexes

# 방법 B: MySQL 직접
CREATE INDEX ix_일자 ON `생활인구_250m`(`일자`);
```

**추이 week/day 모드 (단일 코드 + 날짜창)** — `POST /api/query/trend` 의 `mode=week|day` 는
원천을 **단일 코드(행정동코드/250M격자) + 최근 날짜창**으로 좁힌다. `ix_일자` 만으로는 날짜창
파티션 안의 모든 격자(하루 ~24만 행 × 날짜수)를 훑어 **추이 1건당 ~30초**가 걸린다.
아래 복합 인덱스를 추가하면 코드로 ref + 일자 레인지 스캔을 타 **수초 미만**으로 단축된다.

> **이미 빌드됨** — 신규 환경 배포 시에만 아래 실행 (비파괴 ADD INDEX, 수억 행 기준 인덱스당 수~수십 분 소요).

```sql
-- dong 동등 / gu 접두범위(행정동코드 >= ? AND < ?) + 일자 레인지
CREATE INDEX ix_행정동코드_일자 ON `생활인구_250m`(`행정동코드`, `일자`);
-- grid 동등 필터(원천 격자 컬럼명은 250M격자) + 일자 레인지
CREATE INDEX ix_250M격자_일자 ON `생활인구_250m`(`250M격자`, `일자`);
```

또는 백엔드 폴더의 일회성 헬퍼로 재생성(이미 있으면 skip):

```bash
cd 02.script/backend
python _build_raw_trend_idx.py
```

---

### 2-5. 마트 인덱스 확인 (trend 추이 모드 성능)

`POST /api/query/trend`은 `마트_월_시간`을 **단일 코드(행정동코드/격자코드)로 필터 + `GROUP BY 연월`** 한다.
마트 PK는 `(연월, 행정동코드, 격자코드, 주중주말, 시간)` 으로 **연월이 선두**이므로, 연월 없이 코드만으로
필터하면 PK 프루닝이 안 돼 **풀스캔(~14M행)** 으로 추이 1건당 약 **32초**가 걸린다.
아래 복합 인덱스를 추가하면 코드 컬럼으로 **인덱스 레인지/ref 스캔**을 타고, `(코드, 연월)` 순서라
`GROUP BY 연월` 정렬에도 유리하다 (dong/grid는 수초 미만으로 단축).

> **이미 빌드됨** — 신규 환경 배포 시에만 아래 실행 (비파괴 ADD INDEX, 14M행 기준 인덱스당 약 1~2분 소요).

```sql
-- dong 동등 필터 + gu 접두범위(행정동코드 >= ? AND < ?) + GROUP BY 연월
CREATE INDEX ix_행정동코드_연월 ON `마트_월_시간`(`행정동코드`, `연월`);
-- grid 동등 필터 + GROUP BY 연월
CREATE INDEX ix_격자코드_연월 ON `마트_월_시간`(`격자코드`, `연월`);
```

또는 백엔드 폴더의 일회성 헬퍼로 재생성(이미 있으면 skip):

```bash
cd 02.script/backend
python _build_trend_idx.py
```

> 인덱스는 DB에만 존재하며(코드 변경 아님), 추가만으로 실행 중인 uvicorn(:9601) **재시작 불필요** — 서버가
> 이미 보내고 있던 같은 SQL이 그대로 빨라진다.

---

## 3. 서버 실행

> **주의**: `import config`, `import db` 등이 상대 경로로 해결되므로 **반드시 `02.script/backend/` 를 현재 디렉터리로** 실행해야 한다.

```bash
cd 02.script/backend
uvicorn main:app --host 0.0.0.0 --port 9601 --reload
```

`--reload` 는 개발 시 편의용. 운영 환경에서는 제거하거나 `--workers 2` 등 추가 조정.

정상 기동 로그:

```
서울 생활인구 GIS API 서버 시작 (포트 9601)
SPATIAL_DIR: .../03.result/spatial (exists=True)
```

---

## 4. 엔드포인트

### 4-1. Health Check

| Method | Path | 설명 |
|--------|------|------|
| GET | `/healthz` | 서버 상태 확인 |

**응답**: `{"ok": true}`

```bash
curl http://localhost:9601/healthz
```

---

### 4-2. 메타 정보 (`/api/meta`)

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/meta/districts` | 서울 25개 자치구 코드·명 목록 |
| GET | `/api/meta/dongs?gu=<구코드>` | 특정 구 소속 행정동 코드·명 목록 (gu 필수) |
| GET | `/api/meta/range` | 데이터 가용 기간 범위 (day/month/week) |

```bash
# 자치구 목록
curl "http://localhost:9601/api/meta/districts"

# 강남구(11680) 행정동 목록
curl "http://localhost:9601/api/meta/dongs?gu=11680"

# 가용 기간
curl "http://localhost:9601/api/meta/range"
```

`/api/meta/range` 응답 예시:
```json
{
  "day":   {"min": "2023-01-01", "max": "2025-12-31"},
  "month": {"min": "2023-01",    "max": "2025-12"},
  "week":  {"min": "2023-W01",   "max": "2025-W52"}
}
```

---

### 4-3. 지리 데이터 (`/api/geo`)

GeoJSON FeatureCollection 반환. 파일은 서버 기동 시 메모리에 1회 로드 (lru_cache).

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/geo/districts` | 서울 25개 자치구 GeoJSON |
| GET | `/api/geo/dongs?gu=<구코드>` | 행정동 GeoJSON (gu 생략 시 전체 425개) |
| GET | `/api/geo/grids?dong=<행정동코드>` | 특정 동 소속 격자 GeoJSON |
| GET | `/api/geo/grids?gu=<구코드>` | 구 전체 격자 GeoJSON (A-2 구전체격자, dong 없을 때) |

> `dong`과 `gu` 동시 지정 시 `dong` 우선. 둘 다 없으면 400.

```bash
# 자치구 GeoJSON
curl "http://localhost:9601/api/geo/districts"

# 강남구 행정동 GeoJSON
curl "http://localhost:9601/api/geo/dongs?gu=11680"

# 역삼1동(11680108) 격자 GeoJSON
curl "http://localhost:9601/api/geo/grids?dong=11680108"

# 강남구 전체 격자 GeoJSON (A-2)
curl "http://localhost:9601/api/geo/grids?gu=11680"
```

---

### 4-4. 생활인구 집계 쿼리

#### `POST /api/query` — 월/주 공간 집계

**요청 바디** (`QueryRequest`):

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `level` | `"gu"` / `"dong"` / `"grid"` | 필수 | 집계 공간 단위 |
| `mode` | `"month"` / `"week"` | 필수 | 기간 모드 |
| `period` | string | 필수 | month: `"YYYYMM"` (예: `"202506"`), week: `"YYYY-WW"` (예: `"2025-23"`) |
| `gu` | string / null | 조건부 | 자치구 5자리 코드. dong/grid level에 필요 |
| `dong` | string / null | 조건부 | 행정동 8자리 코드. grid level에서 동 단위 시 사용 |
| `hours` | int[] | 선택 | 시간 필터 (0~23). 기본값: 전체 24시간 |
| `weekday` | `"전체"` / `"주중"` / `"주말"` | 선택 | 주중주말 필터. 기본: `"전체"` (공휴일은 달력 테이블 기준 주말 처리됨) |
| `sex` | `"전체"` / `"남"` / `"여"` | 선택 | 성별 필터. 기본: `"전체"` |
| `ages` | string[] | 선택 | 연령 버킷 (예: `["20대","30대"]`). 빈 배열 = 전체 연령 |

**연령 버킷 목록**: `0대`, `10대`, `20대`, `30대`, `40대`, `50대`, `60대`, `70대이상`

**응답** (`QueryResponse`):
```json
{
  "level": "gu",
  "mode": "month",
  "일수": 22,
  "features": [
    {"code": "11110", "합계": 1234567.0, "일평균": 56116.68, "행정동코드": null},
    ...
  ]
}
```

- `일수`: 실제 적재일수 (달력 ∩ _적재로그). 일평균 = 합계 ÷ 일수.
- `행정동코드`: **grid level 일 때만** 채워진다 (각 격자가 속한 행정동코드, 동별 격자 분포용). gu/dong level 에서는 `null`.
- month 모드: `마트_월_시간` 테이블 (빠름)
- week 모드: `생활인구_250m` + `달력` 서브쿼리 (ix_일자 필요)

**예시 — 구 단위 월간 전체 조회**:
```bash
curl -X POST http://localhost:9601/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "level": "gu",
    "mode": "month",
    "period": "202506",
    "weekday": "주중",
    "hours": [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22],
    "sex": "전체",
    "ages": []
  }'
```

**예시 — 강남구 격자 주간 조회 (A-2)**:
```bash
curl -X POST http://localhost:9601/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "level": "grid",
    "mode": "week",
    "period": "2025-23",
    "gu": "11680",
    "weekday": "전체",
    "hours": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23],
    "sex": "전체",
    "ages": []
  }'
```

---

#### `POST /api/query/day` — 일 시간별 시계열

하루(24시간)의 시간대별 공간 집계. 주중주말·시간 필터·일평균 없음.

**요청 바디** (`DayRequest`):

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `level` | `"gu"` / `"dong"` / `"grid"` | 필수 | 집계 공간 단위 |
| `period` | string | 필수 | `"YYYY-MM-DD"` (예: `"2026-06-05"`) |
| `gu` | string / null | 조건부 | 자치구 코드 (dong/grid level에 필요) |
| `dong` | string / null | 조건부 | 행정동 코드 (grid level에서 동 단위 시) |
| `sex` | `"전체"` / `"남"` / `"여"` | 선택 | 성별 필터. 기본: `"전체"` |
| `ages` | string[] | 선택 | 연령 버킷. 기본: 전체 |

**응답** (`DayResponse`):
```json
{
  "level": "gu",
  "mode": "day",
  "series": [
    {"시간": 0, "code": "11110", "값": 45678.0},
    {"시간": 1, "code": "11110", "값": 43210.0},
    ...
  ]
}
```

**예시**:
```bash
curl -X POST http://localhost:9601/api/query/day \
  -H "Content-Type: application/json" \
  -d '{
    "level": "gu",
    "period": "2026-06-05"
  }'
```

---

#### `POST /api/query/trend` — 단일 영역 추이 (월/주/일 모드)

단일 영역(구/동/격자)의 추이. `mode` 로 시간축(월/주/일)을 고른다. 프론트는 평균 = 합계 ÷ (일수 × 시간수) 로 추이를 그린다.

**요청 바디** (`TrendRequest`):

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `level` | `"gu"` / `"dong"` / `"grid"` | 필수 | 영역 단위 |
| `code` | string | 필수 | 영역 코드 — gu: 구코드(숫자 5자리), dong: 행정동코드, grid: 격자코드 |
| `mode` | `"month"` / `"week"` / `"day"` | 선택 | 시간축 모드. 기본: `"month"` |
| `hours` | int[] | 선택 | 시간 필터 (0~23). 기본: 전체 24시간 |
| `weekday` | `"전체"` / `"주중"` / `"주말"` | 선택 | 기본: `"전체"`. month/week 일수 분모에도 동일 적용 (day=sameWeekday 계열엔 미적용) |
| `sex` | `"전체"` / `"남"` / `"여"` | 선택 | 기본: `"전체"` |
| `ages` | string[] | 선택 | 연령 버킷. 빈 배열 = 전체 |

> gu level 의 `code` 는 행정동코드 접두 범위(`>= code AND < code+1`)로 구 전체를 SARGable 하게 합산한다.
> grid level 은 데이터소스별 격자 컬럼명이 다르다 — month=`격자코드`(마트), week/day=`250M격자`(원천). 빌더가 자동 분기한다.

**모드별 데이터소스/범위**:

| mode | 소스 | 범위 | 그룹 |
|------|------|------|------|
| `month` | `마트_월_시간` | 전체 기간(연월 전부) | `연월` |
| `week` | `생활인구_250m` + `달력` | **최근 ~12주** (≈3개월 날짜창) | `연주` |
| `day` | `생활인구_250m` (+`달력`) | recent30=최근 ~30 적재일 / sameWeekday=최근 ~12주 동일요일 | `일자` |

**응답** (`TrendResponse`) — month/week 는 `points`, day 는 `recent30`+`sameWeekday`:

month/week:
```json
{
  "level": "dong",
  "code": "11680510",
  "mode": "month",
  "points": [
    {"라벨": "202401", "합계": 23815272.56, "일수": 31},
    {"라벨": "202402", "합계": 21500000.0,  "일수": 29}
  ],
  "recent30": null,
  "sameWeekday": null
}
```
- `라벨` = month: `"YYYYMM"` (연월) / week: `"YYYY-WW"` (연주). 오름차순.
- `일수` = 해당 기간의 실제 적재일수 (달력 ∩ _적재로그, weekday 필터 반영). 프론트 평균 = 합계 ÷ (일수 × 시간수).
- week 는 최신 ~12주만 반환.

day:
```json
{
  "level": "dong",
  "code": "11680510",
  "mode": "day",
  "points": null,
  "recent30":    [{"일자": "2026-05-07", "합계": 778435.87}, ...],
  "sameWeekday": [{"일자": "2026-03-13", "합계": 770100.0},  ...]
}
```
- `recent30` = 최근 ~30 적재일 일별 합계 (일자 오름차순, 끝=최신 적재일).
- `sameWeekday` = 최신 적재일과 **같은 요일**(예: 모든 금요일)의 최근 ~12주 일별 합계.
- 일수=1(하루) 이므로 프론트 평균 = 합계 ÷ (1 × 시간수). 별도 일수 필드 없음.

**예시 — 강남구 월별 추이 (기본 month)**:
```bash
curl -X POST http://localhost:9601/api/query/trend \
  -H "Content-Type: application/json" \
  -d '{"level":"gu","code":"11680","weekday":"전체"}'
```

**예시 — 역삼동 주별 추이 (최근 12주)**:
```bash
curl -X POST http://localhost:9601/api/query/trend \
  -H "Content-Type: application/json" \
  -d '{"level":"dong","code":"11680510","mode":"week"}'
```

**예시 — 격자 일별 추이 (recent30 + 동일요일)**:
```bash
curl -X POST http://localhost:9601/api/query/trend \
  -H "Content-Type: application/json" \
  -d '{"level":"grid","code":"다사56754700","mode":"day"}'
```

---

### 4-5. API 자동 문서

FastAPI 내장 Swagger UI: <http://localhost:9601/docs>  
ReDoc: <http://localhost:9601/redoc>

---

## 5. 수동 검증 체크리스트

서버 기동 후 아래 순서로 확인한다.

```bash
# 1) health check
curl http://localhost:9601/healthz
# 기대: {"ok":true}

# 2) 자치구 목록
curl http://localhost:9601/api/meta/districts
# 기대: [{구코드, 구명}, ...] 25개

# 3) 행정동 목록
curl "http://localhost:9601/api/meta/dongs?gu=11680"
# 기대: 강남구 행정동 목록

# 4) 가용 기간
curl http://localhost:9601/api/meta/range
# 기대: {day, month, week} 범위

# 5) 구 GeoJSON
curl http://localhost:9601/api/geo/districts | python -c "import sys,json; d=json.load(sys.stdin); print(len(d['features']), '개 구')"
# 기대: 25개 구

# 6) 동 GeoJSON (구 필터)
curl "http://localhost:9601/api/geo/dongs?gu=11680" | python -c "import sys,json; d=json.load(sys.stdin); print(len(d['features']), '개 동')"

# 7) 격자 GeoJSON (동 필터)
curl "http://localhost:9601/api/geo/grids?dong=11680108"

# 8) 월간 구 집계
curl -X POST http://localhost:9601/api/query \
  -H "Content-Type: application/json" \
  -d '{"level":"gu","mode":"month","period":"202506","weekday":"전체","hours":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23],"sex":"전체","ages":[]}'
# 기대: {level,mode,일수,features:[...]} — features 비어있지 않음

# 9) 일 시계열
curl -X POST http://localhost:9601/api/query/day \
  -H "Content-Type: application/json" \
  -d '{"level":"gu","period":"2026-06-05"}'
# 기대: {series:[{시간,code,값}, ...]} 24×25 포인트

# 10) pytest 전체 통과
python -m pytest tests/ -v
```

---

## 6. 운영 메모

| 항목 | 내용 |
|------|------|
| DB 커넥션 | per-request (풀 없음) — 현 단계 스펙. 동시 요청 많으면 커넥션 풀 도입 검토 |
| month 모드 | `마트_월_시간` 사용 (시간·주중주말 컬럼 사전 집계됨, 빠름) |
| trend month 모드 | `마트_월_시간` 단일 코드 필터 + `GROUP BY 연월`. `ix_행정동코드_연월`·`ix_격자코드_연월` 사용 (없으면 풀스캔 ~32초) |
| trend week/day 모드 | `생활인구_250m` 단일 코드 + **최근 날짜창**. `ix_행정동코드_일자`·`ix_250M격자_일자` 복합 인덱스 사용 (없으면 ~30초). week=최근 ~12주(연주), day=recent30+동일요일 |
| week/일간 모드 | `생활인구_250m` 원천 + `달력` 서브쿼리 + `ix_일자` 인덱스 사용 |
| 공휴일 처리 | 달력 테이블의 `주중주말` 컬럼 기준. 공휴일은 `주말`로 분류됨 |
| 일평균 | 합계 ÷ 실제 적재일수 (`달력` ∩ `_적재로그`). 미래 미적재일은 분모에서 제외 |
| GeoJSON 캐시 | `lru_cache` — 프로세스 수명 동안 파일 1회 로드 |
| 연월 캐시 | `마트_월_시간` 연월 목록도 `lru_cache` — DB 1회 조회 후 재사용 |
| CORS | `localhost:9600`, `127.0.0.1:9600` 허용 (프론트 서버) |
