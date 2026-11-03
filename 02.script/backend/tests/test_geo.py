# -*- coding: utf-8 -*-
"""test_geo.py — GeoJSON 라우트 통합 테스트 (실 DB + 실 GeoJSON, FastAPI TestClient).

실행:
  cd 02.script/backend
  python -m pytest tests/test_geo.py -v
"""
import sys
from pathlib import Path

# backend/ 를 sys.path 에 추가 (pytest 실행 위치에 무관하게 import 해결)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

import db
from main import app

client = TestClient(app)

# 테스트용 상수: 마트에 실제 존재하는 강남구(11680) 소속 행정동코드
_TEST_GU = "11680"
_TEST_DONG = "11680510"  # 마트_월_시간에서 확인된 행정동코드


def _yeonwol_params() -> tuple:
    """마트_월_시간 의 모든 연월 tuple (테스트 내 직접 조회용)."""
    rows = db.fetch_all(
        "SELECT DISTINCT `연월` FROM `마트_월_시간` ORDER BY `연월`"
    )
    return tuple(r["연월"] for r in rows)


def _dong_grid_count(dong: str) -> int:
    """특정 행정동의 마트 격자 수를 직접 DB에서 조회 (연월 IN 사용, 과거월 보존)."""
    ym = _yeonwol_params()
    ph = ",".join(["%s"] * len(ym))
    rows = db.fetch_all(
        f"SELECT DISTINCT `격자코드` FROM `마트_월_시간`"
        f" WHERE `연월` IN ({ph}) AND `행정동코드` = %s",
        (*ym, dong),
    )
    return len(rows)


def _gu_grid_count(gu: str) -> int:
    """특정 구 전체의 마트 격자 수를 직접 DB에서 조회 (범위 비교, 과거월 보존)."""
    ym = _yeonwol_params()
    ph = ",".join(["%s"] * len(ym))
    gu_end = str(int(gu) + 1).zfill(5)
    rows = db.fetch_all(
        f"SELECT DISTINCT `격자코드` FROM `마트_월_시간`"
        f" WHERE `연월` IN ({ph}) AND `행정동코드` >= %s AND `행정동코드` < %s",
        (*ym, gu, gu_end),
    )
    return len(rows)


# ── /api/geo/districts ────────────────────────────────────────────────────────
class TestDistricts:
    def test_status_200(self):
        res = client.get("/api/geo/districts")
        assert res.status_code == 200

    def test_type_feature_collection(self):
        body = client.get("/api/geo/districts").json()
        assert body.get("type") == "FeatureCollection"

    def test_exactly_25_features(self):
        body = client.get("/api/geo/districts").json()
        feats = body.get("features", [])
        assert len(feats) == 25, f"시군구 25개 기대, 실제: {len(feats)}"

    def test_each_feature_has_gu_props(self):
        body = client.get("/api/geo/districts").json()
        for feat in body["features"]:
            props = feat.get("properties", {})
            assert "구코드" in props, f"구코드 없음: {props}"
            assert "구명" in props, f"구명 없음: {props}"


# ── /api/geo/dongs ────────────────────────────────────────────────────────────
class TestDongs:
    def test_gu_filter_200(self):
        res = client.get(f"/api/geo/dongs?gu={_TEST_GU}")
        assert res.status_code == 200

    def test_gu_filter_type_feature_collection(self):
        body = client.get(f"/api/geo/dongs?gu={_TEST_GU}").json()
        assert body.get("type") == "FeatureCollection"

    def test_gu_filter_all_features_have_correct_gu(self):
        body = client.get(f"/api/geo/dongs?gu={_TEST_GU}").json()
        feats = body.get("features", [])
        assert len(feats) > 0, f"구 {_TEST_GU}의 동이 0개입니다."
        for feat in feats:
            gu_code = feat["properties"].get("구코드")
            assert gu_code == _TEST_GU, (
                f"구코드 불일치: 기대={_TEST_GU}, 실제={gu_code}"
            )

    def test_no_gu_returns_all_dongs(self):
        """gu 파라미터 없이 호출 시 전체 425개 행정동 반환."""
        body = client.get("/api/geo/dongs").json()
        feats = body.get("features", [])
        assert body.get("type") == "FeatureCollection"
        assert len(feats) == 425, f"전체 행정동 425개 기대, 실제: {len(feats)}"


