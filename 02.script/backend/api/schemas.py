# -*- coding: utf-8 -*-
"""api/schemas.py — 쿼리 엔드포인트 Pydantic v2 스키마.

단일 책임: 요청/응답 모델 정의. HTTP·DB 의존 없음.
"""
from typing import Literal

from pydantic import BaseModel, Field


# ── 공통 집계 요청 (월/주) ────────────────────────────────────────────────────
class QueryRequest(BaseModel):
    level: Literal["gu", "dong", "grid"]
    mode: Literal["month", "week"]          # day 는 별도 엔드포인트
    period: str                              # month:'YYYYMM' | week:'YYYY-WW'
    gu: str | None = None
    dong: str | None = None
    hours: list[int] = Field(default_factory=lambda: list(range(24)))
    weekday: Literal["전체", "주중", "주말"] = "전체"
    sex: Literal["전체", "남", "여"] = "전체"
    ages: list[str] = Field(default_factory=list)


# ── 공간 단위 집계 결과 한 행 ─────────────────────────────────────────────────
class QueryFeature(BaseModel):
    code: str
    합계: float
    일평균: float | None = None
    # grid level 일 때만 채워진다 (해당 격자가 속한 행정동코드). gu/dong 은 None.
    행정동코드: str | None = None


# ── 공통 집계 응답 ────────────────────────────────────────────────────────────
class QueryResponse(BaseModel):
    level: str
    mode: str
    일수: int | None = None
    features: list[QueryFeature]


# ── 격자 동별 분해 요청 (A-2 구 격자 경계셀 → 동별 portion) ─────────────────────
class GridBreakdownRequest(BaseModel):
    gu: str                                  # 구코드 (A-2 격자 뷰는 항상 gu 스코프)
    mode: Literal["month", "week"]           # day 는 분해 미지원(별도)
    period: str                              # month:'YYYYMM' | week:'YYYY-WW'
    hours: list[int] = Field(default_factory=lambda: list(range(24)))
    weekday: Literal["전체", "주중", "주말"] = "전체"
    sex: Literal["전체", "남", "여"] = "전체"
    ages: list[str] = Field(default_factory=list)


# ── 격자×행정동 portion 한 행 ─────────────────────────────────────────────────
class GridDongPortion(BaseModel):
    격자코드: str
    행정동코드: str
    합계: float                               # 프론트 평균 = 합계 ÷ (일수 × 시간수)


# ── 격자 동별 분해 응답 ───────────────────────────────────────────────────────
class GridBreakdownResponse(BaseModel):
    level: str = "grid"
    mode: str
    일수: int | None = None
    items: list[GridDongPortion]


# ── 일 시계열 요청 ────────────────────────────────────────────────────────────
class DayRequest(BaseModel):
    level: Literal["gu", "dong", "grid"]
    period: str                              # 'YYYY-MM-DD'
    gu: str | None = None
    dong: str | None = None
    sex: Literal["전체", "남", "여"] = "전체"
    ages: list[str] = Field(default_factory=list)


# ── 일 시계열 결과 한 점 ──────────────────────────────────────────────────────
class DayPoint(BaseModel):
    시간: int
    code: str
    값: float


# ── 일 시계열 응답 ────────────────────────────────────────────────────────────
class DayResponse(BaseModel):
    level: str
    mode: str = "day"
    series: list[DayPoint]


# ── 추이 요청 (단일 영역, 모드별) ─────────────────────────────────────────────
class TrendRequest(BaseModel):
    level: Literal["gu", "dong", "grid"]
    code: str                                # 구코드 / 행정동코드 / 격자코드 (level 별)
    # 추이 시간축 모드:
    #   month → 마트_월_시간 연월별 (기본, 빠름, 전체 기간)
    #   week  → 생활인구_250m+달력 연주별 (최근 ~12주)
    #   day   → 생활인구_250m 일자별 (최근30일 + 동일요일 두 계열)
    mode: Literal["month", "week", "day"] = "month"
    hours: list[int] = Field(default_factory=lambda: list(range(24)))
    weekday: Literal["전체", "주중", "주말"] = "전체"
    sex: Literal["전체", "남", "여"] = "전체"
    ages: list[str] = Field(default_factory=list)


# ── 추이 한 점 (month/week 공용) ──────────────────────────────────────────────
class TrendPoint(BaseModel):
    라벨: str                                # month: "YYYYMM" | week: "YYYY-WW" (연주)
    합계: float
    일수: int | None = None                   # 해당 기간의 실제 적재일수 (분모)


# ── 일 추이 한 점 (day 모드) ──────────────────────────────────────────────────
class TrendDayPoint(BaseModel):
    일자: str                                # "YYYY-MM-DD"
    합계: float
    # 일수=1 (하루) 고정 — 프론트 평균 = 합계 / (1 × 시간수). 별도 필드 불필요.


# ── 추이 응답 (모드별) ────────────────────────────────────────────────────────
class TrendResponse(BaseModel):
    level: str
    code: str
    mode: str = "month"
    # month/week: 라벨별 합계+일수 (라벨 오름차순). day 모드면 None.
    # 프론트가 평균 = 합계 / (일수 × 시간수) 로 계산.
    points: list[TrendPoint] | None = None
    # day 모드 전용 — 최근 ~30 적재일 일별 합계 (일자 오름차순). 그 외 None.
    recent30: list[TrendDayPoint] | None = None
    # day 모드 전용 — 최신 적재일과 같은 요일의 최근 ~8~12주 일별 합계 (일자 오름차순).
    sameWeekday: list[TrendDayPoint] | None = None


# ── 전체 구 추이 요청 (25개 자치구를 한 번에) ──────────────────────────────────
class AllGuTrendRequest(BaseModel):
    mode: Literal["month", "week", "day"] = "month"
    hours: list[int] = Field(default_factory=lambda: list(range(24)))
    weekday: Literal["전체", "주중", "주말"] = "전체"
    sex: Literal["전체", "남", "여"] = "전체"
    ages: list[str] = Field(default_factory=list)


# ── 전체 구 추이 한 행 (구 × 라벨) ────────────────────────────────────────────
class AllGuTrendRow(BaseModel):
    구: str                                   # 구코드 (5자리)
    라벨: str                                 # month:연월 | week:연주 | day:일자
    합계: float                               # 프론트 평균 = 합계 ÷ (일수 × 시간수)


# ── 전체 구 추이 응답 ─────────────────────────────────────────────────────────
class AllGuTrendResponse(BaseModel):
    mode: str
    일수: dict[str, int]                      # 라벨 → 일수 (day 모드면 {} → 프론트 1 처리)
    rows: list[AllGuTrendRow]
