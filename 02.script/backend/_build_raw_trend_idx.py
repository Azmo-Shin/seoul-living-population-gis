# -*- coding: utf-8 -*-
"""_build_raw_trend_idx.py — 일회성: 생활인구_250m 추이용 복합 인덱스 생성.

추이 week/day 모드(POST /api/query/trend, mode=week|day)는 원천을 **단일 코드 +
최근 날짜창**으로 좁힌다. ix_일자 만으로는 날짜창 파티션 안 모든 격자를 훑어 느리다.
코드 컬럼 선두 복합 인덱스를 추가하면 코드 ref + 일자 레인지 스캔을 탄다.
  - ix_행정동코드_일자 (행정동코드, 일자) : dong 동등 / gu 접두범위 + 일자 레인지
  - ix_250M격자_일자   (250M격자, 일자)   : grid 동등 + 일자 레인지

비파괴(ADD INDEX only). 이미 있으면 skip. 넉넉한 lock_wait/timeout.
원천은 수억 행이라 인덱스당 수~수십 분 소요될 수 있다.
backend/ 에서 실행: python _build_raw_trend_idx.py
"""
import io
import sys
import time
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import db

RAW = "생활인구_250m"
INDEXES = [
    ("ix_행정동코드_일자", ["행정동코드", "일자"]),
    ("ix_250M격자_일자", ["250M격자", "일자"]),
]


def existing_indexes(cur):
    cur.execute(f"SHOW INDEX FROM `{RAW}`")
    return {r[2] for r in cur.fetchall()}  # Key_name col


def main():
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        # 넉넉한 대기/타임아웃 (대용량 ALTER)
        for stmt in (
            "SET SESSION innodb_lock_wait_timeout = 3600",
            "SET SESSION lock_wait_timeout = 3600",
        ):
            try:
                cur.execute(stmt)
            except Exception as e:
                print(f"  (skip session var: {e})", flush=True)

        have = existing_indexes(cur)
        print(f"기존 인덱스: {sorted(have)}", flush=True)

        for name, cols in INDEXES:
            if name in have:
                print(f"  [skip] {name} 이미 존재", flush=True)
                continue
            col_sql = ", ".join(f"`{c}`" for c in cols)
            print(f"  [build] {name} ({col_sql}) … 대용량이면 수~수십 분 소요", flush=True)
            t0 = time.time()
            cur.execute(f"ALTER TABLE `{RAW}` ADD INDEX `{name}` ({col_sql})")
            conn.commit()
            print(f"    완료 {time.time()-t0:.1f}s", flush=True)

        print("\n최종 인덱스:", flush=True)
        cur.execute(f"SHOW INDEX FROM `{RAW}`")
        for r in cur.fetchall():
            print(f"  {r[2]:22s} seq={r[3]} col={r[4]}", flush=True)
        cur.close()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
