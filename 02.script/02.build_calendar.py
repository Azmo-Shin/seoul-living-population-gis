# -*- coding: utf-8 -*-
"""
02.build_calendar.py  ─  달력 차원 테이블 빌드 (shin_project.달력)
================================================================================
일자별 요일·주중/주말·공휴일을 미리 계산해 둔다. 주/월간 집계의 주중·주말 구분과
일평균(일수) 계산의 기준이 된다.

규칙:
  · 주말 = 토·일  OR  공휴일·대체공휴일  → '주말'
  · 그 외(월~금 중 공휴일 아님)          → '주중'
  · 공휴일은 holidays 라이브러리(대한민국, 대체공휴일 포함) 사용

사용:
  python 02.build_calendar.py                 # 2024-01-01 ~ 2027-12-31
  python 02.build_calendar.py --start 2024 --end 2028
================================================================================
"""
import argparse
import importlib.util
import sys
from datetime import date, timedelta
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    import holidays
except Exception:
    sys.exit("❌ holidays 라이브러리가 필요합니다: pip install holidays")

TABLE = "달력"
_WD = ["월", "화", "수", "목", "금", "토", "일"]


def load_ingest():
    p = Path(__file__).resolve().parent / "00.input_data.py"
    spec = importlib.util.spec_from_file_location("ingest", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def kr_holidays(years):
    try:
        return holidays.SouthKorea(years=years, language="ko")
    except TypeError:
        return holidays.SouthKorea(years=years)


def build_rows(start_year, end_year):
    years = list(range(start_year, end_year + 1))
    kr = kr_holidays(years)
    d = date(start_year, 1, 1)
    last = date(end_year, 12, 31)
    rows = []
    while d <= last:
        wd = d.weekday()                       # 0=월 .. 6=일
        is_sat_sun = wd >= 5
        hname = kr.get(d)                       # 공휴일명 or None
        is_holiday = hname is not None
        is_sub = bool(hname and ("대체" in hname or "Alternative" in hname or "Substitute" in hname))
        is_weekend = is_sat_sun or is_holiday   # 주말 판정
        iso_y, iso_w, _ = d.isocalendar()
        rows.append((
            d, d.year, d.month, d.day, f"{d.year}{d.month:02d}",
            wd, _WD[wd], 1 if is_sat_sun else 0,
            1 if is_holiday else 0, 1 if is_sub else 0, hname,
            "주말" if is_weekend else "주중",
            iso_y, iso_w, f"{iso_y}-{iso_w:02d}",
        ))
        d += timedelta(days=1)
    return rows


def main():
    ap = argparse.ArgumentParser(description="달력 차원 빌드")
    ap.add_argument("--start", type=int, default=2024, help="시작 연도")
    ap.add_argument("--end", type=int, default=2027, help="끝 연도")
    args = ap.parse_args()

    ing = load_ingest()
    rows = build_rows(args.start, args.end)

    conn = ing.connect(ing.load_db_config(), with_db=True)
    cur = conn.cursor()
    cur.execute(f"DROP TABLE IF EXISTS `{TABLE}`")
    cur.execute(f"""
        CREATE TABLE `{TABLE}` (
          `일자` DATE NOT NULL,
          `연` SMALLINT NOT NULL, `월` TINYINT NOT NULL, `일` TINYINT NOT NULL,
          `연월` CHAR(6) NOT NULL,
          `요일` TINYINT NOT NULL, `요일명` VARCHAR(3) NOT NULL,
          `주말기본` TINYINT(1) NOT NULL,
          `공휴일여부` TINYINT(1) NOT NULL,
          `대체공휴일여부` TINYINT(1) NOT NULL,
          `공휴일명` VARCHAR(60) NULL,
          `주중주말` VARCHAR(4) NOT NULL,
          `iso연` SMALLINT NOT NULL, `iso주` TINYINT NOT NULL, `연주` CHAR(7) NOT NULL,
          PRIMARY KEY (`일자`),
          KEY `ix_연월` (`연월`), KEY `ix_연주` (`연주`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)
    cur.executemany(
        f"INSERT INTO `{TABLE}` VALUES ({', '.join(['%s']*15)})", rows)
    conn.commit()

    # 요약 출력
    cur.execute(f"SELECT COUNT(*), SUM(`주중주말`='주중'), SUM(`주중주말`='주말'), SUM(`공휴일여부`) FROM `{TABLE}`")
    tot, wkday, wkend, hol = cur.fetchone()
    cur.execute(f"SELECT `일자`,`공휴일명` FROM `{TABLE}` WHERE `공휴일여부`=1 AND `연`=2025 ORDER BY `일자`")
    hol25 = cur.fetchall()
    cur.close(); conn.close()

    print(f"✅ 달력 빌드 완료: {tot:,}일 ({args.start}~{args.end})")
    print(f"   주중 {wkday:,}일 · 주말(+공휴일) {wkend:,}일 · 공휴일 {hol}일")
    print(f"   2025 공휴일 {len(hol25)}개:")
    for d, nm in hol25:
        print(f"     {d}  {nm}")


if __name__ == "__main__":
    main()
