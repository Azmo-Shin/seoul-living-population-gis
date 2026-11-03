# -*- coding: utf-8 -*-
"""api/routes_query.py — 생활인구 집계 쿼리 HTTP 라우트.

단일 책임: QueryRequest/DayRequest 를 받아 query_builder + metrics 로 SQL 을
구성하고 DB 를 조회한 뒤 QueryResponse/DayResponse 를 반환한다.
DB·SQL·집계 로직은 하위 레이어(services/)에 위임한다.
"""
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException

import db
from services.metrics import metric_expr
from services.query_builder import (
    build_day_sql,
    build_grid_breakdown_sql,
    build_month_sql,
    build_trend_all_gu_sql,
    build_trend_day_sql,
    build_trend_same_weekday_sql,
    build_trend_sql,
    build_trend_week_sql,
    build_week_sql,
    day_count_sql,
    trend_day_count_sql,
    week_trend_day_count_sql,
)
from api.schemas import (
    AllGuTrendRequest,
    AllGuTrendResponse,
    AllGuTrendRow,
    DayPoint,
    DayRequest,
    DayResponse,
    GridBreakdownRequest,
    GridBreakdownResponse,
    GridDongPortion,
    QueryFeature,
    QueryRequest,
    QueryResponse,
    TrendDayPoint,
    TrendPoint,
    TrendRequest,
    TrendResponse,
)

# ── 추이 날짜창 상수 ──────────────────────────────────────────────────────────
# 성능: raw(생활인구_250m, 수억 행)는 반드시 최근 날짜창 + 단일 코드로 좁혀야
# ix_일자/복합인덱스 레인지 스캔을 탄다. 창을 넉넉히 잡되(주=~13주, 일=~31/13주)
# 응답 단계에서 최신 N개만 자른다.
_WEEK_TREND_DAYS = 13 * 7      # 주 추이: 최근 ~13주 날짜창 → 최신 12주 사용
_WEEK_TREND_KEEP = 12          # 반환할 최신 주 개수
_DAY_RECENT_DAYS = 31         # 일 recent30: 최근 ~31일 날짜창
_SAME_WEEKDAY_DAYS = 12 * 7   # 동일요일: 최근 ~12주 날짜창

router = APIRouter(prefix="/api", tags=["query"])


