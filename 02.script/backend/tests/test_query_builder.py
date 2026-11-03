# -*- coding: utf-8 -*-
"""test_query_builder.py — services/query_builder.py TDD 테스트 (Red → Green).

실행:
  cd 02.script/backend
  python -m pytest tests/test_query_builder.py -v

구성:
  1. 순수 빌더 단위 테스트 — 생성 SQL 구조 + params 검증 (DB 무관).
  2. 라이브 DB 실행 테스트 — 생성 SQL 을 실제 shin_project 에 던져
     실행되고 합리적 결과가 나오는지 증명 (이 빌더의 존재 이유).

라이브 DB 사실 (2026-06-12 기준, _적재로그 ∩ 달력 확인):
  - 연월 'YYYYMM' = 그레고리력 (예: '202506' = 2025년 6월, 30일 전부 적재).
  - 202506 적재일수: 전체 30, 주중 20, 주말 10. 202401 전체 31.
  - 강남구 11680 이 월/주 합계에서 최상위권.
  - 실제 행정동코드 예: 11680510 (강남구 소속).
  - raw 테이블(생활인구_250m)은 격자 컬럼이 `250M격자`, mart 는 `격자코드`.
  - 적재 범위 내 연주: '2025-23' (주중 4일), 실제 적재 일자: '2025-06-01'.
"""
import re
import sys
from pathlib import Path

# backend/ 를 sys.path 에 추가
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

import db
from services.metrics import metric_expr
from services.query_builder import (
    code_expr,
    scope_clause,
    build_month_sql,
    build_week_sql,
    build_day_sql,
    build_grid_breakdown_sql,
    build_trend_sql,
    build_trend_week_sql,
    build_trend_day_sql,
    build_trend_same_weekday_sql,
    day_count_sql,
    trend_day_count_sql,
    week_trend_day_count_sql,
)

# ── 테스트용 상수 (라이브 DB 사실에 기반) ──────────────────────────────────────
GU_GANGNAM = "11680"            # 강남구 (최상위권 검증용)
GU_END_GANGNAM = "11681"        # _gu_end('11680')
DONG_GANGNAM = "11680510"       # 강남구 소속 실제 행정동코드
GRID_GANGNAM = "다사56754700"    # DONG_GANGNAM 소속 실제 격자코드 (mart)
YEONWOL = "202506"              # 2025년 6월 (30일 전부 적재)
YEONWOL_FULL = "202401"         # 2024년 1월 (31일 전부 적재)
YEONJU = "2025-23"              # 적재 범위 내 연주 (주중 4일)
LOADED_DAY = "2025-06-01"       # 실제 적재 일자
ALL_HOURS = list(range(24))
METRIC_TOTAL = metric_expr("전체", [])  # "COALESCE(SUM(`생활인구합계`),0)"
DATE_START = "2026-03-13"       # 추이 날짜창 시작 (raw 주/일 추이용)
DATE_END = "2026-06-05"         # 추이 날짜창 끝 (MAX 적재일)
YOIL_FRI = 4                    # 2026-06-05 의 요일값 (금)


def _norm(sql: str) -> str:
    """공백 정규화 — SQL 구조 검사 시 들여쓰기/개행 차이 무시."""
    return re.sub(r"\s+", " ", sql).strip()


# ═════════════════════════════════════════════════════════════════════════════
# 1. code_expr — 공간 그룹 키 (데이터소스 분기가 핵심)
# ═════════════════════════════════════════════════════════════════════════════
class TestCodeExpr:
    def test_gu(self):
        assert code_expr("gu", "mart") == "LEFT(`행정동코드`,5)"
        assert code_expr("gu", "raw") == "LEFT(`행정동코드`,5)"

    def test_dong(self):
        assert code_expr("dong", "mart") == "`행정동코드`"
        assert code_expr("dong", "raw") == "`행정동코드`"

    def test_grid_mart(self):
        """mart 의 격자 컬럼명은 격자코드."""
        assert code_expr("grid", "mart") == "`격자코드`"

    def test_grid_raw(self):
        """raw 의 격자 컬럼명은 250M격자 — 데이터소스 분기 핵심 테스트."""
        assert code_expr("grid", "raw") == "`250M격자`"

    def test_invalid_level_raises(self):
        with pytest.raises(ValueError):
            code_expr("city", "mart")

    def test_invalid_source_raises(self):
        with pytest.raises(ValueError):
            code_expr("grid", "warehouse")


