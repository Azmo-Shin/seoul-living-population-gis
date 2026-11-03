# -*- coding: utf-8 -*-
"""routes_geo.py — GeoJSON 지리 데이터 API (구/동/격자).

단일 책임: 시군구·행정동·격자 GeoJSON FeatureCollection 서빙.
- 파일은 모듈 로드 시 1회 읽고 메모리에 보유 (per-request 디스크 I/O 없음).
- /api/geo prefix 는 main.py 에서 라우터 등록 시 지정.
"""
import json
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

import db
from config import SPATIAL_DIR
from services.query_builder import _gu_end


# ──────────────────────────────────────────────────────────────────────────────
# 마트 연월 캐시 (첫 호출 시 1회 조회, 이후 재사용)
# ──────────────────────────────────────────────────────────────────────────────

@lru_cache(maxsize=None)
def _all_yeonwol() -> tuple:
    """마트_월_시간 에 존재하는 모든 연월을 정렬된 tuple 로 반환.

    lru_cache 로 프로세스 수명 동안 1회만 DB를 조회한다.
    연월 IN (...) 조건을 함께 쓰면 MySQL 이 PK 앞 컬럼(연월)으로
    좁은 범위 스캔을 하므로 full-scan 을 피할 수 있다.
    """
    rows = db.fetch_all(
        "SELECT DISTINCT `연월` FROM `마트_월_시간` ORDER BY `연월`"
    )
    return tuple(r["연월"] for r in rows)


# ──────────────────────────────────────────────────────────────────────────────
# GeoJSON 파일 캐시 (모듈 초기화 시 1회 로드)
# ──────────────────────────────────────────────────────────────────────────────

@lru_cache(maxsize=None)
def _load_geojson(filename: str) -> dict:
    """GeoJSON 파일을 읽어 dict 로 반환한다. lru_cache 로 1회만 로드."""
    path: Path = SPATIAL_DIR / filename
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _get_districts_data() -> dict:
    return _load_geojson("시군구.geojson")


def _get_dongs_data() -> dict:
    return _load_geojson("행정동.geojson")


def _get_grids_data() -> dict:
    return _load_geojson("격자.geojson")


router = APIRouter(prefix="/api/geo", tags=["geo"])


# ──────────────────────────────────────────────────────────────────────────────
# 1. GET /api/geo/districts — 25개 자치구 FeatureCollection
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/districts")
def get_districts() -> dict:
    """서울 25개 자치구 GeoJSON FeatureCollection."""
    data = _get_districts_data()
    return {"type": "FeatureCollection", "features": list(data["features"])}


# ──────────────────────────────────────────────────────────────────────────────
# 2. GET /api/geo/dongs?gu=<구코드 optional> — 행정동 FeatureCollection
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/dongs")
def get_dongs(
    gu: str | None = Query(default=None, description="자치구 코드 (5자리). 생략 시 전체 425개 반환."),
) -> dict:
    """행정동 GeoJSON FeatureCollection.

    - gu 파라미터 지정 시: 해당 구 소속 행정동만 반환.
    - gu 생략 시: 전체 행정동(425개) 반환.
    """
    all_data = _get_dongs_data()

    if gu is None:
        return {"type": "FeatureCollection", "features": list(all_data["features"])}

    gu = gu.strip()
    if not gu:
        raise HTTPException(status_code=400, detail="gu 파라미터가 비어 있습니다.")

    filtered = [
        feat for feat in all_data["features"]
        if feat["properties"].get("구코드") == gu
    ]
    return {"type": "FeatureCollection", "features": filtered}


# ──────────────────────────────────────────────────────────────────────────────
# 3. GET /api/geo/grids?dong=<행정동코드> OR ?gu=<구코드> — 격자 FeatureCollection
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/grids")
def get_grids(
    dong: str | None = Query(default=None, description="행정동코드 (8자리). dong 우선."),
    gu: str | None = Query(default=None, description="자치구 코드 (5자리). dong 없을 때 사용."),
) -> dict:
    """격자 GeoJSON FeatureCollection.

    - dong 지정 시: 해당 행정동 소속 격자코드를 마트에서 조회 후 필터링.
    - gu 지정 시 (dong 없을 때): 구 전체(A-2) 격자코드를 마트에서 조회 후 필터링.
    - 둘 다 없으면 400.
    - 둘 다 있으면 dong 우선.
    """
    if dong is None and gu is None:
        raise HTTPException(
            status_code=400,
            detail="dong 또는 gu 파라미터 중 하나는 필수입니다.",
        )

    # 모든 연월 목록 (캐시) — PK 앞 컬럼(연월)을 IN 조건으로 고정해
    # MySQL 이 좁은 PK 범위 스캔을 수행하도록 유도한다.
    ym = _all_yeonwol()
    if not ym:
        raise HTTPException(status_code=503, detail="마트 데이터가 없습니다.")
    ph = ",".join(["%s"] * len(ym))

    if dong is not None:
        # dong 우선
        dong = dong.strip()
        if not dong:
            raise HTTPException(status_code=400, detail="dong 파라미터가 비어 있습니다.")
        rows = db.fetch_all(
            f"SELECT DISTINCT `격자코드` FROM `마트_월_시간`"
            f" WHERE `연월` IN ({ph}) AND `행정동코드` = %s",
            (*ym, dong),
        )
    else:
        # gu only — LEFT(행정동코드,5)=%s 는 SARGable 하지 않으므로
        # 8자리 행정동코드 범위 비교(>=, <)로 대체한다.
        gu = gu.strip()
        if not gu:
            raise HTTPException(status_code=400, detail="gu 파라미터가 비어 있습니다.")
        try:
            gu_end = _gu_end(gu)
        except ValueError:
            raise HTTPException(status_code=400, detail="gu 는 숫자 5자리 코드여야 합니다.")
        rows = db.fetch_all(
            f"SELECT DISTINCT `격자코드` FROM `마트_월_시간`"
            f" WHERE `연월` IN ({ph}) AND `행정동코드` >= %s AND `행정동코드` < %s",
            (*ym, gu, gu_end),
        )

    code_set: set[str] = {r["격자코드"].strip() for r in rows}

    all_grids = _get_grids_data()
    filtered = [
        feat for feat in all_grids["features"]
        if feat["properties"].get("격자코드", "").strip() in code_set
    ]
    return {"type": "FeatureCollection", "features": filtered}
