# -*- coding: utf-8 -*-
"""04c.build_gu_day_mart.py — 구-일 요약 마트 (마트_구_일_시간). 주/일 전체 구 추이 가속용.

원천(생활인구_250m, 수억 행)을 구×일자×시간으로 미리 합쳐 25 × ~880일 × 24 ≈ 530K행.
주(週) 추이 = 이 표 JOIN 달력(연주/주중주말), 일(日) 추이 = 이 표 일자창 — 둘 다 즉시.
전체 구 주/일 추이는 좁힐 코드가 없어 raw 전체 스캔(120s+)이므로 이 요약이 필요하다.
주중주말/연주는 저장하지 않고 조회 시 달력 JOIN 으로 파생(요약은 구·일자·시간만).

월 단위 직렬 처리(원천 파티션별 GROUP BY — 무거우니 직렬이 안전). 재실행=전체 재빌드.
04.build_mart 갱신 후 같이 돌리면 됨.
  python 04c.build_gu_day_mart.py
"""
import importlib.util
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
try:
    from tqdm import tqdm
    _HAS_TQDM = True
except Exception:
    _HAS_TQDM = False

GU_DAY = "마트_구_일_시간"


def load_ingest():
    p = Path(__file__).resolve().parent / "00.input_data.py"
    spec = importlib.util.spec_from_file_location("ingest", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ing = load_ingest()
    measures = ing.COL_NAMES[ing.N_KEY_COLS:]
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

    cur.execute(f"DROP TABLE IF EXISTS `{GU_DAY}`")
    mcols = ",\n".join(f"  `{m}` DECIMAL(15,2) NULL" for m in measures)
    cur.execute(f"""CREATE TABLE `{GU_DAY}` (
        `구코드` CHAR(5) NOT NULL,
        `일자` DATE NOT NULL,
        `시간` TINYINT UNSIGNED NOT NULL,
{mcols},
        PRIMARY KEY (`구코드`,`일자`,`시간`),
        KEY `ix_일자` (`일자`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")

    cur.execute(
        f"SELECT DISTINCT CONCAT(YEAR(`일자`), LPAD(MONTH(`일자`),2,'0')) ym "
        f"FROM `{ing.LOG_TABLE}` ORDER BY ym"
    )
    months = [r[0] for r in cur.fetchall()]
    sel = ",".join(f"SUM(f.`{m}`)" for m in measures)
    cols = ",".join(f"`{m}`" for m in measures)

    print(f"▶ {GU_DAY} 빌드: {len(months)}개월 (원천 파티션별 구×일자×시간 집계)", flush=True)
    t0 = time.time()
    grand = 0
    it = tqdm(months, unit="month", ncols=100) if _HAS_TQDM else months
    for ym in it:
        mt = time.time()
        cur.execute(f"""INSERT INTO `{GU_DAY}` (`구코드`,`일자`,`시간`,{cols})
            SELECT LEFT(f.`행정동코드`,5), f.`일자`, f.`시간`, {sel}
            FROM `{ing.TABLE_NAME}` PARTITION (p{ym}) f
            GROUP BY LEFT(f.`행정동코드`,5), f.`일자`, f.`시간`""")
        grand += cur.rowcount
        conn.commit()
        if not _HAS_TQDM:
            print(f"  {ym} → {cur.rowcount:,}행 ({time.time()-mt:.0f}s)", flush=True)

    cur.execute(f"SELECT COUNT(*) FROM `{GU_DAY}`")
    tot = cur.fetchone()[0]
    cur.close()
    conn.close()
    print(f"✅ {GU_DAY} 완료: {tot:,}행 ({(time.time()-t0)/60:.1f}분)")


if __name__ == "__main__":
    main()
