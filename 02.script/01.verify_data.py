# -*- coding: utf-8 -*-
"""
01.verify_data.py  ─  shin_project.생활인구_250m 적재 데이터 검증/테스트
================================================================================
적재가 "제대로" 됐는지 5개 축으로 점검하고 PASS/FAIL 리포트를 출력한다.
  ① 완전성  : 디스크 파일 ↔ 적재로그 일치, 날짜 연속(빠진 날 없음)
  ② 무결성  : 전체 COUNT(*) == 로그 행수합계, 일자별 DB행수 == 로그행수,
              파티션 라우팅(각 월 파티션이 그 달 일자만 보유)
  ③ 소스대조: 표본 날짜의 CSV를 "독립 재집계"해 DB 행수/실제 값과 대조 (적재로직과 무관한 진실 검증)
  ④ 값 상식 : 시간 0~23, 생활인구합계>=0, 마스킹율(~88%), 격자/동코드 분포
  ⑤ 스키마  : 월 파티션 수, 압축, 인덱스 유무

사용:
  python 01.verify_data.py                 # 전체 검증 (전수 스캔 1회 포함, 수 분)
  python 01.verify_data.py --samples 20    # 소스대조 표본 수
  python 01.verify_data.py --quick         # 전수 GROUP BY 생략(빠름, 무결성 일부만)
================================================================================
"""
import argparse
import importlib.util
import sys
import time
from pathlib import Path
from datetime import date, timedelta

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def load_ingest():
    p = Path(__file__).resolve().parent / "00.input_data.py"
    spec = importlib.util.spec_from_file_location("ingest", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def count_csv_rows(path: Path) -> int:
    """CSV 데이터행 수 = 줄 수 - 헤더 (대용량은 청크로 개행 세기)."""
    cnt = 0
    with open(path, "rb") as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            cnt += b.count(b"\n")
    return max(0, cnt - 1)


def csv_sample_rows(ing, path: Path, k: int):
    """CSV에서 비마스킹 값이 있는 행 최대 k개를 파싱해 반환 (값 대조용)."""
    out = []
    for tup, masked in ing.parse_file(path):
        if masked < (ing.N_COLS - ing.N_KEY_COLS):   # 합계 외 값이 하나라도 있으면
            out.append(tup)
            if len(out) >= k:
                break
    return out


def main():
    ap = argparse.ArgumentParser(description="생활인구_250m 적재 검증")
    ap.add_argument("--samples", type=int, default=15, help="소스대조 표본 날짜 수")
    ap.add_argument("--quick", action="store_true", help="전수 GROUP BY 스캔 생략")
    args = ap.parse_args()

    ing = load_ingest()
    cfg = ing.load_db_config()
    data_dir = ing.DEFAULT_DATA_DIR

    print("=" * 74)
    print(" shin_project.생활인구_250m  적재 검증")
    print("=" * 74)

    disk = ing.discover_files(Path(data_dir))
    conn = ing.connect(cfg, with_db=True)
    cur = conn.cursor()

    results = []   # (라벨, ok, 상세)

    def check(label, ok, detail=""):
        results.append((label, ok, detail))
        mark = "✅" if ok else "❌"
        print(f" {mark} {label}" + (f"  — {detail}" if detail else ""))

    # ───────── ① 완전성 ─────────
    print("\n[① 완전성]")
    cur.execute(f"SELECT `파일명`,`일자`,`행수`,`파일크기`,`수정시각` FROM `{ing.LOG_TABLE}`")
    logrows = cur.fetchall()
    log = {r[0]: r for r in logrows}
    disk_names = {it.fname for it in disk}
    missing = disk_names - set(log)
    extra = set(log) - disk_names
    check("디스크 파일 모두 적재됨", not missing,
          f"디스크 {len(disk_names)} / 로그 {len(log)}" + (f" / 미적재 {len(missing)}" if missing else ""))
    if extra:
        check("로그에만 있는(디스크 삭제) 파일 없음", False, f"잔존 {len(extra)}개: {sorted(extra)[:3]}…")
    # 날짜 연속성
    disk_dates = sorted(date(int(it.date_str[:4]), int(it.date_str[4:6]), int(it.date_str[6:])) for it in disk)
    gaps = []
    for a, b in zip(disk_dates, disk_dates[1:]):
        if (b - a).days != 1:
            gaps.append((a.isoformat(), b.isoformat(), (b - a).days - 1))
    check("날짜 연속(빠진 날 없음)", not gaps,
          f"{disk_dates[0]} ~ {disk_dates[-1]}" + (f" / 결손구간 {len(gaps)}: {gaps[:3]}" if gaps else ""))
    # 지문 채워짐
    no_sig = [r[0] for r in logrows if r[3] is None or r[4] is None]
    check("로그 지문(크기·mtime) 채워짐", not no_sig, f"누락 {len(no_sig)}")

    sum_log = sum(r[2] for r in logrows)
    log_by_date = {r[1].strftime("%Y%m%d"): r[2] for r in logrows}

    # ───────── ② 무결성 ─────────
    print("\n[② 무결성]")
    if not args.quick:
        t0 = time.time()
        print("   (전수 스캔: 일자별 COUNT … 수 분 소요)")
        cur.execute(f"SELECT `일자`, COUNT(*) FROM `{ing.TABLE_NAME}` GROUP BY `일자`")
        db_by_date = {r[0].strftime("%Y%m%d"): r[1] for r in cur.fetchall()}
        total = sum(db_by_date.values())
        print(f"   스캔 완료 {time.time()-t0:.0f}s")
        check("전체 COUNT(*) == 로그 행수합계", total == sum_log, f"DB {total:,} / 로그 {sum_log:,}")
        # 일자별 DB == 로그
        mism = [(d, db_by_date.get(d), log_by_date.get(d))
                for d in set(db_by_date) | set(log_by_date)
                if db_by_date.get(d) != log_by_date.get(d)]
        check("일자별 DB행수 == 로그행수", not mism, f"불일치 {len(mism)}건" + (f": {mism[:3]}" if mism else ""))
    else:
        db_by_date = None
        check("(quick) 전수 무결성 스캔 생략", True, "로그 행수합계만 신뢰")

    # 파티션 라우팅: 표본 월 파티션이 그 달 일자만 보유
    cur.execute(f"""SELECT PARTITION_NAME FROM information_schema.PARTITIONS
                    WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND TABLE_ROWS>0
                    ORDER BY PARTITION_ORDINAL_POSITION""", (ing.DB_NAME, ing.TABLE_NAME))
    nonempty = [r[0] for r in cur.fetchall()]
    route_bad = []
    for pn in (nonempty[:1] + nonempty[len(nonempty)//2:len(nonempty)//2+1] + nonempty[-1:]):
        ym = pn[1:]  # 'pYYYYMM' → 'YYYYMM'
        cur.execute(f"SELECT MIN(`일자`),MAX(`일자`) FROM `{ing.TABLE_NAME}` PARTITION ({pn})")
        mn, mx = cur.fetchone()
        if not (mn.strftime("%Y%m") == ym and mx.strftime("%Y%m") == ym):
            route_bad.append((pn, str(mn), str(mx)))
    check("파티션 라우팅(월 경계 일치, 표본)", not route_bad,
          f"점검 {min(3,len(nonempty))}개 파티션" + (f" / 이상 {route_bad}" if route_bad else ""))

    # ───────── ③ 소스대조 (독립 재집계) ─────────
    print("\n[③ 소스대조 — CSV 독립 재집계 vs DB]")
    n = max(2, min(args.samples, len(disk)))
    idxs = [round(i * (len(disk) - 1) / (n - 1)) for i in range(n)]
    sample = [disk[i] for i in dict.fromkeys(idxs)]
    cnt_bad, val_bad, val_checked = [], [], 0
    for it in sample:
        csv_rows = count_csv_rows(it.path)
        if db_by_date is not None:
            db_rows = db_by_date.get(it.date_str, 0)
        else:
            cur.execute(f"SELECT COUNT(*) FROM `{ing.TABLE_NAME}` WHERE `일자`=%s",
                        (f"{it.date_str[:4]}-{it.date_str[4:6]}-{it.date_str[6:]}",))
            db_rows = cur.fetchone()[0]
        if csv_rows != db_rows:
            cnt_bad.append((it.date_str, csv_rows, db_rows))
    check(f"표본 {len(sample)}일: CSV행수 == DB행수", not cnt_bad,
          f"불일치 {len(cnt_bad)}" + (f": {cnt_bad[:3]}" if cnt_bad else ""))

    # 값 spot-check: 표본 앞/중/뒤 3일에서 비마스킹 행을 골라 DB 값과 대조
    for it in (sample[0], sample[len(sample)//2], sample[-1]):
        for tup in csv_sample_rows(ing, it.path, 2):
            일자, 시간, 동코드, 격자 = tup[0], tup[1], tup[2], tup[3]
            cols = ", ".join(f"`{c}`" for c in ing.COL_NAMES[ing.N_KEY_COLS:])
            cur.execute(f"SELECT {cols} FROM `{ing.TABLE_NAME}` "
                        f"WHERE `일자`=%s AND `시간`=%s AND `행정동코드`=%s AND `250M격자`=%s",
                        (일자, 시간, 동코드, 격자))
            row = cur.fetchone()
            val_checked += 1
            if row is None:
                val_bad.append((str(일자), 시간, 격자, "DB에 행 없음"))
                continue
            for i, dbv in enumerate(row):
                csvv = tup[ing.N_KEY_COLS + i]
                if csvv is None:
                    if dbv is not None:
                        val_bad.append((str(일자), 격자, ing.COL_NAMES[ing.N_KEY_COLS+i], f"DB={dbv} vs CSV=NULL"))
                        break
                elif dbv is None or abs(float(dbv) - float(csvv)) > 0.01:
                    val_bad.append((str(일자), 격자, ing.COL_NAMES[ing.N_KEY_COLS+i], f"DB={dbv} vs CSV={csvv}"))
                    break
    check(f"표본 {val_checked}행: 실제 값(33컬럼) CSV==DB", not val_bad,
          (f"불일치 {len(val_bad)}: {val_bad[:2]}" if val_bad else "전부 일치"))

    # ───────── ④ 값 상식 ─────────
    print("\n[④ 값 상식 (최근 월 파티션 표본)]")
    pn = nonempty[-1]
    cur.execute(f"""SELECT MIN(`시간`),MAX(`시간`),MIN(`생활인구합계`),MAX(`생활인구합계`),
                    AVG(`남자 30~34세` IS NULL), COUNT(DISTINCT `250M격자`), COUNT(DISTINCT `행정동코드`)
                    FROM `{ing.TABLE_NAME}` PARTITION ({pn})""")
    hmin, hmax, smin, smax, mrate, ng, nd = cur.fetchone()
    check("시간 ∈ [0,23]", hmin == 0 and hmax == 23, f"{hmin}~{hmax}")
    check("생활인구합계 >= 0", (smin is None or float(smin) >= 0), f"min={smin} max={smax}")
    check("NULL(마스킹) 처리 정상", mrate is not None and 0.05 <= float(mrate) <= 0.90,
          f"남자30~34세 NULL율 {float(mrate)*100:.1f}% (정상 — 전체 마스킹율 ~40%, 컬럼·기간별 변동)")
    check("격자/동코드 분포 합리적", ng > 5000 and 300 <= nd <= 700, f"격자 {ng:,} · 동코드 {nd}")

    # ───────── ⑤ 스키마 ─────────
    print("\n[⑤ 스키마]")
    cur.execute("""SELECT COUNT(*) FROM information_schema.PARTITIONS
                   WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND PARTITION_NAME IS NOT NULL""",
                (ing.DB_NAME, ing.TABLE_NAME))
    npart = cur.fetchone()[0]
    cur.execute("""SELECT ROW_FORMAT, CREATE_OPTIONS FROM information_schema.TABLES
                   WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s""", (ing.DB_NAME, ing.TABLE_NAME))
    rf, copts = cur.fetchone()
    cur.execute("""SELECT GROUP_CONCAT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
                   WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND INDEX_NAME<>'PRIMARY'""",
                (ing.DB_NAME, ing.TABLE_NAME))
    idx = cur.fetchone()[0]
    check("월 파티션 구성", npart >= len(nonempty), f"{npart}개 파티션 · 데이터 {len(nonempty)}개월")
    check("압축 적용", "COMPRESSED" in (copts or "").upper() or rf == "Compressed", f"{rf} / {copts}")
    check("조회 인덱스", bool(idx), idx or "없음 → python 00.input_data.py --build-indexes 권장")

    cur.close(); conn.close()

    # ───────── 종합 ─────────
    print("\n" + "=" * 74)
    fails = [r for r in results if not r[1]]
    # 인덱스 없음은 경고(치명적 아님)
    critical = [r for r in fails if "인덱스" not in r[0]]
    print(f" 결과: {len(results)-len(fails)}/{len(results)} 통과", end="")
    if not critical:
        print("  →  ✅ 데이터 정상" + ("  (인덱스만 미생성: 조회 성능용 권장)" if fails else ""))
    else:
        print(f"  →  ❌ 점검 필요 {len(critical)}건")
        for lbl, ok, det in critical:
            print(f"    - {lbl}: {det}")
    print("=" * 74)
    sys.exit(1 if critical else 0)


if __name__ == "__main__":
    main()
