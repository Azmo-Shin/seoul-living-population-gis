# -*- coding: utf-8 -*-
"""test_trend.py — /api/query/trend 추이 통합 테스트 (실 DB, TestClient).

단일 영역(구/동/격자)의 mode 별 추이를 검증한다.
  - month : 연월별 합계 + 일수 (마트, 전체 기간). 프론트 평균 = 합계 ÷ (일수 × 시간수).
  - week  : 최근 ~12주 연주별 합계 + 일수 (raw + 달력).
  - day   : recent30 + sameWeekday 두 일별 계열 (raw). 일수=1 → 평균 = 합계 ÷ 시간수.

라이브 DB 사실 (2026-06 기준):
  - 마트_월_시간 연월 범위: '202401' ~ '202606' (총 30개 연월).
  - 202401 전체 적재일수 = 31, 202506 주중 적재일수 = 20.
  - MAX(_적재로그.일자) = 2026-06-05 (금, 요일=4).
  - 강남구 11680, 강남구 소속 행정동 11680510, 그 동 소속 격자 '다사56754700'.

실행:
  cd 02.script/backend
  python -m pytest tests/test_trend.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

# ── 테스트 상수 (라이브 DB 사실에 기반) ──────────────────────────────────────
GU_GANGNAM = "11680"            # 강남구
DONG_GANGNAM = "11680510"       # 강남구 소속 실제 행정동코드
GRID_GANGNAM = "다사56754700"    # DONG_GANGNAM 소속 실제 격자코드
N_YEONWOL = 30                  # 마트 연월 개수 (202401~202606)
LATEST_LOADED = "2026-06-05"    # MAX(_적재로그.일자) — 금요일


def _post(body):
    return client.post("/api/query/trend", json=body)


# ══════════════════════════════════════════════════════════════════════════════
# 1. 월 모드 — 동 레벨 (기본 mode='month', 라벨=연월)
# ══════════════════════════════════════════════════════════════════════════════
class TestTrendMonthDong:
    BODY = {"level": "dong", "code": DONG_GANGNAM}  # mode 생략 → month 기본값

    def test_status_200(self):
        assert _post(self.BODY).status_code == 200

    def test_mode_defaults_to_month(self):
        data = _post(self.BODY).json()
        assert data["mode"] == "month"

    def test_echoes_level_and_code(self):
        data = _post(self.BODY).json()
        assert data["level"] == "dong"
        assert data["code"] == DONG_GANGNAM

    def test_points_nonempty(self):
        data = _post(self.BODY).json()
        assert len(data["points"]) > 0, "추이 points 가 비어 있습니다"

    def test_day_fields_none_in_month(self):
        """month 모드는 recent30/sameWeekday 가 None 이어야 한다."""
        data = _post(self.BODY).json()
        assert data["recent30"] is None
        assert data["sameWeekday"] is None

    def test_points_ordered_by_라벨(self):
        points = _post(self.BODY).json()["points"]
        labels = [p["라벨"] for p in points]
        assert labels == sorted(labels), f"라벨 오름차순 아님: {labels}"

    def test_each_point_has_fields(self):
        points = _post(self.BODY).json()["points"]
        for p in points:
            assert "라벨" in p and "합계" in p and "일수" in p
            assert len(p["라벨"]) == 6, f"라벨 YYYYMM 기대: {p['라벨']}"

    def test_합계_positive(self):
        points = _post(self.BODY).json()["points"]
        for p in points:
            assert p["합계"] > 0, f"합계>0 기대: {p}"

    def test_일수_present_and_positive(self):
        points = _post(self.BODY).json()["points"]
        for p in points:
            assert p["일수"] is not None and p["일수"] > 0, f"일수>0 기대: {p}"


# ══════════════════════════════════════════════════════════════════════════════
# 2. 월 모드 — 구 레벨 (행정동코드 접두 범위 합산)
# ══════════════════════════════════════════════════════════════════════════════
class TestTrendMonthGu:
    BODY = {"level": "gu", "code": GU_GANGNAM, "mode": "month"}

    def test_status_200(self):
        assert _post(self.BODY).status_code == 200

    def test_full_yeonwol_series(self):
        """구 월 추이는 마트의 모든 연월(30개)을 포함해야 한다."""
        points = _post(self.BODY).json()["points"]
        assert len(points) == N_YEONWOL, (
            f"연월 {N_YEONWOL}개 기대, 실제 {len(points)}"
        )

    def test_gu_sum_ge_dong_sum(self):
        """같은 연월에서 구 합계 ≥ 소속 동 합계 (동은 구의 부분집합)."""
        gu_pts = {p["라벨"]: p["합계"] for p in _post(self.BODY).json()["points"]}
        dong_pts = {
            p["라벨"]: p["합계"]
            for p in _post({"level": "dong", "code": DONG_GANGNAM}).json()["points"]
        }
        common = set(gu_pts) & set(dong_pts)
        assert common, "공통 연월이 없습니다"
        for ym in common:
            assert gu_pts[ym] >= dong_pts[ym], (
                f"{ym}: 구합계({gu_pts[ym]}) < 동합계({dong_pts[ym]})"
            )

    def test_weekday_filter_changes_일수(self):
        """주중 필터 시 일수가 전체보다 작거나 같아야 한다."""
        full = _post({"level": "gu", "code": GU_GANGNAM, "weekday": "전체"}).json()
        jung = _post({"level": "gu", "code": GU_GANGNAM, "weekday": "주중"}).json()
        full_map = {p["라벨"]: p["일수"] for p in full["points"]}
        jung_map = {p["라벨"]: p["일수"] for p in jung["points"]}
        for ym in set(full_map) & set(jung_map):
            assert jung_map[ym] <= full_map[ym], (
                f"{ym}: 주중일수({jung_map[ym]}) > 전체일수({full_map[ym]})"
            )


# ══════════════════════════════════════════════════════════════════════════════
# 3. 월 모드 — 격자 레벨
# ══════════════════════════════════════════════════════════════════════════════
class TestTrendMonthGrid:
    BODY = {"level": "grid", "code": GRID_GANGNAM, "mode": "month"}

    def test_status_200(self):
        assert _post(self.BODY).status_code == 200

    def test_points_nonempty_ordered(self):
        points = _post(self.BODY).json()["points"]
        assert len(points) > 0, "격자 추이 points 가 비어 있습니다"
        labels = [p["라벨"] for p in points]
        assert labels == sorted(labels)


# ══════════════════════════════════════════════════════════════════════════════
# 4. 주 모드 — 최근 ~12주 연주별 합계 + 일수
# ══════════════════════════════════════════════════════════════════════════════
class TestTrendWeek:
    DONG_BODY = {"level": "dong", "code": DONG_GANGNAM, "mode": "week"}
    GU_BODY = {"level": "gu", "code": GU_GANGNAM, "mode": "week"}
    GRID_BODY = {"level": "grid", "code": GRID_GANGNAM, "mode": "week"}

    def test_status_200(self):
        assert _post(self.DONG_BODY).status_code == 200

    def test_mode_is_week(self):
        assert _post(self.DONG_BODY).json()["mode"] == "week"

    def test_points_nonempty(self):
        points = _post(self.DONG_BODY).json()["points"]
        assert len(points) > 0, "주 추이 points 가 비어 있습니다"

    def test_at_most_12_points(self):
        """주 추이는 최신 ~12주만 반환한다."""
        points = _post(self.DONG_BODY).json()["points"]
        assert len(points) <= 12, f"최대 12주 기대, 실제 {len(points)}"

    def test_points_ordered_by_연주(self):
        points = _post(self.DONG_BODY).json()["points"]
        labels = [p["라벨"] for p in points]
        assert labels == sorted(labels), f"연주 오름차순 아님: {labels}"

    def test_라벨_is_yeonju_format(self):
        """주 라벨은 'YYYY-WW' (연주) 형식."""
        points = _post(self.DONG_BODY).json()["points"]
        for p in points:
            assert "-" in p["라벨"], f"연주 형식(YYYY-WW) 기대: {p['라벨']}"

    def test_each_point_has_일수(self):
        points = _post(self.DONG_BODY).json()["points"]
        for p in points:
            assert "일수" in p and "합계" in p
            assert p["합계"] > 0, f"합계>0 기대: {p}"
            assert p["일수"] is not None and p["일수"] > 0, f"일수>0 기대: {p}"

    def test_day_fields_none_in_week(self):
        data = _post(self.DONG_BODY).json()
        assert data["recent30"] is None and data["sameWeekday"] is None

    def test_gu_week_runs_and_ge_dong(self):
        """구 주 합계 ≥ 동 주 합계 (같은 연주)."""
        gu = {p["라벨"]: p["합계"] for p in _post(self.GU_BODY).json()["points"]}
        dong = {p["라벨"]: p["합계"] for p in _post(self.DONG_BODY).json()["points"]}
        common = set(gu) & set(dong)
        assert common, "공통 연주가 없습니다"
        for wk in common:
            assert gu[wk] >= dong[wk], f"{wk}: 구({gu[wk]}) < 동({dong[wk]})"

    def test_grid_week_runs(self):
        assert _post(self.GRID_BODY).status_code == 200
        assert len(_post(self.GRID_BODY).json()["points"]) > 0


# ══════════════════════════════════════════════════════════════════════════════
# 5. 일 모드 — recent30 + sameWeekday 두 계열
# ══════════════════════════════════════════════════════════════════════════════
class TestTrendDay:
    DONG_BODY = {"level": "dong", "code": DONG_GANGNAM, "mode": "day"}
    GU_BODY = {"level": "gu", "code": GU_GANGNAM, "mode": "day"}
    GRID_BODY = {"level": "grid", "code": GRID_GANGNAM, "mode": "day"}

    def test_status_200(self):
        assert _post(self.DONG_BODY).status_code == 200

    def test_mode_is_day(self):
        assert _post(self.DONG_BODY).json()["mode"] == "day"

    def test_points_none_in_day(self):
        """day 모드는 points 가 None 이어야 한다."""
        assert _post(self.DONG_BODY).json()["points"] is None

    def test_recent30_array_present(self):
        data = _post(self.DONG_BODY).json()
        assert isinstance(data["recent30"], list)
        assert len(data["recent30"]) > 0, "recent30 가 비어 있습니다"

    def test_sameWeekday_array_present(self):
        data = _post(self.DONG_BODY).json()
        assert isinstance(data["sameWeekday"], list)
        assert len(data["sameWeekday"]) > 0, "sameWeekday 가 비어 있습니다"

    def test_recent30_at_most_31(self):
        data = _post(self.DONG_BODY).json()
        assert len(data["recent30"]) <= 31, (
            f"recent30 ≤31 기대, 실제 {len(data['recent30'])}"
        )

    def test_recent30_points_shape_and_order(self):
        recent30 = _post(self.DONG_BODY).json()["recent30"]
        days = [p["일자"] for p in recent30]
        assert days == sorted(days), f"recent30 일자 오름차순 아님: {days}"
        for p in recent30:
            assert "일자" in p and "합계" in p
            assert len(p["일자"]) == 10, f"일자 YYYY-MM-DD 기대: {p['일자']}"
            assert p["합계"] > 0, f"합계>0 기대: {p}"

    def test_recent30_latest_is_loaded_max(self):
        """recent30 마지막 점이 최신 적재일이어야 한다."""
        recent30 = _post(self.DONG_BODY).json()["recent30"]
        assert recent30[-1]["일자"] == LATEST_LOADED, (
            f"recent30 끝={recent30[-1]['일자']} != {LATEST_LOADED}"
        )

    def test_sameWeekday_all_same_dow(self):
        """sameWeekday 의 모든 일자가 최신 적재일(금)과 같은 요일(7일 간격)."""
        import datetime as _dt
        sw = _post(self.DONG_BODY).json()["sameWeekday"]
        latest = _dt.date.fromisoformat(LATEST_LOADED)
        for p in sw:
            d = _dt.date.fromisoformat(p["일자"])
            assert (latest - d).days % 7 == 0, (
                f"{p['일자']} 가 {LATEST_LOADED} 와 같은 요일이 아님"
            )

    def test_sameWeekday_ordered(self):
        sw = _post(self.DONG_BODY).json()["sameWeekday"]
        days = [p["일자"] for p in sw]
        assert days == sorted(days), f"sameWeekday 일자 오름차순 아님: {days}"

    def test_gu_day_ge_dong_day(self):
        """같은 일자에서 구 합계 ≥ 동 합계 (recent30)."""
        gu = {p["일자"]: p["합계"] for p in _post(self.GU_BODY).json()["recent30"]}
        dong = {p["일자"]: p["합계"] for p in _post(self.DONG_BODY).json()["recent30"]}
        common = set(gu) & set(dong)
        assert common, "공통 일자가 없습니다"
        for d in common:
            assert gu[d] >= dong[d], f"{d}: 구({gu[d]}) < 동({dong[d]})"

    def test_grid_day_runs(self):
        data = _post(self.GRID_BODY).json()
        assert data["mode"] == "day"
        assert len(data["recent30"]) > 0


# ══════════════════════════════════════════════════════════════════════════════
# 6. 성별/연령 필터 (부분집합 ≤ 전체) — month 모드
# ══════════════════════════════════════════════════════════════════════════════
class TestTrendSexAge:
    def test_female_20s_le_total_per_month(self):
        total = _post({"level": "gu", "code": GU_GANGNAM}).json()["points"]
        female = _post({
            "level": "gu", "code": GU_GANGNAM, "sex": "여", "ages": ["20대"],
        }).json()["points"]
        total_map = {p["라벨"]: p["합계"] for p in total}
        female_map = {p["라벨"]: p["합계"] for p in female}
        for ym in set(total_map) & set(female_map):
            assert female_map[ym] <= total_map[ym], (
                f"{ym}: 여20대({female_map[ym]}) > 전체({total_map[ym]})"
            )

    def test_female_20s_day_le_total(self):
        """day 모드 recent30 에서도 부분집합 ≤ 전체."""
        total = _post({"level": "gu", "code": GU_GANGNAM, "mode": "day"}).json()
        female = _post({
            "level": "gu", "code": GU_GANGNAM, "mode": "day",
            "sex": "여", "ages": ["20대"],
        }).json()
        t_map = {p["일자"]: p["합계"] for p in total["recent30"]}
        f_map = {p["일자"]: p["합계"] for p in female["recent30"]}
        for d in set(t_map) & set(f_map):
            assert f_map[d] <= t_map[d], f"{d}: 여20대 > 전체"


# ══════════════════════════════════════════════════════════════════════════════
# 7. 유효성 검사 (400 / 422) — 모드 무관 + 모드별
# ══════════════════════════════════════════════════════════════════════════════
class TestTrendValidation:
    def test_bad_gu_code_nonnumeric_returns_400(self):
        """gu code 가 비숫자 → ValueError → 400 (month)."""
        assert _post({"level": "gu", "code": "abcde"}).status_code == 400

    def test_bad_gu_code_nonnumeric_week_returns_400(self):
        """week 모드도 gu code 검증 동일 → 400."""
        body = {"level": "gu", "code": "abcde", "mode": "week"}
        assert _post(body).status_code == 400

    def test_bad_gu_code_nonnumeric_day_returns_400(self):
        body = {"level": "gu", "code": "abcde", "mode": "day"}
        assert _post(body).status_code == 400

    def test_bad_gu_code_wrong_length_returns_400(self):
        assert _post({"level": "gu", "code": "116"}).status_code == 400

    def test_empty_code_returns_400(self):
        assert _post({"level": "dong", "code": ""}).status_code == 400

    def test_bad_level_returns_422(self):
        assert _post({"level": "city", "code": GU_GANGNAM}).status_code == 422

    def test_bad_mode_returns_422(self):
        """Literal 범위 밖 mode → Pydantic 422."""
        body = {"level": "gu", "code": GU_GANGNAM, "mode": "year"}
        assert _post(body).status_code == 422

    def test_bad_sex_returns_422(self):
        body = {"level": "gu", "code": GU_GANGNAM, "sex": "male"}
        assert _post(body).status_code == 422

    def test_bad_age_bucket_returns_400(self):
        body = {"level": "gu", "code": GU_GANGNAM, "ages": ["99대"]}
        assert _post(body).status_code == 400
