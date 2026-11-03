# -*- coding: utf-8 -*-
"""test_metrics.py — services/metrics.py TDD 테스트 (Red → Green).

실행:
  cd 02.script/backend
  python -m pytest tests/test_metrics.py -v

의존성: pytest (+ db 레이어는 live-schema 테스트에서 사용)
"""
import sys
from pathlib import Path

# backend/ 를 sys.path 에 추가
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from services.metrics import metric_expr
from config import AGE_BUCKETS


# ─────────────────────────────────────────────────────────────────────────────
# 1. 전체 + 전체 연령 → 마트 합계 컬럼
# ─────────────────────────────────────────────────────────────────────────────
class TestTotalColumn:
    def test_total_sex_total_age(self):
        """sex=전체, ages=[] → 생활인구합계 COALESCE-SUM."""
        result = metric_expr("전체", [])
        assert result == "COALESCE(SUM(`생활인구합계`),0)"


# ─────────────────────────────────────────────────────────────────────────────
# 2. 단일 성별 × 단일 버킷
# ─────────────────────────────────────────────────────────────────────────────
class TestSingleSexSingleBucket:
    def test_male_20s(self):
        """sex=남, ages=[20대] → 남자 20~24세, 남자 25~29세 두 항."""
        result = metric_expr("남", ["20대"])
        expected = (
            "(COALESCE(SUM(`남자 20~24세`),0)"
            " + COALESCE(SUM(`남자 25~29세`),0))"
        )
        assert result == expected

    def test_female_0s(self):
        """sex=여, ages=[0대] → 여자 0~9세 단일 항 (단항이어도 괄호+COALESCE)."""
        result = metric_expr("여", ["0대"])
        expected = "(COALESCE(SUM(`여자 0~9세`),0))"
        assert result == expected

    def test_male_70s(self):
        """sex=남, ages=[70대이상] → 남자 70세 이상 단일 항."""
        result = metric_expr("남", ["70대이상"])
        expected = "(COALESCE(SUM(`남자 70세 이상`),0))"
        assert result == expected


# ─────────────────────────────────────────────────────────────────────────────
# 3. 전체 성별 × 단일 버킷 → 4개 컬럼 (남자 먼저, 여자 다음)
# ─────────────────────────────────────────────────────────────────────────────
class TestBothSexSingleBucket:
    def test_total_20s_four_cols(self):
        """sex=전체, ages=[20대] → 남자 20~24, 남자 25~29, 여자 20~24, 여자 25~29."""
        result = metric_expr("전체", ["20대"])
        expected = (
            "(COALESCE(SUM(`남자 20~24세`),0)"
            " + COALESCE(SUM(`남자 25~29세`),0)"
            " + COALESCE(SUM(`여자 20~24세`),0)"
            " + COALESCE(SUM(`여자 25~29세`),0))"
        )
        assert result == expected

    def test_total_20s_contains_four_coalesce(self):
        """전체+20대 결과에 COALESCE 항이 정확히 4개."""
        result = metric_expr("전체", ["20대"])
        assert result.count("COALESCE") == 4


# ─────────────────────────────────────────────────────────────────────────────
# 4. 여성 전체 연령 → 14개 컬럼, 정규 순서
# ─────────────────────────────────────────────────────────────────────────────
class TestFemaleAllAges:
    def test_female_all_ages_count(self):
        """sex=여, ages=[] → COALESCE 항 정확히 14개."""
        result = metric_expr("여", [])
        assert result.count("COALESCE") == 14

    def test_female_all_ages_first_col(self):
        """여자 0~9세 가 포함된다."""
        result = metric_expr("여", [])
        assert "`여자 0~9세`" in result

    def test_female_all_ages_last_col(self):
        """여자 70세 이상 가 포함된다."""
        result = metric_expr("여", [])
        assert "`여자 70세 이상`" in result

    def test_female_all_ages_canonical_order(self):
        """컬럼이 AGE_BUCKETS 정규 순서(0~9세 → 70세 이상)로 나타난다."""
        result = metric_expr("여", [])
        # 모든 원자 연령 레이블을 정규 순서로 추출
        all_atomic: list[str] = []
        for labels in AGE_BUCKETS.values():
            all_atomic.extend(labels)
        positions = [result.index(f"`여자 {a}`") for a in all_atomic]
        assert positions == sorted(positions), "컬럼 순서가 정규 순서와 다릅니다"

    def test_female_all_ages_no_남자(self):
        """여자 전체에는 남자 컬럼이 없다."""
        result = metric_expr("여", [])
        assert "남자" not in result