# ── POST /api/query — 월/주 공간 집계 ────────────────────────────────────────
@router.post("/query", response_model=QueryResponse)
def query_aggregate(req: QueryRequest) -> QueryResponse:
    """월 또는 주 단위 공간 집계.

    - month : 마트_월_시간 (빠름, 시간·주중주말 필터 지원).
    - week  : 생활인구_250m + 달력 서브쿼리 (파티션 프루닝).
    - 일평균 = 합계 ÷ 실제 적재일수 (달력 ∩ _적재로그).
    """
    try:
        metric = metric_expr(req.sex, req.ages)

        if req.mode == "month":
            sql, params = build_month_sql(
                req.level, req.period, req.gu, req.dong,
                req.hours, req.weekday, metric,
            )
        else:  # week
            sql, params = build_week_sql(
                req.level, req.period, req.gu, req.dong,
                req.hours, req.weekday, metric,
            )

        rows = db.fetch_all(sql, params)

        # 일수 조회 (일평균 분모)
        dc_sql, dc_params = day_count_sql(req.mode, req.period, req.weekday)
        일수_val: int | None = None
        if dc_sql is not None:
            dc_row = db.fetch_one(dc_sql, dc_params)
            if dc_row is not None and dc_row["일수"] is not None:
                일수_val = int(dc_row["일수"])

        # 피처 목록 구성
        features: list[QueryFeature] = []
        for r in rows:
            합계 = float(r["합계"])
            일평균 = (
                round(합계 / 일수_val, 2)
                if 일수_val and 일수_val > 0
                else None
            )
            # grid level 일 때만 행정동코드 컬럼이 존재한다 (없으면 None).
            동코드_raw = r.get("행정동코드")
            동코드 = (
                str(동코드_raw).strip() if 동코드_raw is not None else None
            )
            features.append(
                QueryFeature(
                    code=str(r["code"]).strip(),
                    합계=합계,
                    일평균=일평균,
                    행정동코드=동코드,
                )
            )

        return QueryResponse(
            level=req.level,
            mode=req.mode,
            일수=일수_val,
            features=features,
        )

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── POST /api/query/grid_breakdown — A-2 격자 경계셀 동별 분해 ────────────────
@router.post("/query/grid_breakdown", response_model=GridBreakdownResponse)
def query_grid_breakdown(req: GridBreakdownRequest) -> GridBreakdownResponse:
    """구 전체(A-2) 격자 뷰의 경계셀을 동별 portion 으로 분해 (month|week).

    채색/값은 메인 격자 쿼리(/api/query)가 이미 구 안 합계로 처리한다. 이 엔드포인트는
    한 격자가 구 안 여러 행정동에 걸칠 때의 **행정동별 portion**을 부가로 돌려줘,
    프론트 툴팁이 "총합 + 동별 분해"를 표시하게 한다(일수는 메인 쿼리와 동일 분모).
    """
    try:
        metric = metric_expr(req.sex, req.ages)
        sql, params = build_grid_breakdown_sql(
            req.mode, req.period, req.gu, req.hours, req.weekday, metric,
        )
        rows = db.fetch_all(sql, params)

        dc_sql, dc_params = day_count_sql(req.mode, req.period, req.weekday)
        일수_val: int | None = None
        if dc_sql is not None:
            dc_row = db.fetch_one(dc_sql, dc_params)
            if dc_row is not None and dc_row["일수"] is not None:
                일수_val = int(dc_row["일수"])

        items = [
            GridDongPortion(
                격자코드=str(r["격자코드"]).strip(),
                행정동코드=str(r["행정동코드"]).strip(),
                합계=float(r["합계"]),
            )
            for r in rows
        ]
        return GridBreakdownResponse(mode=req.mode, 일수=일수_val, items=items)

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── POST /api/query/day — 일 시간별 시계열 ───────────────────────────────────
@router.post("/query/day", response_model=DayResponse)
def query_day(req: DayRequest) -> DayResponse:
    """단일 날짜의 시간별(0~23시) 공간 집계 시계열.

    일평균·주중주말·시간 필터 없음 — 하루 전체 24시간 고정.
    """
    try:
        metric = metric_expr(req.sex, req.ages)
        sql, params = build_day_sql(
            req.level, req.period, req.gu, req.dong, metric,
        )
        rows = db.fetch_all(sql, params)

        series: list[DayPoint] = [
            DayPoint(
                시간=int(r["시간"]),
                code=str(r["code"]).strip(),
                값=float(r["합계"]),
            )
            for r in rows
        ]

        return DayResponse(level=req.level, series=series)

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── 추이 공용 헬퍼 ───────────────────────────────────────────────────────────
def _latest_loaded() -> tuple[date, int]:
    """최신 적재일(_적재로그 MAX(일자))과 그 요일(달력.요일 정수)을 반환.

    week/day 추이의 '최근 N' 기준점. 적재 로그가 비면 503.
    """
    span = db.fetch_one("SELECT MAX(`일자`) AS d FROM `_적재로그`")
    if span is None or span["d"] is None:
        raise HTTPException(status_code=503, detail="적재 로그에 데이터가 없습니다.")
    d1 = span["d"]
    cal = db.fetch_one("SELECT `요일` FROM `달력` WHERE `일자` = %s", (d1,))
    if cal is None or cal["요일"] is None:
        raise HTTPException(
            status_code=503, detail=f"달력에서 요일을 찾을 수 없습니다: {d1}"
        )
    return d1, int(cal["요일"])