# ═════════════════════════════════════════════════════════════════════════════
# 2. scope_clause — SARGable 부모 스코프 제한
# ═════════════════════════════════════════════════════════════════════════════
class TestScopeClause:
    def test_gu_level_all_seoul(self):
        """gu level → 전체 서울, 스코프 절 없음."""
        frag, params = scope_clause("gu", None, None)
        assert frag == ""
        assert params == ()

    def test_dong_level_range(self):
        """dong level → 구 범위 SARGable (LEFT() 미사용, >= AND <)."""
        frag, params = scope_clause("dong", GU_GANGNAM, None)
        assert "LEFT(" not in frag
        assert ">=" in frag and "<" in frag
        assert "`행정동코드`" in frag
        assert params == (GU_GANGNAM, GU_END_GANGNAM)

    def test_dong_level_gu_end_increment(self):
        """_gu_end: '11680' → '11681' (zfill 5)."""
        _, params = scope_clause("dong", "11680", None)
        assert params == ("11680", "11681")

    def test_dong_level_gu_end_leading(self):
        """선행 0 보존: '01230' → '01231'."""
        _, params = scope_clause("dong", "01230", None)
        assert params == ("01230", "01231")

    def test_grid_level_dong_eq(self):
        """grid + dong → 행정동코드 동등 비교."""
        frag, params = scope_clause("grid", None, DONG_GANGNAM)
        assert "`행정동코드` = %s" in frag
        assert "LEFT(" not in frag
        assert params == (DONG_GANGNAM,)

    def test_grid_level_gu_range(self):
        """grid + gu (동 미지정, A-2) → 구 범위 SARGable."""
        frag, params = scope_clause("grid", GU_GANGNAM, None)
        assert ">=" in frag and "<" in frag
        assert params == (GU_GANGNAM, GU_END_GANGNAM)

    def test_grid_level_dong_takes_precedence(self):
        """grid + (gu, dong) 둘 다 → dong 우선 (동등 비교)."""
        frag, params = scope_clause("grid", GU_GANGNAM, DONG_GANGNAM)
        assert "`행정동코드` = %s" in frag
        assert params == (DONG_GANGNAM,)

    def test_grid_level_no_parent_raises(self):
        """grid + gu/dong 둘 다 없음 → ValueError."""
        with pytest.raises(ValueError):
            scope_clause("grid", None, None)

    def test_dong_level_no_gu_raises(self):
        """dong level + gu 없음 → ValueError."""
        with pytest.raises(ValueError):
            scope_clause("dong", None, None)


