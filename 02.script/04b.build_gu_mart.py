# -*- coding: utf-8 -*-
"""04b.build_gu_mart.py — 구-월 요약 마트 (마트_구_월_시간). 전체 구 추이 가속용.

마트_월_시간(격자 grain, ~15.7M행)을 구×연월×주중주말×시간으로 미리 합쳐
25 × 30 × 2 × 24 ≈ 36K행으로 줄인다. /api/query/trend_all_gu(month) 가 이 작은 표를
조회 → 전체 구 집계도 즉시 응답(+ 모든 필터 그대로 반영). 단일 영역 추이는 코드로
인덱스 좁혀 빠르지만, 25개 구 전체는 좁힐 코드가 없어 마트 전체를 스캔(120s+)하므로
이 요약이 필요하다.

재실행이 곧 갱신(DROP 후 재빌드, 마트 1회 GROUP BY ~2분). 04.build_mart 갱신 후 같이 돌리면 됨.
  python 04b.build_gu_mart.py
"""
import importlib.util
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

GU_MART = "마트_구_월_시간"
SRC = "마트_월_시간"


def load_ingest():
    p = Path(__file__).resolve().parent / "00.input_data.py"
    spec = importlib.util.spec_from_file_location("ingest", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ing = load_ingest()
    measures = ing.COL_NAMES[ing.N_KEY_COLS:]  # 생활인구합계 + 28 (격자/시간 grain 측정값)
    conn = ing.connect(ing.load_db_config(), with_db=True)
    cur = conn.cursor()
    for s in (
        "SET SESSION tmp_table_size = 536870912",
        "SET SESSION max_heap_table_size = 536870912",
        "SET SESSION sort_buffer_size = 134217728",
    ):
        try:
            cur.execute(s)
        except Exception:
            pass

    cur.execute(f"DROP TABLE IF EXISTS `{GU_MART}`")
    mcols = ",\n".join(f"  `{m}` DECIMAL(15,2) NULL" for m in measures)
    cur.execute(f"""CREATE TABLE `{GU_MART}` (
        `구코드` CHAR(5) NOT NULL,
        `연월` CHAR(6) NOT NULL,
        `주중주말` VARCHAR(4) NOT NULL,
        `시간` TINYINT UNSIGNED NOT NULL,
{mcols},
        PRIMARY KEY (`구코드`,`연월`,`주중주말`,`시간`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")

    sel = ",".join(f"SUM(`{m}`)" for m in measures)
    cols = ",".join(f"`{m}`" for m in measures)
    print(f"▶ {GU_MART} 집계 (마트 전체 1회 GROUP BY — 수 분 소요)…", flush=True)
    t0 = time.time()
    cur.execute(f"""INSERT INTO `{GU_MART}`
        (`구코드`,`연월`,`주중주말`,`시간`,{cols})
        SELECT LEFT(`행정동코드`,5), `연월`, `주중주말`, `시간`, {sel}
        FROM `{SRC}`
        GROUP BY LEFT(`행정동코드`,5), `연월`, `주중주말`, `시간`""")
    conn.commit()
    cur.execute(f"SELECT COUNT(*) FROM `{GU_MART}`")
    tot = cur.fetchone()[0]
    cur.close()
    conn.close()
    print(f"✅ {GU_MART} 완료: {tot:,}행 ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
