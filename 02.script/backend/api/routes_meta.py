# -*- coding: utf-8 -*-
"""routes_meta.py — 메타 정보 API (구/동 목록, 가용 기간).

단일 책임: 구·동 공간 목록과 데이터 가용 기간 조회.
prefix=/api/meta 는 main.py 에서 라우터 등록 시 지정.
"""
from fastapi import APIRouter, HTTPException, Query

import db

router = APIRouter(prefix="/api/meta", tags=["meta"])


# ── 1. 자치구 목록 ──────────────────────────────────────────────────────────────
@router.get("/districts")
def get_districts() -> list[dict]:
    """서울 25개 자치구 코드/명 목록."""
    return db.fetch_all(
        "SELECT `구코드`, `구명` FROM `공간_시군구` ORDER BY `구코드`"
    )


# ── 2. 행정동 목록 (구 필터 필수) ───────────────────────────────────────────────
@router.get("/dongs")
def get_dongs(
    gu: str = Query(..., description="자치구 코드 (5자리)", min_length=1),
) -> list[dict]:
    """특정 구에 속한 행정동 코드/명 목록.

    - gu: 5자리 구코드 (예: 11680 = 강남구). 필수 파라미터.
    """
    gu = gu.strip()
    if not gu:
        raise HTTPException(status_code=400, detail="gu 파라미터가 비어 있습니다.")

    return db.fetch_all(
        "SELECT `행정동코드`, `행정동명` FROM `공간_행정동` "
        "WHERE `구코드` = %s ORDER BY `행정동코드`",
        (gu,),
    )


# ── 3. 가용 기간 범위 ────────────────────────────────────────────────────────────
@router.get("/range")
def get_range() -> dict:
    """데이터 가용 기간 범위.

    일/주 범위는 `_적재로그` 실제 적재 일자 기준 (달력 테이블은 미래 포함으로 사용 안 함).
    월 범위도 동일 기준으로 파생.

    반환 예시::

        {
          "day":   {"min": "2023-01-01", "max": "2025-12-31"},
          "month": {"min": "2023-01",    "max": "2025-12"},
          "week":  {"min": "2023-W01",   "max": "2025-W52"}
        }
    """
    # 실제 적재된 최소/최대 일자
    span = db.fetch_one(
        "SELECT MIN(`일자`) AS d0, MAX(`일자`) AS d1 FROM `_적재로그`"
    )
    if span is None or span["d0"] is None or span["d1"] is None:
        raise HTTPException(status_code=503, detail="적재 로그에 데이터가 없습니다.")

    d0 = span["d0"]  # datetime.date 객체
    d1 = span["d1"]

    # 달력 테이블에서 연주(주 레이블) 조회
    row0 = db.fetch_one(
        "SELECT `연주` FROM `달력` WHERE `일자` = %s", (d0,)
    )
    row1 = db.fetch_one(
        "SELECT `연주` FROM `달력` WHERE `일자` = %s", (d1,)
    )
    if row0 is None or row1 is None:
        raise HTTPException(
            status_code=503,
            detail=f"달력 테이블에서 연주를 찾을 수 없습니다: d0={d0}, d1={d1}",
        )

    # 날짜를 ISO 문자열로 변환 (datetime.date → str)
    d0_str = d0.isoformat() if hasattr(d0, "isoformat") else str(d0)
    d1_str = d1.isoformat() if hasattr(d1, "isoformat") else str(d1)

    # 월: "YYYY-MM" 형식
    month_min = d0_str[:7]
    month_max = d1_str[:7]

    return {
        "day":   {"min": d0_str,          "max": d1_str},
        "month": {"min": month_min,        "max": month_max},
        "week":  {"min": row0["연주"],     "max": row1["연주"]},
    }