def _day_points(rows: list[dict]) -> list[TrendDayPoint]:
    """raw 일별 추이 행({일자, 합계})을 TrendDayPoint 리스트로 변환 (일자 오름차순)."""
    pts: list[TrendDayPoint] = []
    for r in rows:
        일자 = r["일자"]
        일자_s = 일자.isoformat() if hasattr(일자, "isoformat") else str(일자)
        pts.append(TrendDayPoint(일자=일자_s, 합계=float(r["합계"])))
    return pts


# ── POST /api/query/trend — 단일 영역 추이 (월/주/일 모드) ────────────────────
@router.post("/query/trend", response_model=TrendResponse)
def query_trend(req: TrendRequest) -> TrendResponse:
    """단일 영역(구/동/격자)의 추이. mode 로 시간축을 선택한다.

    - month : 마트_월_시간(빠름) 연월별 합계 + 일수 (전체 기간). 기본값.
    - week  : 생활인구_250m+달력 연주별 합계 + 일수 (최근 ~12주).
    - day   : 생활인구_250m 일자별 합계 두 계열
              (recent30 = 최근 ~30 적재일, sameWeekday = 최신일과 동일 요일).

    month/week 는 일수를 함께 줘 프론트가 평균 = 합계 ÷ (일수 × 시간수) 로 그린다.
    day 는 일수=1(하루) 이므로 평균 = 합계 ÷ (1 × 시간수).
    raw 경로(week/day)는 반드시 최근 날짜창 + 단일 코드로 좁혀 인덱스를 탄다.
    """
    try:
        metric = metric_expr(req.sex, req.ages)
        code = req.code.strip()

        if req.mode == "month":
            return _trend_month(req, code, metric)
        if req.mode == "week":
            return _trend_week(req, code, metric)
        return _trend_day(req, code, metric)  # day

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _trend_month(req: TrendRequest, code: str, metric: str) -> TrendResponse:
    """월 추이 (마트_월_시간) — 연월별 합계 + 일수. 기존 동작과 동일."""
    sql, params = build_trend_sql(req.level, code, req.hours, req.weekday, metric)
    rows = db.fetch_all(sql, params)

    # 연월별 일수 맵 (한 번 조회 후 매핑)
    dc_sql, dc_params = trend_day_count_sql(req.weekday)
    dc_rows = db.fetch_all(dc_sql, dc_params)
    일수_map: dict[str, int] = {
        str(d["연월"]).strip(): int(d["일수"])
        for d in dc_rows
        if d["일수"] is not None
    }

    points: list[TrendPoint] = []
    for r in rows:
        라벨 = str(r["연월"]).strip()
        points.append(
            TrendPoint(라벨=라벨, 합계=float(r["합계"]), 일수=일수_map.get(라벨))
        )

    return TrendResponse(level=req.level, code=code, mode="month", points=points)


def _trend_week(req: TrendRequest, code: str, metric: str) -> TrendResponse:
    """주 추이 (생활인구_250m+달력) — 최근 ~12주 연주별 합계 + 일수."""
    d1, _ = _latest_loaded()
    d0 = d1 - timedelta(days=_WEEK_TREND_DAYS)
    d0_s, d1_s = d0.isoformat(), d1.isoformat()

    sql, params = build_trend_week_sql(
        req.level, code, d0_s, d1_s, req.hours, req.weekday, metric,
    )
    rows = db.fetch_all(sql, params)

    # 연주별 일수(실제 적재일수) — 같은 날짜창 ∩ _적재로그, 주중주말 필터 동일 적용.
    dc_sql, dc_params = week_trend_day_count_sql(d0_s, d1_s, req.weekday)
    dc_rows = db.fetch_all(dc_sql, dc_params)
    일수_map: dict[str, int] = {
        str(d["연주"]).strip(): int(d["일수"])
        for d in dc_rows
        if d["일수"] is not None
    }

    points = [
        TrendPoint(
            라벨=str(r["연주"]).strip(),
            합계=float(r["합계"]),
            일수=일수_map.get(str(r["연주"]).strip()),
        )
        for r in rows
    ]
    # 최신 ~12주만 (연주 오름차순 유지)
    points = points[-_WEEK_TREND_KEEP:]

    return TrendResponse(level=req.level, code=code, mode="week", points=points)