# ═════════════════════════════════════════════════════════════════════════════
# 3. build_month_sql — 월 (mart) 구조 + params
# ═════════════════════════════════════════════════════════════════════════════
class TestBuildMonthStructure:
    def test_gu_structure(self):
        sql, params = build_month_sql(
            "gu", YEONWOL, None, None, [6, 7, 8], "주중", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "SELECT" in n
        assert "LEFT(`행정동코드`,5) AS code" in n
        assert METRIC_TOTAL in n
        assert "AS 합계" in n
        assert "FROM `마트_월_시간`" in n
        assert "`연월`=%s" in n.replace(" =", "=").replace("= ", "=") or "`연월` = %s" in n
        assert "`주중주말` IN (%s)" in n
        assert "`시간` IN (%s,%s,%s)" in n
        assert "GROUP BY code" in n
        # params: (연월, weekday..., hours..., scope...)
        assert params == (YEONWOL, "주중", 6, 7, 8)

    def test_weekday_jeonche_two_params(self):
        """weekday=전체 → 주중,주말 두 params, IN (%s,%s)."""
        sql, params = build_month_sql(
            "gu", YEONWOL, None, None, [0], "전체", METRIC_TOTAL
        )
        assert "`주중주말` IN (%s,%s)" in _norm(sql)
        assert params == (YEONWOL, "주중", "주말", 0)

    def test_dong_scope_sargable(self):
        """dong level → 스코프가 LEFT() 없이 범위 비교, code_expr=행정동코드."""
        sql, params = build_month_sql(
            "dong", YEONWOL, GU_GANGNAM, None, ALL_HOURS, "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "`행정동코드` AS code" in n
        assert "LEFT(" not in n  # 스코프에 LEFT() 없어야 함 (code_expr 제외)
        assert ">= %s" in n and "< %s" in n
        # params 끝에 (gu, gu_end)
        assert params[-2:] == (GU_GANGNAM, GU_END_GANGNAM)
        assert params[0] == YEONWOL

    def test_grid_dong_scope(self):
        """grid + dong → code_expr=격자코드, 스코프 행정동코드=%s."""
        sql, params = build_month_sql(
            "grid", YEONWOL, None, DONG_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "`격자코드` AS code" in n
        assert "`행정동코드` = %s" in n
        assert params[-1] == DONG_GANGNAM

    def test_grid_gu_scope(self):
        """grid + gu (A-2) → code_expr=격자코드, 스코프 범위 비교."""
        sql, params = build_month_sql(
            "grid", YEONWOL, GU_GANGNAM, None, ALL_HOURS, "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "`격자코드` AS code" in n
        assert ">= %s" in n and "< %s" in n
        assert params[-2:] == (GU_GANGNAM, GU_END_GANGNAM)

    def test_invalid_weekday_raises(self):
        with pytest.raises(ValueError):
            build_month_sql("gu", YEONWOL, None, None, [0], "평일", METRIC_TOTAL)

    def test_invalid_hour_raises(self):
        with pytest.raises(ValueError):
            build_month_sql("gu", YEONWOL, None, None, [24], "전체", METRIC_TOTAL)

    def test_negative_hour_raises(self):
        with pytest.raises(ValueError):
            build_month_sql("gu", YEONWOL, None, None, [-1], "전체", METRIC_TOTAL)


# ═════════════════════════════════════════════════════════════════════════════
# 4. build_week_sql — 주 (raw + 달력) 구조 + params
# ═════════════════════════════════════════════════════════════════════════════
class TestBuildWeekStructure:
    def test_gu_structure(self):
        sql, params = build_week_sql(
            "gu", YEONJU, None, None, [6, 7, 8], "주중", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "FROM `생활인구_250m`" in n
        assert "LEFT(`행정동코드`,5) AS code" in n
        # 달력 서브쿼리로 파티션 프루닝 + 주중주말 필터
        assert "`일자` IN (SELECT `일자` FROM `달력`" in n
        assert "`연주`=%s" in n.replace(" =", "=").replace("= ", "=") or "`연주` = %s" in n
        assert "`주중주말` IN (%s)" in n
        assert "`시간` IN (%s,%s,%s)" in n
        assert "GROUP BY code" in n
        # gu level 은 250M격자 미사용
        assert "250M격자" not in n
        # params: (연주, weekday..., hours..., scope...)
        assert params == (YEONJU, "주중", 6, 7, 8)

    def test_grid_uses_raw_grid_col(self):
        """week + grid → code_expr 이 raw 격자(250M격자)."""
        sql, params = build_week_sql(
            "grid", YEONJU, None, DONG_GANGNAM, [12], "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "`250M격자` AS code" in n
        assert "`격자코드`" not in n  # mart 컬럼명 사용 금지
        assert "`행정동코드` = %s" in n
        assert params == (YEONJU, "주중", "주말", 12, DONG_GANGNAM)

    def test_dong_scope_sargable(self):
        sql, params = build_week_sql(
            "dong", YEONJU, GU_GANGNAM, None, [9], "주중", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "`행정동코드` AS code" in n
        assert params[-2:] == (GU_GANGNAM, GU_END_GANGNAM)


# ═════════════════════════════════════════════════════════════════════════════
# 5. build_day_sql — 일 (raw, 시간별 시계열)
# ═════════════════════════════════════════════════════════════════════════════
class TestBuildDayStructure:
    def test_gu_structure(self):
        sql, params = build_day_sql("gu", LOADED_DAY, None, None, METRIC_TOTAL)
        n = _norm(sql)
        assert "`시간` AS 시간" in n
        assert "LEFT(`행정동코드`,5) AS code" in n
        assert "FROM `생활인구_250m`" in n
        assert "`일자`=%s" in n.replace(" =", "=").replace("= ", "=") or "`일자` = %s" in n
        assert "GROUP BY `시간`, code" in n
        assert "ORDER BY `시간`" in n
        # 일 모드: 주중주말/시간 필터 없음
        assert "`주중주말`" not in n
        assert "IN (%s" not in n  # hours IN 절 없음
        assert params == (LOADED_DAY,)

    def test_grid_uses_raw_grid_col(self):
        sql, params = build_day_sql("grid", LOADED_DAY, None, DONG_GANGNAM, METRIC_TOTAL)
        n = _norm(sql)
        assert "`250M격자` AS code" in n
        assert "`행정동코드` = %s" in n
        assert params == (LOADED_DAY, DONG_GANGNAM)

    def test_dong_scope(self):
        sql, params = build_day_sql("dong", LOADED_DAY, GU_GANGNAM, None, METRIC_TOTAL)
        n = _norm(sql)
        assert "`행정동코드` AS code" in n
        assert params == (LOADED_DAY, GU_GANGNAM, GU_END_GANGNAM)


# ═════════════════════════════════════════════════════════════════════════════
# 5b. grid level → SELECT 에 행정동코드 포함 (동별 격자 분포용)
# ═════════════════════════════════════════════════════════════════════════════
class TestGridDongColumn:
    def test_month_grid_selects_행정동코드(self):
        sql, _ = build_month_sql(
            "grid", YEONWOL, None, DONG_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "MAX(`행정동코드`) AS 행정동코드" in n

    def test_week_grid_selects_행정동코드(self):
        sql, _ = build_week_sql(
            "grid", YEONJU, None, DONG_GANGNAM, [12], "전체", METRIC_TOTAL
        )
        assert "MAX(`행정동코드`) AS 행정동코드" in _norm(sql)

    def test_day_grid_selects_행정동코드(self):
        sql, _ = build_day_sql("grid", LOADED_DAY, None, DONG_GANGNAM, METRIC_TOTAL)
        assert "MAX(`행정동코드`) AS 행정동코드" in _norm(sql)

    def test_gu_month_no_행정동코드_column(self):
        """gu level 은 행정동코드 추가 컬럼이 없어야 한다."""
        sql, _ = build_month_sql(
            "gu", YEONWOL, None, None, ALL_HOURS, "전체", METRIC_TOTAL
        )
        assert "AS 행정동코드" not in _norm(sql)

    def test_dong_month_no_행정동코드_column(self):
        """dong level 은 행정동코드 추가 컬럼이 없어야 한다 (code 가 이미 행정동코드)."""
        sql, _ = build_month_sql(
            "dong", YEONWOL, GU_GANGNAM, None, ALL_HOURS, "전체", METRIC_TOTAL
        )
        assert "AS 행정동코드" not in _norm(sql)


# ═════════════════════════════════════════════════════════════════════════════
# 5b. build_grid_breakdown_sql — A-2 격자 × 행정동 portion 분해 (경계셀 동별)
# ═════════════════════════════════════════════════════════════════════════════
class TestBuildGridBreakdownStructure:
    def test_month_groups_by_grid_and_dong(self):
        sql, params = build_grid_breakdown_sql(
            "month", YEONWOL, GU_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        # 마트, 격자코드+행정동코드 GROUP BY, gu 범위(SARGable)
        assert "FROM `마트_월_시간`" in n
        assert "GROUP BY `격자코드`, `행정동코드`" in n
        assert "`행정동코드` >= %s AND `행정동코드` < %s" in n
        # params 끝에 gu 범위 [gu, gu_end]
        assert params[-2:] == (GU_GANGNAM, GU_END_GANGNAM)
        # 시간 24개 + 주중주말 2개 + 연월 1 → 인라인 %s 개수 일치
        assert params[0] == YEONWOL

    def test_week_uses_raw_grid_column(self):
        sql, params = build_grid_breakdown_sql(
            "week", YEONJU, GU_GANGNAM, [9, 10], "주중", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "FROM `생활인구_250m`" in n
        assert "`250M격자` AS 격자코드" in n
        assert "GROUP BY `250M격자`, `행정동코드`" in n
        assert params[-2:] == (GU_GANGNAM, GU_END_GANGNAM)

    def test_day_mode_rejected(self):
        with pytest.raises(ValueError):
            build_grid_breakdown_sql(
                "day", YEONWOL, GU_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL
            )

    def test_missing_gu_rejected(self):
        with pytest.raises(ValueError):
            build_grid_breakdown_sql(
                "month", YEONWOL, "", ALL_HOURS, "전체", METRIC_TOTAL
            )

    def test_bad_hours_rejected(self):
        with pytest.raises(ValueError):
            build_grid_breakdown_sql(
                "month", YEONWOL, GU_GANGNAM, [24], "전체", METRIC_TOTAL
            )


# ═════════════════════════════════════════════════════════════════════════════
# 5c. build_trend_sql — 단일 영역 월별 추이 (mart, 연월 그룹)
# ═════════════════════════════════════════════════════════════════════════════
class TestBuildTrendStructure:
    def test_gu_structure(self):
        sql, params = build_trend_sql("gu", GU_GANGNAM, [6, 7, 8], "주중", METRIC_TOTAL)
        n = _norm(sql)
        assert "`연월` AS 연월" in n
        assert METRIC_TOTAL in n and "AS 합계" in n
        assert "FROM `마트_월_시간`" in n
        assert "`주중주말` IN (%s)" in n
        assert "`시간` IN (%s,%s,%s)" in n
        # gu → SARGable 범위 비교 (LEFT() 미사용)
        assert "`행정동코드` >= %s AND `행정동코드` < %s" in n
        assert "LEFT(" not in n
        assert "GROUP BY `연월`" in n
        assert "ORDER BY `연월`" in n
        # params: (weekday..., hours..., code, gu_end)
        assert params == ("주중", 6, 7, 8, GU_GANGNAM, GU_END_GANGNAM)

    def test_dong_structure(self):
        sql, params = build_trend_sql("dong", DONG_GANGNAM, [0], "전체", METRIC_TOTAL)
        n = _norm(sql)
        assert "`행정동코드` = %s" in n
        assert "`주중주말` IN (%s,%s)" in n  # 전체 → 주중,주말
        assert params == ("주중", "주말", 0, DONG_GANGNAM)

    def test_grid_structure(self):
        sql, params = build_trend_sql("grid", GRID_GANGNAM, [12], "주중", METRIC_TOTAL)
        n = _norm(sql)
        assert "`격자코드` = %s" in n   # mart 격자 컬럼명
        assert params == ("주중", 12, GRID_GANGNAM)

    def test_bad_gu_code_nonnumeric_raises(self):
        with pytest.raises(ValueError):
            build_trend_sql("gu", "abcde", [0], "전체", METRIC_TOTAL)

    def test_bad_gu_code_length_raises(self):
        with pytest.raises(ValueError):
            build_trend_sql("gu", "116", [0], "전체", METRIC_TOTAL)

    def test_empty_code_raises(self):
        with pytest.raises(ValueError):
            build_trend_sql("dong", "", [0], "전체", METRIC_TOTAL)

    def test_user_values_not_interpolated(self):
        """코드/시간 같은 사용자 값이 SQL 문자열에 직접 박히지 않음."""
        sql, params = build_trend_sql("grid", GRID_GANGNAM, [6], "주중", METRIC_TOTAL)
        assert GRID_GANGNAM not in sql
        assert GRID_GANGNAM in params


# ═════════════════════════════════════════════════════════════════════════════
# 5d. trend_day_count_sql — 연월별 일수 (∩ _적재로그)
# ═════════════════════════════════════════════════════════════════════════════
class TestTrendDayCountStructure:
    def test_structure(self):
        sql, params = trend_day_count_sql("주중")
        n = _norm(sql)
        assert "`연월` AS 연월" in n
        assert "COUNT(*) AS 일수" in n
        assert "FROM `달력`" in n
        assert "`주중주말` IN (%s)" in n
        assert "EXISTS" in n and "`_적재로그`" in n
        assert "GROUP BY d.`연월`" in n
        assert params == ("주중",)

    def test_jeonche_two_params(self):
        sql, params = trend_day_count_sql("전체")
        assert "`주중주말` IN (%s,%s)" in _norm(sql)
        assert params == ("주중", "주말")

    def test_invalid_weekday_raises(self):
        with pytest.raises(ValueError):
            trend_day_count_sql("평일")


# ═════════════════════════════════════════════════════════════════════════════
# 5e. build_trend_week_sql — 주 추이 (raw + 달력, 연주 그룹, 날짜창)
# ═════════════════════════════════════════════════════════════════════════════
class TestBuildTrendWeekStructure:
    def test_dong_structure(self):
        sql, params = build_trend_week_sql(
            "dong", DONG_GANGNAM, DATE_START, DATE_END, [6, 7, 8], "주중", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "c.`연주` AS 연주" in n
        assert "FROM `생활인구_250m` r" in n
        assert "JOIN `달력` c ON c.`일자` = r.`일자`" in n
        # 날짜창 — SARGable 범위 (ix_일자/복합인덱스 + 파티션 프루닝)
        assert "r.`일자` >= %s AND r.`일자` <= %s" in n
        assert "c.`주중주말` IN (%s)" in n
        assert "r.`시간` IN (%s,%s,%s)" in n
        assert "`행정동코드` = %s" in n
        assert "GROUP BY c.`연주`" in n
        assert "ORDER BY c.`연주`" in n
        # params: (date_start, date_end, weekday..., hours..., code)
        assert params == (DATE_START, DATE_END, "주중", 6, 7, 8, DONG_GANGNAM)

    def test_gu_structure_sargable(self):
        sql, params = build_trend_week_sql(
            "gu", GU_GANGNAM, DATE_START, DATE_END, [0], "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "`행정동코드` >= %s AND `행정동코드` < %s" in n
        assert "LEFT(" not in n
        assert "c.`주중주말` IN (%s,%s)" in n  # 전체 → 주중,주말
        assert params == (DATE_START, DATE_END, "주중", "주말", 0, GU_GANGNAM, GU_END_GANGNAM)

    def test_grid_uses_raw_grid_col(self):
        """week 추이 + grid → raw 격자 컬럼(250M격자), mart 컬럼명 금지."""
        sql, params = build_trend_week_sql(
            "grid", GRID_GANGNAM, DATE_START, DATE_END, [12], "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "`250M격자` = %s" in n
        assert "`격자코드`" not in n
        assert params[-1] == GRID_GANGNAM

    def test_bad_gu_code_raises(self):
        with pytest.raises(ValueError):
            build_trend_week_sql("gu", "abcde", DATE_START, DATE_END, [0], "전체", METRIC_TOTAL)

    def test_user_values_not_interpolated(self):
        sql, params = build_trend_week_sql(
            "grid", GRID_GANGNAM, DATE_START, DATE_END, [6], "주중", METRIC_TOTAL
        )
        assert GRID_GANGNAM not in sql
        assert DATE_START not in sql and DATE_END not in sql
        assert GRID_GANGNAM in params and DATE_START in params


# ═════════════════════════════════════════════════════════════════════════════
# 5f. build_trend_day_sql — 일 추이 (raw, 일자 그룹, 날짜창)
# ═════════════════════════════════════════════════════════════════════════════
class TestBuildTrendDayStructure:
    def test_jeonche_no_calendar_join(self):
        """weekday=전체 → 달력 JOIN 생략 (raw 단독, 가장 빠름)."""
        sql, params = build_trend_day_sql(
            "dong", DONG_GANGNAM, DATE_START, DATE_END, ALL_HOURS, "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "r.`일자` AS 일자" in n
        assert "FROM `생활인구_250m` r" in n
        assert "JOIN `달력`" not in n  # 전체는 달력 JOIN 없음
        assert "r.`일자` >= %s AND r.`일자` <= %s" in n
        assert "`행정동코드` = %s" in n
        assert "GROUP BY r.`일자`" in n
        assert "ORDER BY r.`일자`" in n
        # params: (date_start, date_end, hours..., code)
        assert params[:2] == (DATE_START, DATE_END)
        assert params[-1] == DONG_GANGNAM

    def test_jungju_uses_calendar_join(self):
        """weekday=주중 → 달력 JOIN + 주중주말 필터."""
        sql, params = build_trend_day_sql(
            "gu", GU_GANGNAM, DATE_START, DATE_END, [8, 9], "주중", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "JOIN `달력` c ON c.`일자` = r.`일자`" in n
        assert "c.`주중주말` IN (%s)" in n
        assert "`행정동코드` >= %s AND `행정동코드` < %s" in n
        assert params == (DATE_START, DATE_END, "주중", 8, 9, GU_GANGNAM, GU_END_GANGNAM)

    def test_grid_uses_raw_grid_col(self):
        sql, params = build_trend_day_sql(
            "grid", GRID_GANGNAM, DATE_START, DATE_END, [12], "전체", METRIC_TOTAL
        )
        n = _norm(sql)
        assert "`250M격자` = %s" in n
        assert "`격자코드`" not in n

    def test_user_values_not_interpolated(self):
        sql, params = build_trend_day_sql(
            "grid", GRID_GANGNAM, DATE_START, DATE_END, [6], "전체", METRIC_TOTAL
        )
        assert GRID_GANGNAM not in sql and DATE_START not in sql


# ═════════════════════════════════════════════════════════════════════════════
# 5g. build_trend_same_weekday_sql — 동일요일 일 추이 (raw + 달력.요일)
# ═════════════════════════════════════════════════════════════════════════════
class TestBuildTrendSameWeekdayStructure:
    def test_structure(self):
        sql, params = build_trend_same_weekday_sql(
            "dong", DONG_GANGNAM, DATE_START, DATE_END, YOIL_FRI, [12], METRIC_TOTAL
        )
        n = _norm(sql)
        assert "r.`일자` AS 일자" in n
        assert "JOIN `달력` c ON c.`일자` = r.`일자`" in n
        assert "r.`일자` >= %s AND r.`일자` <= %s" in n
        assert "c.`요일` = %s" in n
        assert "r.`시간` IN (%s)" in n
        assert "`행정동코드` = %s" in n
        assert "GROUP BY r.`일자`" in n
        # params: (date_start, date_end, yoil, hours..., code)
        assert params == (DATE_START, DATE_END, YOIL_FRI, 12, DONG_GANGNAM)

    def test_grid_uses_raw_grid_col(self):
        sql, params = build_trend_same_weekday_sql(
            "grid", GRID_GANGNAM, DATE_START, DATE_END, YOIL_FRI, ALL_HOURS, METRIC_TOTAL
        )
        n = _norm(sql)
        assert "`250M격자` = %s" in n
        assert "`격자코드`" not in n

    def test_yoil_must_be_int(self):
        """요일이 정수가 아니면 ValueError (인젝션 방지)."""
        with pytest.raises(ValueError):
            build_trend_same_weekday_sql(
                "dong", DONG_GANGNAM, DATE_START, DATE_END, "4", [0], METRIC_TOTAL
            )

    def test_bad_gu_code_raises(self):
        with pytest.raises(ValueError):
            build_trend_same_weekday_sql(
                "gu", "abcde", DATE_START, DATE_END, YOIL_FRI, [0], METRIC_TOTAL
            )


# ═════════════════════════════════════════════════════════════════════════════
# 5h. week_trend_day_count_sql — 날짜창 내 연주별 일수 (∩ _적재로그)
# ═════════════════════════════════════════════════════════════════════════════
class TestWeekTrendDayCountStructure:
    def test_structure(self):
        sql, params = week_trend_day_count_sql(DATE_START, DATE_END, "주중")
        n = _norm(sql)
        assert "d.`연주` AS 연주" in n
        assert "COUNT(*) AS 일수" in n
        assert "FROM `달력` d" in n
        assert "d.`일자` >= %s AND d.`일자` <= %s" in n
        assert "d.`주중주말` IN (%s)" in n
        assert "EXISTS" in n and "`_적재로그`" in n
        assert "GROUP BY d.`연주`" in n
        assert params == (DATE_START, DATE_END, "주중")

    def test_jeonche_two_params(self):
        sql, params = week_trend_day_count_sql(DATE_START, DATE_END, "전체")
        assert "d.`주중주말` IN (%s,%s)" in _norm(sql)
        assert params == (DATE_START, DATE_END, "주중", "주말")


# ═════════════════════════════════════════════════════════════════════════════
# 6. day_count_sql — 일수 (∩ _적재로그)
# ═════════════════════════════════════════════════════════════════════════════
class TestDayCountStructure:
    def test_month_structure(self):
        sql, params = day_count_sql("month", YEONWOL, "주중")
        n = _norm(sql)
        assert "FROM `달력`" in n
        assert "`연월`=%s" in n.replace(" =", "=").replace("= ", "=") or "`연월` = %s" in n
        assert "`주중주말` IN (%s)" in n
        assert "EXISTS" in n
        assert "`_적재로그`" in n
        assert params == (YEONWOL, "주중")

    def test_week_structure(self):
        sql, params = day_count_sql("week", YEONJU, "전체")
        n = _norm(sql)
        assert "`연주`=%s" in n.replace(" =", "=").replace("= ", "=") or "`연주` = %s" in n
        assert "`주중주말` IN (%s,%s)" in n
        assert params == (YEONJU, "주중", "주말")

    def test_day_mode_returns_none(self):
        """day 모드는 일평균 개념 없음 → (None, ())."""
        sql, params = day_count_sql("day", LOADED_DAY, "전체")
        assert sql is None
        assert params == ()

    def test_invalid_mode_raises(self):
        with pytest.raises(ValueError):
            day_count_sql("year", YEONWOL, "전체")

    def test_invalid_weekday_raises(self):
        with pytest.raises(ValueError):
            day_count_sql("month", YEONWOL, "평일")


# ═════════════════════════════════════════════════════════════════════════════
# 7. 인젝션 안전 — 사용자 값은 %s 바인딩만, 문자열 보간 금지
# ═════════════════════════════════════════════════════════════════════════════
class TestInjectionSafety:
    def test_month_user_values_not_interpolated(self):
        """연월/동코드 같은 사용자 값이 SQL 문자열에 직접 박히지 않음."""
        sql, params = build_month_sql(
            "grid", YEONWOL, None, DONG_GANGNAM, [6, 7], "주중", METRIC_TOTAL
        )
        assert YEONWOL not in sql       # 연월은 %s 로만
        assert DONG_GANGNAM not in sql  # 동코드는 %s 로만
        assert "6" not in sql.replace("LEFT(`행정동코드`,5)", "")  # 시간값 보간 안 됨
        # 모든 사용자 값은 params 에 존재
        assert YEONWOL in params and DONG_GANGNAM in params

    def test_week_user_values_not_interpolated(self):
        sql, _ = build_week_sql(
            "dong", YEONJU, GU_GANGNAM, None, [9], "주중", METRIC_TOTAL
        )
        assert YEONJU not in sql
        assert GU_GANGNAM not in sql

    def test_day_user_values_not_interpolated(self):
        sql, _ = build_day_sql("dong", LOADED_DAY, GU_GANGNAM, None, METRIC_TOTAL)
        assert LOADED_DAY not in sql
        assert GU_GANGNAM not in sql


# ═════════════════════════════════════════════════════════════════════════════
# 8. 라이브 DB 실행 — 생성 SQL 이 실제로 돌고 합리적 결과를 내는지 증명
# ═════════════════════════════════════════════════════════════════════════════
class TestLiveMonth:
    def test_gu_month_25_rows_gangnam_top(self):
        """월 구별: 25개 구, 각 code 5자리 & 합계>0, 강남 11680 최상위권."""
        sql, params = build_month_sql(
            "gu", YEONWOL, None, None, [6, 7, 8], "주중", METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        assert len(rows) == 25, f"서울 25개 구 기대, 실제 {len(rows)}"
        for r in rows:
            assert len(r["code"]) == 5, f"구코드 5자리 기대: {r['code']}"
            assert float(r["합계"]) > 0, f"합계>0 기대: {r}"
        top = max(rows, key=lambda r: float(r["합계"]))
        assert top["code"] == "11680", f"강남 11680 최상위 기대, 실제 {top['code']}"

    def test_dong_month_scope_all_gangnam(self):
        """월 동별 + 강남 스코프: 모든 code 가 '11680' 으로 시작 (범위 비교)."""
        sql, params = build_month_sql(
            "dong", YEONWOL, GU_GANGNAM, None, ALL_HOURS, "전체", METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        assert len(rows) > 0
        for r in rows:
            assert r["code"].startswith("11680"), f"강남 외 동 발견: {r['code']}"

    def test_grid_month_dong_scope(self):
        """월 격자별 + 동 스코프: 격자 다수, 합계>0."""
        sql, params = build_month_sql(
            "grid", YEONWOL, None, DONG_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        assert len(rows) > 0, "격자 행이 없습니다"
        assert any(float(r["합계"]) > 0 for r in rows)

    def test_grid_month_gu_scope_many(self):
        """월 격자별 + 구 스코프 (A-2): 강남 전체 격자 다수."""
        sql, params = build_month_sql(
            "grid", YEONWOL, GU_GANGNAM, None, ALL_HOURS, "전체", METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        # 강남구 격자는 동별 격자보다 훨씬 많아야 함
        assert len(rows) > 50, f"구 전체 격자 다수 기대, 실제 {len(rows)}"


class TestLiveWeek:
    def test_gu_week_rows_gangnam_top(self):
        """주 구별: 25개 구 근접, 강남 11680 최상위권 (raw + 달력 프루닝)."""
        sql, params = build_week_sql(
            "gu", YEONJU, None, None, list(range(6, 23)), "주중", METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        assert len(rows) == 25, f"25개 구 기대, 실제 {len(rows)}"
        top = max(rows, key=lambda r: float(r["합계"]))
        assert top["code"] == "11680", f"강남 11680 최상위 기대, 실제 {top['code']}"

    def test_grid_week_runs_small(self):
        """주 격자별 + 동 스코프: raw 250M격자 사용, 실행 + 행 반환."""
        sql, params = build_week_sql(
            "grid", YEONJU, None, DONG_GANGNAM, [12], "주중", METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        assert len(rows) > 0, "주+격자 행이 없습니다"


class TestLiveDay:
    def test_gu_day_hourly_timeseries(self):
        """일 구별: 시간별 그룹 — 24시간 × 25구 = 600행, 시간 오름차순."""
        sql, params = build_day_sql("gu", LOADED_DAY, None, None, METRIC_TOTAL)
        rows = db.fetch_all(sql, params)
        hours = sorted({r["시간"] for r in rows})
        codes = {r["code"] for r in rows}
        assert len(codes) == 25, f"25개 구 기대, 실제 {len(codes)}"
        assert hours == list(range(24)), f"24시간 기대, 실제 {hours}"
        # ORDER BY 시간 — 반환 순서가 비내림차순
        seq = [r["시간"] for r in rows]
        assert seq == sorted(seq), "시간 오름차순 정렬이 아닙니다"


class TestLiveTrend:
    def test_gu_trend_ordered_multi_month(self):
        """구 추이: 여러 연월 행, 연월 오름차순, 합계>0."""
        sql, params = build_trend_sql("gu", GU_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL)
        rows = db.fetch_all(sql, params)
        assert len(rows) > 1, f"여러 연월 기대, 실제 {len(rows)}"
        yms = [str(r["연월"]) for r in rows]
        assert yms == sorted(yms), f"연월 오름차순 아님: {yms}"
        for r in rows:
            assert float(r["합계"]) > 0, f"합계>0 기대: {r}"

    def test_gu_ge_dong_same_month(self):
        """같은 연월: 구 합계 ≥ 소속 동 합계."""
        gu_rows = db.fetch_all(
            *build_trend_sql("gu", GU_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL)
        )
        dong_rows = db.fetch_all(
            *build_trend_sql("dong", DONG_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL)
        )
        gu_map = {str(r["연월"]): float(r["합계"]) for r in gu_rows}
        dong_map = {str(r["연월"]): float(r["합계"]) for r in dong_rows}
        common = set(gu_map) & set(dong_map)
        assert common, "공통 연월 없음"
        for ym in common:
            assert gu_map[ym] >= dong_map[ym], f"{ym}: 구<동"

    def test_grid_trend_runs(self):
        """격자 추이: 실제 격자코드로 실행되고 행 반환."""
        sql, params = build_trend_sql(
            "grid", GRID_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        assert len(rows) > 0, "격자 추이 행이 없습니다"


class TestLiveTrendDayCount:
    def test_count_map_matches_day_count_sql(self):
        """trend_day_count_sql 의 연월별 일수가 day_count_sql 단건과 일치해야 한다."""
        rows = db.fetch_all(*trend_day_count_sql("주중"))
        mp = {str(r["연월"]): int(r["일수"]) for r in rows}
        # 202506 주중 = 20 (day_count_sql 라이브 사실과 일치)
        assert mp.get(YEONWOL) == 20, f"202506 주중 20 기대, 실제 {mp.get(YEONWOL)}"
        # 202401 전체 = 31
        full = db.fetch_all(*trend_day_count_sql("전체"))
        full_map = {str(r["연월"]): int(r["일수"]) for r in full}
        assert full_map.get(YEONWOL_FULL) == 31, (
            f"202401 전체 31 기대, 실제 {full_map.get(YEONWOL_FULL)}"
        )


class TestLiveTrendWeekDay:
    """주/일 추이 builder 의 라이브 실행 + 성능 (날짜창 + 단일 코드 → 인덱스).

    raw(생활인구_250m)는 수억 행이므로 날짜창 없이 코드만 필터하면 풀스캔.
    날짜창([DATE_START, DATE_END]) + 코드 → ix_일자/복합인덱스로 수초 내 완료해야 함.
    """
    import time as _time

    def test_week_dong_runs_fast(self):
        import time
        sql, params = build_trend_week_sql(
            "dong", DONG_GANGNAM, DATE_START, DATE_END, ALL_HOURS, "전체", METRIC_TOTAL
        )
        t0 = time.time()
        rows = db.fetch_all(sql, params)
        elapsed = time.time() - t0
        assert len(rows) > 0, "주 추이 행이 없습니다"
        # 연주 오름차순, 합계>0
        yjs = [str(r["연주"]) for r in rows]
        assert yjs == sorted(yjs)
        for r in rows:
            assert float(r["합계"]) > 0
        assert elapsed < 15, f"주 추이 너무 느림: {elapsed:.1f}s (인덱스 확인 필요)"

    def test_day_recent_grid_runs_fast(self):
        import time
        sql, params = build_trend_day_sql(
            "grid", GRID_GANGNAM, DATE_START, DATE_END, ALL_HOURS, "전체", METRIC_TOTAL
        )
        t0 = time.time()
        rows = db.fetch_all(sql, params)
        elapsed = time.time() - t0
        assert len(rows) > 0, "일 추이(격자) 행이 없습니다"
        days = [str(r["일자"]) for r in rows]
        assert days == sorted(days)
        assert elapsed < 15, f"일 추이 너무 느림: {elapsed:.1f}s (인덱스 확인 필요)"

    def test_same_weekday_dong_all_fridays(self):
        """동일요일(금=4) 추이: 반환 일자가 모두 7일 간격(같은 요일)."""
        import datetime
        sql, params = build_trend_same_weekday_sql(
            "dong", DONG_GANGNAM, DATE_START, DATE_END, YOIL_FRI, ALL_HOURS, METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        assert len(rows) > 0, "동일요일 추이 행이 없습니다"
        end = datetime.date.fromisoformat(DATE_END)
        for r in rows:
            d = r["일자"]
            d = d if isinstance(d, datetime.date) else datetime.date.fromisoformat(str(d))
            assert (end - d).days % 7 == 0, f"{d} 는 {DATE_END} 와 다른 요일"

    def test_week_gu_ge_dong(self):
        """같은 연주: 구 합계 ≥ 동 합계."""
        gu = db.fetch_all(*build_trend_week_sql(
            "gu", GU_GANGNAM, DATE_START, DATE_END, ALL_HOURS, "전체", METRIC_TOTAL))
        dong = db.fetch_all(*build_trend_week_sql(
            "dong", DONG_GANGNAM, DATE_START, DATE_END, ALL_HOURS, "전체", METRIC_TOTAL))
        gu_map = {str(r["연주"]): float(r["합계"]) for r in gu}
        dong_map = {str(r["연주"]): float(r["합계"]) for r in dong}
        common = set(gu_map) & set(dong_map)
        assert common, "공통 연주 없음"
        for wk in common:
            assert gu_map[wk] >= dong_map[wk], f"{wk}: 구<동"

    def test_week_day_count_matches_raw_weeks(self):
        """week_trend_day_count_sql 연주가 주 추이 연주를 포함한다 (일수>0)."""
        wk_rows = db.fetch_all(*build_trend_week_sql(
            "dong", DONG_GANGNAM, DATE_START, DATE_END, ALL_HOURS, "전체", METRIC_TOTAL))
        dc_rows = db.fetch_all(*week_trend_day_count_sql(DATE_START, DATE_END, "전체"))
        dc_map = {str(r["연주"]): int(r["일수"]) for r in dc_rows}
        for r in wk_rows:
            yj = str(r["연주"])
            assert dc_map.get(yj, 0) > 0, f"{yj} 일수 누락"


class TestLiveGridDongColumn:
    def test_grid_dong_scope_carries_correct_dong(self):
        """grid + dong 스코프: 결과 모든 행의 행정동코드가 그 동과 같다."""
        sql, params = build_month_sql(
            "grid", YEONWOL, None, DONG_GANGNAM, ALL_HOURS, "전체", METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        assert len(rows) > 0
        for r in rows:
            assert "행정동코드" in r, f"행정동코드 컬럼 없음: {list(r.keys())}"
            assert str(r["행정동코드"]) == DONG_GANGNAM, (
                f"동 스코프 격자의 행정동코드 불일치: {r['행정동코드']}"
            )

    def test_gu_scope_has_no_dong_column(self):
        """gu level 결과에는 행정동코드 컬럼이 없어야 한다."""
        sql, params = build_month_sql(
            "gu", YEONWOL, None, None, ALL_HOURS, "전체", METRIC_TOTAL
        )
        rows = db.fetch_all(sql, params)
        assert rows
        assert "행정동코드" not in rows[0], (
            f"gu 결과에 행정동코드 컬럼 존재: {list(rows[0].keys())}"
        )


class TestLiveDayCount:
    def test_month_jeonche_full(self):
        """202506(2025년 6월) 전체 적재일수 = 30 (전부 적재)."""
        sql, params = day_count_sql("month", YEONWOL, "전체")
        row = db.fetch_one(sql, params)
        assert row["일수"] == 30, f"202506 전체 30일 기대, 실제 {row['일수']}"

    def test_month_jungju(self):
        """202506 주중 적재일수 = 20."""
        sql, params = day_count_sql("month", YEONWOL, "주중")
        row = db.fetch_one(sql, params)
        assert row["일수"] == 20, f"202506 주중 20일 기대, 실제 {row['일수']}"

    def test_month_202401_full_31(self):
        """202401(2024년 1월) 전체 적재일수 = 31 (완전 적재)."""
        sql, params = day_count_sql("month", YEONWOL_FULL, "전체")
        row = db.fetch_one(sql, params)
        assert row["일수"] == 31, f"202401 전체 31일 기대, 실제 {row['일수']}"

    def test_week_jungju_small(self):
        """주 모드 (2025-23, 주중): 적재일수가 작고 양수 (≤5)."""
        sql, params = day_count_sql("week", YEONJU, "주중")
        row = db.fetch_one(sql, params)
        assert 0 < row["일수"] <= 5, f"주 적재일수 비정상: {row['일수']}"

    def test_day_mode_none(self):
        """day 모드는 None — 실행 대상 아님."""
        sql, params = day_count_sql("day", LOADED_DAY, "전체")
        assert sql is None
