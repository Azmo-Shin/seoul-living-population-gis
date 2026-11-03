# -*- coding: utf-8 -*-
"""
04.build_mart.py  ─  집계 마트 빌드 (shin_project.마트_월_시간)  [변경감지형]
================================================================================
원천(생활인구_250m) + 달력을 조인해 "날(日)"을 미리 합치고 "시간"은 남긴 마트.
시각화는 이 마트만 조회 → 빠름.

grain  : (연월, 행정동코드, 격자코드, 주중주말, 시간)
measure: SUM(생활인구합계) + SUM(남자0~9세 … 여자70이상)   -- NULL(마스킹)은 합산 제외
롤업   : 구별=LEFT(행정동코드,5) · 동별=행정동코드 · 격자별=격자코드
일평균 : 대시보드에서 SUM(선택시간) ÷ (달력의 해당 연월·주중주말 일수)

★ 변경감지: 각 월의 원천 시그니처(적재 행수합 + 파일크기합)를 `_마트빌드로그`에 기록.
   기본 실행 시 "신규 월 + 시그니처가 바뀐 월"만 자동 재빌드.
   → 기존 달에 날짜가 추가돼도(예: 2026-06 +7일) `--month` 없이 그 달이 자동 갱신됨.

월 단위 직렬 처리(무거운 GROUP BY라 병렬은 서버 경합·좀비쿼리 위험 → 직렬이 안전).

사용:
  python 04.build_mart.py             # 신규/변경된 월만 자동 빌드 (권장 · 평상시)
  python 04.build_mart.py --month 2026-06   # 그 달 강제 재빌드
  python 04.build_mart.py --rebuild         # 전체 DROP 후 재빌드
================================================================================
"""
import argparse
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

MART = "마트_월_시간"
MART_LOG = "_마트빌드로그"
CAL = "달력"