def _trend_day(req: TrendRequest, code: str, metric: str) -> TrendResponse:
    """일 추이 (생활인구_250m) — recent30 + sameWeekday 두 계열.

    recent30 : [d1-~30일, d1] 일자별 합계 (weekday 필터 반영).
    sameWeekday : [d1-~12주, d1] 중 d1 과 같은 요일 일자별 합계.
    """
    d1, yoil = _latest_loaded()

    # recent30 — 최근 ~31일 날짜창
    r0 = (d1 - timedelta(days=_DAY_RECENT_DAYS - 1)).isoformat()
    r_sql, r_params = build_trend_day_sql(
        req.level, code, r0, d1.isoformat(), req.hours, req.weekday, metric,
    )
    recent30 = _day_points(db.fetch_all(r_sql, r_params))

    # sameWeekday — 최근 ~12주, 같은 요일만
    s0 = (d1 - timedelta(days=_SAME_WEEKDAY_DAYS)).isoformat()
    s_sql, s_params = build_trend_same_weekday_sql(
        req.level, code, s0, d1.isoformat(), yoil, req.hours, metric,
    )
    sameWeekday = _day_points(db.fetch_all(s_sql, s_params))

    return TrendResponse(
        level=req.level,
        code=code,
        mode="day",
        recent30=recent30,
        sameWeekday=sameWeekday,
    )


# ── POST /api/query/trend_all_gu — 전체 구 추이 (구별 비교 라인) ───────────────
@router.post("/query/trend_all_gu", response_model=AllGuTrendResponse)
def query_trend_all_gu(req: AllGuTrendRequest) -> AllGuTrendResponse:
    """25개 자치구의 추이를 한 번에 — 현재 모드/필터 반영(구별 비교 라인차트용).

    - month : 마트 전체 연월 (빠름). week : 최근 ~12주. day : 최근 ~30일.
    프론트 평균 = 합계 ÷ (일수 × 시간수); day 는 일수=1.
    """
    try:
        metric = metric_expr(req.sex, req.ages)
        일수_map: dict[str, int] = {}

        if req.mode == "month":
            sql, params = build_trend_all_gu_sql(
                "month", None, None, req.hours, req.weekday, metric
            )
            for d in db.fetch_all(*trend_day_count_sql(req.weekday)):
                if d["일수"] is not None:
                    일수_map[str(d["연월"]).strip()] = int(d["일수"])
        elif req.mode == "week":
            d1, _ = _latest_loaded()
            d0s = (d1 - timedelta(days=_WEEK_TREND_DAYS)).isoformat()
            d1s = d1.isoformat()
            sql, params = build_trend_all_gu_sql(
                "week", d0s, d1s, req.hours, req.weekday, metric
            )
            for d in db.fetch_all(*week_trend_day_count_sql(d0s, d1s, req.weekday)):
                if d["일수"] is not None:
                    일수_map[str(d["연주"]).strip()] = int(d["일수"])
        else:  # day — 최근 ~30일, 일수=1/일 (일수_map 비움)
            d1, _ = _latest_loaded()
            d0s = (d1 - timedelta(days=_DAY_RECENT_DAYS - 1)).isoformat()
            sql, params = build_trend_all_gu_sql(
                "day", d0s, d1.isoformat(), req.hours, req.weekday, metric
            )

        rows = [
            AllGuTrendRow(
                구=str(r["구"]).strip(),
                라벨=str(r["라벨"]).strip(),
                합계=float(r["합계"]),
            )
            for r in db.fetch_all(sql, params)
        ]
        return AllGuTrendResponse(mode=req.mode, 일수=일수_map, rows=rows)

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
