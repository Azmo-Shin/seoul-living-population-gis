# -*- coding: utf-8 -*-
"""test_meta.py — 메타 라우트 통합 테스트 (실 DB, FastAPI TestClient).

실행:
  cd 02.script/backend
  python -m pytest tests/test_meta.py -v
"""
import sys
from datetime import date
from pathlib import Path

# backend/ 를 sys.path 에 추가 (pytest 실행 위치에 무관하게 import 해결)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


# ── /api/meta/districts ────────────────────────────────────────────────────────
class TestDistricts:
    def test_status_200(self):
        res = client.get("/api/meta/districts")
        assert res.status_code == 200

    def test_exactly_25_rows(self):
        rows = client.get("/api/meta/districts").json()
        assert isinstance(rows, list)
        assert len(rows) == 25, f"서울 25개 구여야 합니다. 실제: {len(rows)}"

    def test_each_row_has_required_keys(self):
        rows = client.get("/api/meta/districts").json()
        for row in rows:
            assert "구코드" in row, f"구코드 키 없음: {row}"
            assert "구명" in row, f"구명 키 없음: {row}"

    def test_includes_jongno(self):
        """종로구가 포함되어 있어야 한다 (구코드 기준 첫 번째)."""
        rows = client.get("/api/meta/districts").json()
        names = [r["구명"] for r in rows]
        assert "종로구" in names, f"종로구가 없습니다. 구명 목록: {names}"


# ── /api/meta/dongs ────────────────────────────────────────────────────────────
class TestDongs:
    GU = "11680"  # 강남구

    def test_status_200_with_valid_gu(self):
        res = client.get(f"/api/meta/dongs?gu={self.GU}")
        assert res.status_code == 200

    def test_returns_nonempty_list(self):
        rows = client.get(f"/api/meta/dongs?gu={self.GU}").json()
        assert isinstance(rows, list)
        assert len(rows) > 0, "강남구 행정동이 0개여서는 안 됩니다."

    def test_each_row_has_required_keys(self):
        rows = client.get(f"/api/meta/dongs?gu={self.GU}").json()
        for row in rows:
            assert "행정동코드" in row, f"행정동코드 키 없음: {row}"
            assert "행정동명" in row, f"행정동명 키 없음: {row}"

    def test_missing_gu_param_returns_4xx(self):
        """gu 파라미터 없이 호출하면 400 또는 422를 반환해야 한다."""
        res = client.get("/api/meta/dongs")
        assert res.status_code in (400, 422), (
            f"gu 미전달 시 4xx 예상, 실제: {res.status_code}"
        )

    def test_blank_gu_returns_400(self):
        """gu 가 공백 문자열이면 400을 반환해야 한다."""
        res = client.get("/api/meta/dongs?gu=   ")
        assert res.status_code == 400, (
            f"공백 gu 시 400 예상, 실제: {res.status_code}"
        )


# ── /api/meta/range ────────────────────────────────────────────────────────────
class TestRange:
    def _get(self):
        res = client.get("/api/meta/range")
        assert res.status_code == 200, f"상태코드: {res.status_code}, body: {res.text}"
        return res.json()

    def test_status_200(self):
        res = client.get("/api/meta/range")
        assert res.status_code == 200

    def test_has_day_month_week_keys(self):
        data = self._get()
        for key in ("day", "month", "week"):
            assert key in data, f"'{key}' 키 없음: {list(data.keys())}"

    def test_each_section_has_min_max(self):
        data = self._get()
        for section in ("day", "month", "week"):
            assert "min" in data[section], f"{section}.min 없음"
            assert "max" in data[section], f"{section}.max 없음"

    def test_day_max_not_in_future(self):
        """day.max 는 오늘 이하여야 한다 (미래 적재 로그는 없음)."""
        data = self._get()
        day_max = data["day"]["max"]  # "YYYY-MM-DD"
        assert day_max <= date.today().isoformat(), (
            f"day.max ({day_max}) 가 오늘({date.today()})보다 미래입니다."
        )

    def test_month_max_format_and_plausible(self):
        """month.max 는 'YYYY-MM' 형식이며 2026-06 이하여야 한다."""
        data = self._get()
        month_max = data["month"]["max"]
        assert len(month_max) == 7 and month_max[4] == "-", (
            f"month.max 형식 오류: {month_max}"
        )
        assert month_max <= "2026-06", (
            f"month.max ({month_max}) 가 2026-06 초과입니다."
        )

    def test_day_min_lte_max(self):
        data = self._get()
        assert data["day"]["min"] <= data["day"]["max"], (
            f"day.min ({data['day']['min']}) > day.max ({data['day']['max']})"
        )

    def test_month_min_lte_max(self):
        data = self._get()
        assert data["month"]["min"] <= data["month"]["max"]

    def test_week_min_lte_max(self):
        data = self._get()
        assert data["week"]["min"] <= data["week"]["max"], (
            f"week.min ({data['week']['min']}) > week.max ({data['week']['max']})"
        )
