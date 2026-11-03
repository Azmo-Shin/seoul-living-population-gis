# -*- coding: utf-8 -*-
"""_build_trend_idx.py — 일회성: 마트_월_시간 추이용 인덱스 생성.

추이 쿼리(단일 코드 필터 + GROUP BY 연월)를 위해 코드 컬럼 복합 인덱스를 추가.
  - ix_행정동코드_연월 (행정동코드, 연월)  : dong 동등 + gu 범위 필터, GROUP BY 연월 정렬
  - ix_격자코드_연월   (격자코드, 연월)    : grid 동등 필터, GROUP BY 연월 정렬

비파괴(ADD INDEX only). 이미 있으면 skip. 넉넉한 lock_wait/timeout.
backend/ 에서 실행: python _build_trend_idx.py
"""
import io
import sys
import time
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import db

MART = "마트_월_시간"
INDEXES = [
    ("ix_행정동코드_연월", ["행정동코드", "연월"]),
    ("ix_격자코드_연월", ["격자코드", "연월"]),
]


def existing_indexes(cur):
    cur.execute(f"SHOW INDEX FROM `{MART}`")
    return {r[2] for r in cur.fetchall()}  # Key_name col


def main():
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        # 넉넉한 대기/타임아웃 (대용량 ALTER)
        for stmt in (
            "SET SESSION innodb_lock_wait_timeout = 600",
            "SET SESSION lock_wait_timeout = 600",
        ):
            try:
                cur.execute(stmt)
            except Exception as e:
                print(f"  (skip session var: {e})")

        have = existing_indexes(cur)
        print(f"기존 인덱스: {sorted(have)}")

        for name, cols in INDEXES:
            if name in have:
                print(f"  [skip] {name} 이미 존재")
                continue
            col_sql = ", ".join(f"`{c}`" for c in cols)
            print(f"  [build] {name} ({col_sql}) … 대용량이면 수 분 소요")
            t0 = time.time()
            cur.execute(f"ALTER TABLE `{MART}` ADD INDEX `{name}` ({col_sql})")
            conn.commit()
            print(f"    완료 {time.time()-t0:.1f}s")

        print("\n최종 인덱스:")
        cur.execute(f"SHOW INDEX FROM `{MART}`")
        for r in cur.fetchall():
            print(f"  {r[2]:22s} seq={r[3]} col={r[4]}")
        cur.close()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