# ─────────────────────────────────────────────────────────────────────────────
# 5. 유효성 검사 — ValueError
# ─────────────────────────────────────────────────────────────────────────────
class TestValidation:
    def test_invalid_sex_raises(self):
        """sex 가 전체/남/여 외 값 → ValueError."""
        with pytest.raises(ValueError):
            metric_expr("0대", [])

    def test_invalid_sex_english_raises(self):
        """sex='M' → ValueError."""
        with pytest.raises(ValueError):
            metric_expr("M", [])

    def test_invalid_age_raises(self):
        """존재하지 않는 연령 버킷 → ValueError."""
        with pytest.raises(ValueError):
            metric_expr("남", ["99대"])

    def test_invalid_age_partial_raises(self):
        """유효한 버킷과 섞여도 무효 버킷이 있으면 ValueError."""
        with pytest.raises(ValueError):
            metric_expr("남", ["20대", "없는버킷"])


# ─────────────────────────────────────────────────────────────────────────────
# 6. NULL 안전 설계: SUM(a + b) 패턴 사용 금지 확인
# ─────────────────────────────────────────────────────────────────────────────
class TestNullSafety:
    def test_no_row_wise_sum(self):
        """SUM(col1 + col2) 패턴이 없어야 한다 — NULL 전파 위험."""
        result = metric_expr("전체", ["20대"])
        # SUM(...) 다음에 바로 닫힌 후 다른 컬럼이 더해지는 패턴이 없어야 함
        # 즉 SUM 안에 ` + ` 가 없어야 함
        import re
        # SUM(`...` + ...) 형태 검출
        bad_pattern = re.compile(r"SUM\(`[^`]+`\s*\+")
        assert not bad_pattern.search(result), (
            "SUM(col + ...) 패턴 발견 — NULL 전파 위험"
        )

    def test_each_col_has_own_coalesce(self):
        """각 컬럼이 독립된 COALESCE(SUM(`col`),0)으로 묶인다."""
        result = metric_expr("남", ["20대"])
        # 두 컬럼 각각 독립 COALESCE 확인
        assert "COALESCE(SUM(`남자 20~24세`),0)" in result
        assert "COALESCE(SUM(`남자 25~29세`),0)" in result


# ─────────────────────────────────────────────────────────────────────────────
# 7. 라이브 스키마 검증 — 생성된 컬럼명이 실제 마트 테이블에 존재하는지 확인
# ─────────────────────────────────────────────────────────────────────────────
class TestLiveSchemaColumnNames:
    """실 DB에 연결해 마트_월_시간 컬럼 목록을 가져온 뒤,
    metric_expr 가 생성하는 모든 컬럼명이 실제로 존재하는지 검증한다.
    컬럼명 오타를 조기에 잡기 위한 통합 테스트."""

    @pytest.fixture(scope="class")
    def mart_columns(self):
        """마트_월_시간 의 실제 컬럼명 집합 (LIMIT 0 으로 빠르게 조회)."""
        import db
        conn = db.get_conn()
        try:
            cur = conn.cursor()
            cur.execute("SELECT * FROM `마트_월_시간` LIMIT 0")
            cols = {desc[0] for desc in cur.description}
            cur.fetchall()  # mysql-connector: 미소비 결과 flush 필수
            cur.close()
            return cols
        finally:
            conn.close()

    def _extract_col_names(self, expr: str) -> list[str]:
        """expr 에서 백틱으로 둘러싸인 컬럼명을 추출한다."""
        import re
        return re.findall(r"`([^`]+)`", expr)

    def test_male_20s_cols_exist(self, mart_columns):
        expr = metric_expr("남", ["20대"])
        for col in self._extract_col_names(expr):
            assert col in mart_columns, f"컬럼 '{col}' 이 마트_월_시간 에 없습니다"

    def test_female_all_cols_exist(self, mart_columns):
        expr = metric_expr("여", [])
        for col in self._extract_col_names(expr):
            assert col in mart_columns, f"컬럼 '{col}' 이 마트_월_시간 에 없습니다"

    def test_total_total_col_exists(self, mart_columns):
        expr = metric_expr("전체", [])
        for col in self._extract_col_names(expr):
            assert col in mart_columns, f"컬럼 '{col}' 이 마트_월_시간 에 없습니다"

    def test_total_multi_bucket_cols_exist(self, mart_columns):
        """전체 성별 × 복수 버킷의 컬럼이 모두 마트에 존재."""
        expr = metric_expr("전체", ["10대", "20대", "30대"])
        cols = self._extract_col_names(expr)
        # 10대(×2) + 20대(×2) + 30대(×2) × 남/여 = 12컬럼
        assert len(cols) == 12, f"컬럼 수 12 기대, 실제 {len(cols)}: {cols}"
        for col in cols:
            assert col in mart_columns, f"컬럼 '{col}' 이 마트_월_시간 에 없습니다"
