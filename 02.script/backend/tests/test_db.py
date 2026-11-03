# -*- coding: utf-8 -*-
"""test_db.py — DB 레이어 통합 테스트 (실 DB 대상).

실행:
  cd 02.script/backend
  python -m pytest tests/test_db.py -v

의존성: pip install pytest
"""
import sys
from pathlib import Path

# backend/ 를 sys.path 에 추가 — pytest 실행 위치에 무관하게 db.py 임포트 가능하게
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db


class TestFetchOne:
    def test_mart_count_positive(self):
        """마트_월_시간 행 수가 0보다 크다 (~15.7M 기대)."""
        row = db.fetch_one("SELECT COUNT(*) AS n FROM `마트_월_시간`")
        assert row is not None, "fetch_one 이 None 을 반환했습니다"
        assert isinstance(row, dict), "반환 타입이 dict 여야 합니다"
        assert "n" in row, f"결과 키에 'n' 이 없습니다: {row}"
        assert row["n"] > 0, f"행 수가 0 이하입니다: {row['n']}"

    def test_returns_dict_or_none(self):
        """존재하지 않는 조건으로 조회하면 None 을 반환한다."""
        row = db.fetch_one(
            "SELECT 1 AS x FROM `공간_시군구` WHERE `구코드` = %s",
            ("XXXXXXXXXX",),
        )
        assert row is None, f"없는 행에서 None 이 아닌 값을 반환했습니다: {row}"


class TestFetchAll:
    def test_gong_gan_sigungu_rows_and_keys(self):
        """공간_시군구 테이블 조회: 25개 구, 구코드/구명 컬럼 포함."""
        rows = db.fetch_all("SELECT * FROM `공간_시군구`")
        assert isinstance(rows, list), "fetch_all 은 list 를 반환해야 합니다"
        assert len(rows) == 25, f"서울 자치구는 25개여야 합니다. 실제: {len(rows)}"
        first = rows[0]
        assert isinstance(first, dict), "각 행은 dict 여야 합니다"
        for key in ("구코드", "구명"):
            assert key in first, f"필수 키 '{key}' 가 없습니다. 실제 키: {list(first.keys())}"

    def test_fetch_all_with_params(self):
        """파라미터 바인딩 동작 확인: 특정 구코드로 필터."""
        rows = db.fetch_all(
            "SELECT `구코드`, `구명` FROM `공간_시군구` LIMIT %s",
            (3,),
        )
        assert isinstance(rows, list)
        assert 1 <= len(rows) <= 3
