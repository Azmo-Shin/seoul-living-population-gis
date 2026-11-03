# -*- coding: utf-8 -*-
"""test_query.py — /api/query + /api/query/day 통합 테스트 (실 DB, TestClient).

라이브 DB 사실 (2026-06-12 기준):
  - MAX(_적재로그.일자) = 2026-06-05 → 연주 '2026-23'
  - 202506 적재일수: 전체 30, 주중 20.
  - 강남구 코드 11680.

실행:
  cd 02.script/backend
  python -m pytest tests/test_query.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

# ── 테스트 상수 ────────────────────────────────────────────────────────────────
YEONWOL = "202506"          # 2025년 6월 (30일 전부 적재)
YEONJU = "2026-23"          # 실제 적재 범위 내 최근 연주
LOADED_DAY = "2026-06-05"   # MAX(_적재로그.일자)
GU_GANGNAM = "11680"        # 강남구


# ══════════════════════════════════════════════════════════════════════════════
# 1. 월 · 구 레벨
# ══════════════════════════════════════════════════════════════════════════════
class TestMonthGu:
    BODY = {
        "level": "gu",
        "mode": "month",
        "period": YEONWOL,
        "weekday": "주중",
        "hours": list(range(6, 23)),
    }

    def _post(self, body=None):
        return client.post("/api/query", json=body or self.BODY)

    def test_status_200(self):
        assert self._post().status_code == 200

    def test_25_features(self):
        data = self._post().json()
        assert len(data["features"]) == 25, (
            f"서울 25개 구 기대, 실제 {len(data['features'])}"
        )

    def test_each_feature_has_required_fields(self):
        features = self._post().json()["features"]
        for f in features:
            assert "code" in f
            assert "합계" in f
            assert "일평균" in f

    def test_code_is_5_digit(self):
        features = self._post().json()["features"]
        for f in features:
            assert len(f["code"]) == 5, f"구코드 5자리 기대: {f['code']}"

    def test_합계_positive(self):
        features = self._post().json()["features"]
        for f in features:
            assert f["합계"] > 0, f"합계>0 기대: {f}"

    def test_일평균_present_and_positive(self):
        features = self._post().json()["features"]
        for f in features:
            assert f["일평균"] is not None, f"일평균 None: {f}"
            assert f["일평균"] > 0, f"일평균>0 기대: {f}"

    def test_일수_positive(self):
        data = self._post().json()
        assert data["일수"] is not None and data["일수"] > 0, (
            f"일수>0 기대, 실제: {data['일수']}"
        )

    def test_일평균_approx_합계_div_일수(self):
        """일평균 ≈ 합계 ÷ 일수 (반올림 오차 허용 0.02)."""
        data = self._post().json()
        일수 = data["일수"]
        assert 일수 and 일수 > 0
        for f in data["features"]:
            expected = round(f["합계"] / 일수, 2)
            assert abs(f["일평균"] - expected) < 0.02, (
                f"일평균 불일치: got={f['일평균']}, expected={expected}"
            )

    def test_gangnam_in_top_features(self):
        """강남구(11680)가 합계 상위권에 있어야 한다."""
        features = self._post().json()["features"]
        sorted_f = sorted(features, key=lambda x: x["합계"], reverse=True)
        top_codes = [f["code"] for f in sorted_f[:5]]
        assert GU_GANGNAM in top_codes, (
            f"강남 {GU_GANGNAM} 이 상위 5위 안에 없습니다: {top_codes}"
        )


# ══════════════════════════════════════════════════════════════════════════════
# 2. 월 · 동 레벨 (구 스코프)
# ══════════════════════════════════════════════════════════════════════════════
class TestMonthDong:
    BODY = {
        "level": "dong",
        "mode": "month",
        "period": YEONWOL,
        "gu": GU_GANGNAM,
    }

    def test_status_200(self):
        res = client.post("/api/query", json=self.BODY)
        assert res.status_code == 200

    def test_all_codes_start_with_gangnam(self):
        features = client.post("/api/query", json=self.BODY).json()["features"]
        assert len(features) > 0, "강남 동 피처가 없습니다"
        for f in features:
            assert f["code"].startswith(GU_GANGNAM), (
                f"강남 외 동 발견: {f['code']}"
            )

    def test_합계_positive(self):
        features = client.post("/api/query", json=self.BODY).json()["features"]
        for f in features:
            assert f["합계"] > 0


# ══════════════════════════════════════════════════════════════════════════════
# 3. 월 · 격자 레벨 (구 스코프, A-2)
# ══════════════════════════════════════════════════════════════════════════════
class TestMonthGrid:
    BODY = {
        "level": "grid",
        "mode": "month",
        "period": YEONWOL,
        "gu": GU_GANGNAM,
    }

    def test_status_200(self):
        res = client.post("/api/query", json=self.BODY)
        assert res.status_code == 200

    def test_many_grid_features(self):
        features = client.post("/api/query", json=self.BODY).json()["features"]
        assert len(features) > 10, (
            f"강남 격자 피처 다수 기대, 실제 {len(features)}"
        )

    def test_합계_nonnegative_and_some_positive(self):
        """격자별 합계는 0 이상, 최소 하나 이상은 양수여야 한다."""
        features = client.post("/api/query", json=self.BODY).json()["features"]
        for f in features:
            assert f["합계"] >= 0, f"합계<0 (음수 불가): {f}"
        assert any(f["합계"] > 0 for f in features), "모든 격자 합계가 0입니다"


# ══════════════════════════════════════════════════════════════════════════════
# 4. 주 모드
# ══════════════════════════════════════════════════════════════════════════════
class TestWeek:
    BODY = {
        "level": "gu",
        "mode": "week",
        "period": YEONJU,
        "weekday": "전체",
    }

    def test_status_200(self):
        res = client.post("/api/query", json=self.BODY)
        assert res.status_code == 200

    def test_features_nonempty(self):
        data = client.post("/api/query", json=self.BODY).json()
        assert len(data["features"]) > 0, "주 모드 피처가 없습니다"

    def test_일수_positive(self):
        data = client.post("/api/query", json=self.BODY).json()
        assert data["일수"] is not None and data["일수"] > 0, (
            f"주 일수>0 기대, 실제: {data['일수']}"
        )

    def test_합계_positive(self):
        features = client.post("/api/query", json=self.BODY).json()["features"]
        for f in features:
            assert f["합계"] > 0


# ══════════════════════════════════════════════════════════════════════════════
# 5. 성별/연령 필터
# ══════════════════════════════════════════════════════════════════════════════
class TestSexAge:
    def test_female_20s_less_than_total(self):
        """여성 20대 합계 < 전체 합계 (전체의 부분집합이므로)."""
        body_total = {"level": "gu", "mode": "month", "period": YEONWOL}
        body_female = {
            "level": "gu", "mode": "month", "period": YEONWOL,
            "sex": "여", "ages": ["20대"],
        }
        total_sum = sum(
            f["합계"]
            for f in client.post("/api/query", json=body_total).json()["features"]
        )
        female_sum = sum(
            f["합계"]
            for f in client.post("/api/query", json=body_female).json()["features"]
        )
        assert female_sum < total_sum, (
            f"여성 20대 합계({female_sum}) ≥ 전체 합계({total_sum})"
        )

    def test_female_20s_status_200(self):
        body = {
            "level": "gu", "mode": "month", "period": YEONWOL,
            "sex": "여", "ages": ["20대"],
        }
        assert client.post("/api/query", json=body).status_code == 200


# ══════════════════════════════════════════════════════════════════════════════
# 6. 일 시계열
# ══════════════════════════════════════════════════════════════════════════════
class TestDayEndpoint:
    BODY = {"level": "gu", "period": LOADED_DAY}

    def test_status_200(self):
        res = client.post("/api/query/day", json=self.BODY)
        assert res.status_code == 200

    def test_series_nonempty(self):
        data = client.post("/api/query/day", json=self.BODY).json()
        assert len(data["series"]) > 0, "일 시계열 series 가 비어 있습니다"

    def test_mode_is_day(self):
        data = client.post("/api/query/day", json=self.BODY).json()
        assert data["mode"] == "day"

    def test_시간_in_0_23(self):
        series = client.post("/api/query/day", json=self.BODY).json()["series"]
        for pt in series:
            assert 0 <= pt["시간"] <= 23, f"시간 범위 오류: {pt['시간']}"

    def test_값_positive(self):
        series = client.post("/api/query/day", json=self.BODY).json()["series"]
        for pt in series:
            assert pt["값"] > 0

    def test_has_24_hours(self):
        """구 레벨 일 시계열은 24시간 × 25구 행이 있어야 한다."""
        series = client.post("/api/query/day", json=self.BODY).json()["series"]
        hours = {pt["시간"] for pt in series}
        assert len(hours) == 24, f"24시간 기대, 실제 시간 집합: {sorted(hours)}"


# ══════════════════════════════════════════════════════════════════════════════
# 7. 유효성 검사 (400 / 422)
# ══════════════════════════════════════════════════════════════════════════════
class TestValidation:
    def test_dong_level_without_gu_returns_400(self):
        """dong level 에 gu 없으면 ValueError → 400."""
        body = {"level": "dong", "mode": "month", "period": YEONWOL}
        res = client.post("/api/query", json=body)
        assert res.status_code in (400, 422), (
            f"dong+gu없음 → 4xx 기대, 실제 {res.status_code}"
        )

    def test_bad_sex_returns_422(self):
        """Literal 범위 밖 sex → Pydantic 422."""
        body = {
            "level": "gu", "mode": "month", "period": YEONWOL,
            "sex": "male",
        }
        res = client.post("/api/query", json=body)
        assert res.status_code == 422, (
            f"잘못된 sex → 422 기대, 실제 {res.status_code}"
        )

    def test_bad_age_bucket_returns_400(self):
        """알 수 없는 age 버킷 → ValueError → 400."""
        body = {
            "level": "gu", "mode": "month", "period": YEONWOL,
            "ages": ["99대"],
        }
        res = client.post("/api/query", json=body)
        assert res.status_code == 400, (
            f"잘못된 age 버킷 → 400 기대, 실제 {res.status_code}"
        )

    def test_grid_without_gu_or_dong_returns_400(self):
        """grid level 에 gu/dong 모두 없으면 ValueError → 400."""
        body = {"level": "grid", "mode": "month", "period": YEONWOL}
        res = client.post("/api/query", json=body)
        assert res.status_code in (400, 422), (
            f"grid+스코프없음 → 4xx 기대, 실제 {res.status_code}"
        )


# ══════════════════════════════════════════════════════════════════════════════
# 8. grid level → feature 에 행정동코드 포함 (gu/dong 은 None)
# ══════════════════════════════════════════════════════════════════════════════
class TestGridDongCode:
    DONG_GANGNAM = "11680510"  # 강남구 소속 실제 행정동코드

    def test_grid_dong_scope_features_carry_행정동코드(self):
        """grid + dong 스코프: 각 격자 feature 가 자신의 행정동코드를 가진다."""
        body = {
            "level": "grid", "mode": "month", "period": YEONWOL,
            "dong": self.DONG_GANGNAM,
        }
        features = client.post("/api/query", json=body).json()["features"]
        assert len(features) > 0, "격자 feature 가 없습니다"
        for f in features:
            assert f.get("행정동코드") == self.DONG_GANGNAM, (
                f"동 스코프 격자의 행정동코드 불일치: {f}"
            )

    def test_grid_gu_scope_features_carry_행정동코드(self):
        """grid + gu 스코프(A-2): 각 격자 feature 가 행정동코드를 가지며 구 접두로 시작."""
        body = {
            "level": "grid", "mode": "month", "period": YEONWOL,
            "gu": GU_GANGNAM,
        }
        features = client.post("/api/query", json=body).json()["features"]
        assert len(features) > 0
        assert any(f.get("행정동코드") for f in features), (
            "어떤 격자도 행정동코드를 갖지 않습니다"
        )
        for f in features:
            동 = f.get("행정동코드")
            assert 동 is not None, f"grid feature 에 행정동코드 없음: {f}"
            assert 동.startswith(GU_GANGNAM), (
                f"강남 외 행정동코드: {동}"
            )

    def test_gu_level_features_no_행정동코드(self):
        """gu level 응답의 feature 는 행정동코드가 None 이어야 한다."""
        body = {
            "level": "gu", "mode": "month", "period": YEONWOL,
            "weekday": "전체",
        }
        features = client.post("/api/query", json=body).json()["features"]
        for f in features:
            assert f.get("행정동코드") is None, (
                f"gu level 인데 행정동코드 채워짐: {f}"
            )

    def test_dong_level_features_no_행정동코드(self):
        """dong level 응답의 feature 는 행정동코드가 None 이어야 한다."""
        body = {
            "level": "dong", "mode": "month", "period": YEONWOL,
            "gu": GU_GANGNAM,
        }
        features = client.post("/api/query", json=body).json()["features"]
        assert len(features) > 0
        for f in features:
            assert f.get("행정동코드") is None, (
                f"dong level 인데 행정동코드 채워짐: {f}"
            )
