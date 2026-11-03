# -*- coding: utf-8 -*-
"""db.py — DB 접근 레이어 (서울 생활인구 GIS 백엔드).

단일 책임: shin_project MySQL 연결 + 조회 헬퍼.
- 연결 설정은 00.input_data.py 의 load_db_config / connect 를 재사용 (DRY).
- 00.input_data.py 는 파일명이 숫자로 시작하므로 importlib 으로 동적 로드.
- per-request 연결 방식 (pool 없음) — 현 단계 스펙.
"""
import importlib.util
from pathlib import Path

# ──────────────────────────────────────────────────────────────────────────────
# 00.input_data 모듈 로드 (importlib — 파일명 숫자 시작으로 직접 import 불가)
# ──────────────────────────────────────────────────────────────────────────────
_INGEST_PATH = Path(__file__).resolve().parent.parent / "00.input_data.py"

_spec = importlib.util.spec_from_file_location("ingest", _INGEST_PATH)
_ingest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ingest)

# 재사용 공개 심볼
load_db_config = _ingest.load_db_config  # () -> dict
connect = _ingest.connect                # (cfg, *, with_db) -> connection
DB_NAME = _ingest.DB_NAME               # "shin_project"


# ──────────────────────────────────────────────────────────────────────────────
# 공개 API
# ──────────────────────────────────────────────────────────────────────────────
def get_conn():
    """shin_project 연결 1개를 반환한다. 호출자가 close() 해야 한다."""
    return connect(load_db_config(), with_db=True)


def fetch_all(sql: str, params: tuple = ()) -> list[dict]:
    """SQL 실행 → 전체 행을 dict 리스트로 반환.

    컬럼명은 MySQL 원본 그대로(한글 포함). 연결은 항상 닫힌다.
    """
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, params)
        rows = cur.fetchall()
        cur.close()
        return rows
    finally:
        conn.close()


def fetch_one(sql: str, params: tuple = ()) -> dict | None:
    """SQL 실행 → 첫 번째 행을 dict 로 반환. 결과 없으면 None."""
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, params)
        row = cur.fetchone()
        cur.close()
        return row
    finally:
        conn.close()