def load_ingest():
    p = Path(__file__).resolve().parent / "00.input_data.py"
    spec = importlib.util.spec_from_file_location("ingest", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def setup_session(conn, ing):
    """대량 집계 세션: GROUP BY 정렬용 메모리 버퍼 확대(디스크 temp 회피)."""
    ing.tune_session(conn)
    cur = conn.cursor()
    for stmt in (
        "SET SESSION tmp_table_size = 536870912",        # 512MB
        "SET SESSION max_heap_table_size = 536870912",   # 512MB
        "SET SESSION sort_buffer_size = 134217728",      # 128MB
    ):
        try:
            cur.execute(stmt)
        except Exception:
            pass
    cur.close()


def create_mart(conn, ing, *, drop):
    measures = ing.COL_NAMES[ing.N_KEY_COLS:]      # 29: 생활인구합계 + 28
    cur = conn.cursor()
    if drop:
        cur.execute(f"DROP TABLE IF EXISTS `{MART}`")
        cur.execute(f"DROP TABLE IF EXISTS `{MART_LOG}`")
    mcols = ",\n".join(f"  `{m}` DECIMAL(15,2) NULL" for m in measures)
    cur.execute(f"""CREATE TABLE IF NOT EXISTS `{MART}` (
        `연월` CHAR(6) NOT NULL,
        `행정동코드` VARCHAR(10) NOT NULL,
        `격자코드` VARCHAR(20) NOT NULL,
        `주중주말` VARCHAR(4) NOT NULL,
        `시간` TINYINT UNSIGNED NOT NULL,
{mcols},
        PRIMARY KEY (`연월`,`행정동코드`,`격자코드`,`주중주말`,`시간`)
      ) ENGINE=InnoDB ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8
        DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")
    cur.execute(f"""CREATE TABLE IF NOT EXISTS `{MART_LOG}` (
        `연월` CHAR(6) NOT NULL,
        `원천행수` BIGINT NOT NULL,
        `원천크기합` BIGINT NOT NULL,
        `빌드시각` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (`연월`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")
    conn.commit()
    cur.close()
    return measures


def source_sigs(conn, ing):
    """월별 원천 시그니처: {연월: (행수합, 파일크기합)} — 적재로그 기준(즉시)."""
    cur = conn.cursor()
    cur.execute(f"""SELECT CONCAT(YEAR(`일자`), LPAD(MONTH(`일자`),2,'0')) ym,
                           SUM(`행수`), SUM(`파일크기`)
                    FROM `{ing.LOG_TABLE}` GROUP BY ym""")
    sigs = {r[0]: (int(r[1]), int(r[2])) for r in cur.fetchall()}
    cur.close()
    return sigs


def mart_sigs(conn):
    """마트빌드로그에 기록된 {연월: (원천행수, 원천크기합)}."""
    cur = conn.cursor()
    cur.execute(f"SELECT `연월`,`원천행수`,`원천크기합` FROM `{MART_LOG}`")
    sigs = {r[0]: (int(r[1]), int(r[2])) for r in cur.fetchall()}
    cur.close()
    return sigs


def mart_existing_months(conn):
    cur = conn.cursor()
    cur.execute(f"SELECT DISTINCT `연월` FROM `{MART}`")
    ms = {r[0] for r in cur.fetchall()}
    cur.close()
    return ms


def build_month(conn, ing, measures, ym, sig):
    """한 달 집계: 기존 연월 삭제 → INSERT…SELECT → 빌드로그 갱신(같은 트랜잭션). 적재행수 반환."""
    cur = conn.cursor()
    cur.execute(f"DELETE FROM `{MART}` WHERE `연월`=%s", (ym,))
    cols = "`연월`,`행정동코드`,`격자코드`,`주중주말`,`시간`," + ",".join(f"`{m}`" for m in measures)
    sel = ",".join(f"SUM(f.`{m}`)" for m in measures)
    cur.execute(f"""INSERT INTO `{MART}` ({cols})
        SELECT %s, f.`행정동코드`, f.`250M격자`, d.`주중주말`, f.`시간`, {sel}
        FROM `{ing.TABLE_NAME}` PARTITION (p{ym}) f
        JOIN `{CAL}` d ON f.`일자` = d.`일자`
        GROUP BY f.`행정동코드`, f.`250M격자`, d.`주중주말`, f.`시간`""", (ym,))
    n = cur.rowcount
    cur.execute(f"""INSERT INTO `{MART_LOG}` (`연월`,`원천행수`,`원천크기합`) VALUES (%s,%s,%s)
        ON DUPLICATE KEY UPDATE `원천행수`=VALUES(`원천행수`),
          `원천크기합`=VALUES(`원천크기합`),`빌드시각`=CURRENT_TIMESTAMP""",
        (ym, sig[0], sig[1]))
    conn.commit()
    cur.close()
    return n


def main():
    ap = argparse.ArgumentParser(description="마트_월_시간 빌드 (변경감지형)")
    ap.add_argument("--month", help="특정 월 강제 재빌드 (YYYY-MM)")
    ap.add_argument("--rebuild", action="store_true", help="전체 DROP 후 재빌드")
    args = ap.parse_args()

    ing = load_ingest()
    conn = ing.connect(ing.load_db_config(), with_db=True)
    setup_session(conn, ing)
    measures = create_mart(conn, ing, drop=args.rebuild)

    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s",
                (ing.DB_NAME, CAL))
    if cur.fetchone()[0] == 0:
        sys.exit("❌ 달력 테이블이 없습니다. 먼저 python 02.build_calendar.py 를 실행하세요.")
    cur.close()

    srcsig = source_sigs(conn, ing)              # {ym: (행수, 크기합)}
    all_months = sorted(srcsig)

    # 기존 마트 월이 로그에 없으면(구버전 빌드분) 현재 시그니처로 백필 → 불필요한 전체 재빌드 방지
    if not args.rebuild:
        logged = mart_sigs(conn)
        existing = mart_existing_months(conn)
        backfill = [m for m in existing if m not in logged and m in srcsig]
        if backfill:
            bcur = conn.cursor()
            for m in backfill:
                bcur.execute(f"""INSERT INTO `{MART_LOG}` (`연월`,`원천행수`,`원천크기합`) VALUES (%s,%s,%s)
                    ON DUPLICATE KEY UPDATE `원천행수`=VALUES(`원천행수`),`원천크기합`=VALUES(`원천크기합`)""",
                    (m, srcsig[m][0], srcsig[m][1]))
            conn.commit(); bcur.close()
            print(f"  [백필] 기존 마트 {len(backfill)}개월을 빌드로그에 등록(현재 상태로 간주)")

    # 대상 결정
    if args.month:
        targets = [args.month.replace("-", "")]
    elif args.rebuild:
        targets = all_months
    else:
        logged = mart_sigs(conn)
        targets = [m for m in all_months if srcsig.get(m) != logged.get(m)]  # 신규 or 변경

    if not targets:
        print("✅ 마트 최신 상태 — 빌드할 신규/변경 월이 없습니다.")
        conn.close(); return

    print(f"▶ 마트 빌드 대상: {len(targets)}개월 ({targets[0]} ~ {targets[-1]})")
    t0 = time.time()
    grand = 0
    it = tqdm(targets, unit="month", ncols=100) if _HAS_TQDM else targets
    for ym in it:
        mt = time.time()
        n = build_month(conn, ing, measures, ym, srcsig.get(ym, (0, 0)))
        grand += n
        if _HAS_TQDM:
            it.set_postfix_str(f"{ym[:4]}-{ym[4:]} | 누적 {grand:,}행")
        else:
            print(f"  {ym[:4]}-{ym[4:]} → {n:,}행 ({time.time()-mt:.0f}s)")

    cur = conn.cursor()
    cur.execute(f"SELECT COUNT(*) FROM `{MART}`"); total = cur.fetchone()[0]
    cur.close(); conn.close()
    print(f"✅ 마트 빌드 완료: 이번 {grand:,}행 · 전체 {total:,}행 · 소요 {(time.time()-t0)/60:.1f}분")


if __name__ == "__main__":
    main()