# ── /api/geo/grids ────────────────────────────────────────────────────────────
class TestGrids:
    def test_dong_param_200(self):
        res = client.get(f"/api/geo/grids?dong={_TEST_DONG}")
        assert res.status_code == 200

    def test_dong_param_type_feature_collection(self):
        body = client.get(f"/api/geo/grids?dong={_TEST_DONG}").json()
        assert body.get("type") == "FeatureCollection"

    def test_dong_param_nonempty_features(self):
        body = client.get(f"/api/geo/grids?dong={_TEST_DONG}").json()
        feats = body.get("features", [])
        assert len(feats) > 0, f"행정동 {_TEST_DONG}의 격자가 0개입니다."

    def test_dong_param_all_codes_in_mart(self):
        """반환된 격자코드가 모두 마트 집합 안에 있어야 한다."""
        db_codes = {
            r["격자코드"].strip()
            for r in db.fetch_all(
                "SELECT DISTINCT `격자코드` FROM `마트_월_시간` WHERE `행정동코드` = %s",
                (_TEST_DONG,),
            )
        }
        body = client.get(f"/api/geo/grids?dong={_TEST_DONG}").json()
        for feat in body["features"]:
            code = feat["properties"].get("격자코드", "").strip()
            assert code in db_codes, f"마트에 없는 격자코드: {code}"

    def test_gu_param_200(self):
        res = client.get(f"/api/geo/grids?gu={_TEST_GU}")
        assert res.status_code == 200

    def test_gu_param_type_feature_collection(self):
        body = client.get(f"/api/geo/grids?gu={_TEST_GU}").json()
        assert body.get("type") == "FeatureCollection"

    def test_gu_param_more_grids_than_single_dong(self):
        """구 전체 격자 수 > 단일 행정동 격자 수."""
        dong_body = client.get(f"/api/geo/grids?dong={_TEST_DONG}").json()
        gu_body = client.get(f"/api/geo/grids?gu={_TEST_GU}").json()
        dong_count = len(dong_body.get("features", []))
        gu_count = len(gu_body.get("features", []))
        assert gu_count > dong_count, (
            f"구({gu_count}) > 동({dong_count}) 기대"
        )
        assert gu_count > 0, "구 전체 격자가 0개입니다."

    def test_neither_param_returns_400(self):
        """dong/gu 모두 없으면 400."""
        res = client.get("/api/geo/grids")
        assert res.status_code == 400, (
            f"파라미터 없을 때 400 기대, 실제: {res.status_code}"
        )

    def test_dong_takes_priority_over_gu(self):
        """dong+gu 동시 지정 시 dong 우선 — dong 단독 결과와 동일해야 한다."""
        body_dong = client.get(f"/api/geo/grids?dong={_TEST_DONG}").json()
        body_both = client.get(f"/api/geo/grids?dong={_TEST_DONG}&gu={_TEST_GU}").json()
        codes_dong = {f["properties"]["격자코드"] for f in body_dong["features"]}
        codes_both = {f["properties"]["격자코드"] for f in body_both["features"]}
        assert codes_dong == codes_both, "dong 우선 규칙 불일치"

    def test_dong_empty_string_returns_400(self):
        """dong= 빈 문자열이면 400."""
        res = client.get("/api/geo/grids?dong=")
        assert res.status_code == 400, (
            f"빈 dong 파라미터는 400 기대, 실제: {res.status_code}"
        )

    def test_gu_empty_string_returns_400(self):
        """gu= 빈 문자열이면 400."""
        res = client.get("/api/geo/grids?gu=")
        assert res.status_code == 400, (
            f"빈 gu 파라미터는 400 기대, 실제: {res.status_code}"
        )

    def test_grids_nonnumeric_gu_returns_400(self):
        """gu=abc (비숫자) 이면 400 (ValueError → unhandled 500 이 아님)."""
        res = client.get("/api/geo/grids?gu=abc")
        assert res.status_code == 400, (
            f"비숫자 gu 는 400 기대, 실제: {res.status_code} / {res.text}"
        )
