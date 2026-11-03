# -*- coding: utf-8 -*-
"""
00.input_data.py  ─  서울 250M 생활인구(LOCAL_RESD) 적재/동기화 (운영용)
================================================================================
원본 : 2026_06_GIS/01.data/01.raw_data/서울_250M_생활인구/250_LOCAL_RESD_YYYYMM/…YYYYMMDD.csv
       (CP949, 일별, 33컬럼, '*'=비식별 마스킹, 재귀 탐색)
대상 : shin_project.생활인구_250m  (서버99 <DB_SERVER_IP>, MySQL 8.0)
       · 한 테이블, 월(月) 단위 RANGE 파티셔닝 + InnoDB 압축(kb8)
       · 한글 컬럼 원본 유지(백틱), '*'→NULL

운영 시나리오
  · 지금: 전체 일괄 적재
  · 앞으로: 새 달 폴더 추가 / 기존 달 재배포(갱신) → "디스크 ↔ DB 동기화"
            실행하면 신규·갱신을 감지해 무엇을 할지 질답으로 확인 후 적재.

--------------------------------------------------------------------------------
사용법
--------------------------------------------------------------------------------
  python 00.input_data.py                  # 질답형 동기화 (신규/갱신 감지→확인→적재)
  python 00.input_data.py --yes            # 묻지 않고 신규+갱신 모두 진행 (무인/배치)
  python 00.input_data.py --month 2026-06  # 그 달만 (없는 파일만 적재)
  python 00.input_data.py --from 2025-01 --to 2025-03
  python 00.input_data.py --year 2025
  python 00.input_data.py --reload-month 2024-01   # 그 달 강제 교체(파티션 TRUNCATE 후 재적재)
  python 00.input_data.py --reset          # 전체 DROP 후 재생성 (스키마 전환 첫 실행 시)
  python 00.input_data.py --dry-run        # 점검 결과만 표시
  python 00.input_data.py --workers 6      # 병렬 적재
  python 00.input_data.py --build-indexes  # 최초 전체 적재 후 1회: 조회 인덱스 생성
  python 00.input_data.py --test-conn      # 연결 확인

의존성 : mysql-connector-python, python-dotenv, (선택) tqdm
================================================================================
"""

import argparse
import csv
import os
import sys
import time
import urllib.parse
import multiprocessing as mp
from collections import namedtuple
from datetime import datetime, date
from pathlib import Path

import mysql.connector
from dotenv import load_dotenv

try:
    from tqdm import tqdm
    _HAS_TQDM = True
except Exception:
    _HAS_TQDM = False

# ──────────────────────────────────────────────────────────────────────────────
# 0. 설정
# ──────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
# DB 접속정보(.env) 탐색 순서: 프로젝트 로컬 우선 → 기존 stitch_ml(.env) 폴백
ENV_CANDIDATES = [
    SCRIPT_DIR / ".env",                                          # 2026_06_GIS/02.script/.env
    SCRIPT_DIR.parent / ".env",                                   # 2026_06_GIS/.env
    Path(r"<LOCAL_PATH>"),  # 기존 접속정보 폴백
]
DEFAULT_DATA_DIR = Path(r"<LOCAL_PATH>")

DB_NAME    = "shin_project"
TABLE_NAME = "생활인구_250m"
LOG_TABLE  = "_적재로그"
TABLE_STORAGE_OPTS = "ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8"      # 압축 kb8 (무압축은 "")

FILE_ENCODING = "cp949"
BATCH_SIZE    = 20_000
CSV_GLOB      = "250_LOCAL_RESD_2*.csv"
PARTITION_BUFFER_MONTHS = 24                                       # 데이터 최신월 + 버퍼까지 파티션 미리 생성

# ──────────────────────────────────────────────────────────────────────────────
# 1. 컬럼 정의 (원본 헤더 1:1, 순서 고정)
# ──────────────────────────────────────────────────────────────────────────────
_DEC = "DECIMAL(12,2)"
COLUMNS = [
    ("일자",        "DATE",             True),
    ("시간",        "TINYINT UNSIGNED", True),
    ("행정동코드",   "VARCHAR(10)",      True),
    ("250M격자",    "VARCHAR(20)",      True),
    ("생활인구합계", _DEC,               False),
]
for _sex in ("남자", "여자"):
    for _age in ("0~9세", "10~14세", "15~19세", "20~24세", "25~29세", "30~34세",
                 "35~39세", "40~44세", "45~49세", "50~54세", "55~59세",
                 "60~64세", "65~69세", "70세 이상"):
        COLUMNS.append((f"{_sex} {_age}", _DEC, False))

COL_NAMES  = [c[0] for c in COLUMNS]
N_COLS     = len(COL_NAMES)          # 33
N_KEY_COLS = 4
EXPECTED_HEADER = list(COL_NAMES)

# 디스크 파일 1건 표현
FileItem = namedtuple("FileItem", "date_str ym fname path size mtime")


# ──────────────────────────────────────────────────────────────────────────────
# 2. DB 연결
# ──────────────────────────────────────────────────────────────────────────────
def load_db_config() -> dict:
    for _env in ENV_CANDIDATES:
        if _env.exists():
            load_dotenv(_env)
            break
    raw_pw = os.getenv("DB_PASSWORD", "")
    return {
        "host":     os.getenv("DB_HOST", "<DB_SERVER_IP>"),
        "port":     int(os.getenv("DB_PORT", "3306")),
        "user":     os.getenv("DB_USER", "root"),
        "password": urllib.parse.unquote(raw_pw),   # .env 의 %인코딩 비밀번호 → 디코딩
        "charset":  "utf8mb4",
    }


def connect(cfg: dict, *, with_db: bool):
    params = dict(cfg, autocommit=False, use_pure=True)
    if with_db:
        params["database"] = DB_NAME
    return mysql.connector.connect(**params)


def ensure_database(cfg: dict):
    conn = connect(cfg, with_db=False)
    cur = conn.cursor()
    cur.execute(f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
                f"CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
    conn.commit(); cur.close(); conn.close()


def tune_session(conn):
    cur = conn.cursor()
    for stmt in ("SET SESSION unique_checks=0", "SET SESSION foreign_key_checks=0"):
        try:
            cur.execute(stmt)
        except mysql.connector.Error:
            pass
    cur.close()


# ──────────────────────────────────────────────────────────────────────────────
# 3. 월(月) 헬퍼 & 파티션 관리
# ──────────────────────────────────────────────────────────────────────────────
def iter_months(sy, sm, ey, em):
    y, m = sy, sm
    while (y, m) <= (ey, em):
        yield y, m
        m += 1
        if m > 12:
            m = 1; y += 1


def next_month_first(y, m) -> date:
    return date(y + (1 if m == 12 else 0), 1 if m == 12 else m + 1, 1)


def ym_str(y, m) -> str:
    return f"{y}{m:02d}"


def partition_clause(min_ym: str, max_ym: str) -> str:
    """min_ym~max_ym(+버퍼는 호출측에서 반영) 월별 파티션 정의 문자열."""
    sy, sm = int(min_ym[:4]), int(min_ym[4:])
    ey, em = int(max_ym[:4]), int(max_ym[4:])
    parts = []
    for y, m in iter_months(sy, sm, ey, em):
        bound = next_month_first(y, m).isoformat()
        parts.append(f"  PARTITION p{ym_str(y, m)} VALUES LESS THAN ('{bound}')")
    return ("PARTITION BY RANGE COLUMNS(`일자`) (\n" + ",\n".join(parts) + "\n)")


def add_buffer(max_ym: str, months: int) -> str:
    y, m = int(max_ym[:4]), int(max_ym[4:])
    for _ in range(months):
        m += 1
        if m > 12:
            m = 1; y += 1
    return ym_str(y, m)


def existing_partitions(conn) -> set:
    cur = conn.cursor()
    cur.execute("""SELECT PARTITION_NAME FROM information_schema.PARTITIONS
                   WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND PARTITION_NAME IS NOT NULL""",
                (DB_NAME, TABLE_NAME))
    res = {r[0] for r in cur.fetchall()}
    cur.close()
    return res


def ensure_partitions(conn, months: set):
    """필요한 월 파티션이 없으면 ADD PARTITION(끝에 추가). 정상 운영에선 대부분 no-op."""
    if not months:
        return
    have = existing_partitions(conn)
    want = sorted(months)
    missing = [ym for ym in want if f"p{ym}" not in have]
    if not missing:
        return
    # 기존 최대 파티션 경계보다 큰(미래) 달만 ADD 가능. 그보다 과거면 --reset 필요.
    cur_max = max((p[1:] for p in have), default="000000")
    cur = conn.cursor()
    for ym in missing:
        if ym <= cur_max:
            cur.close()
            raise RuntimeError(f"파티션 {ym} 가 기존 범위보다 과거라 자동추가 불가 → --reset 권장")
        y, m = int(ym[:4]), int(ym[4:])
        bound = next_month_first(y, m).isoformat()
        cur.execute(f"ALTER TABLE `{TABLE_NAME}` ADD PARTITION "
                    f"(PARTITION p{ym} VALUES LESS THAN ('{bound}'))")
        cur_max = ym
    conn.commit(); cur.close()


def truncate_month(conn, ym: str):
    """해당 월 파티션 데이터 비우기 + 로그에서 그 달 기록 삭제(재적재 준비)."""
    cur = conn.cursor()
    try:
        cur.execute(f"ALTER TABLE `{TABLE_NAME}` TRUNCATE PARTITION p{ym}")
    except mysql.connector.Error:
        pass  # 파티션이 아직 없으면(신규월) 무시
    cur.execute(f"DELETE FROM `{LOG_TABLE}` WHERE `파일명` LIKE %s",
                (f"250_LOCAL_RESD_{ym}%",))
    conn.commit(); cur.close()


# ──────────────────────────────────────────────────────────────────────────────
# 4. 스키마
# ──────────────────────────────────────────────────────────────────────────────
def table_exists(conn) -> bool:
    cur = conn.cursor()
    cur.execute("""SELECT 1 FROM information_schema.TABLES
                   WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s""", (DB_NAME, TABLE_NAME))
    ok = cur.fetchone() is not None
    cur.close()
    return ok


def table_is_partitioned(conn) -> bool:
    cur = conn.cursor()
    cur.execute("""SELECT PARTITION_NAME FROM information_schema.PARTITIONS
                   WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s LIMIT 1""", (DB_NAME, TABLE_NAME))
    row = cur.fetchone()
    cur.close()
    return bool(row and row[0])


def create_log_table(conn):
    cur = conn.cursor()
    cur.execute(
        f"CREATE TABLE IF NOT EXISTS `{LOG_TABLE}` (\n"
        f"  `파일명` VARCHAR(80) NOT NULL,\n"
        f"  `일자` DATE NULL,\n"
        f"  `행수` INT NULL,\n"
        f"  `파일크기` BIGINT NULL,\n"
        f"  `수정시각` BIGINT NULL,\n"
        f"  `적재시각` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n"
        f"  PRIMARY KEY (`파일명`)\n"
        f") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci")
    conn.commit(); cur.close()


def create_main_table(conn, min_ym: str, max_ym: str):
    col_defs = []
    for name, sqltype, not_null in COLUMNS:
        col_defs.append(f"  `{name}` {sqltype} {'NOT NULL' if not_null else 'NULL'}")
    cols_sql = ",\n".join(col_defs)
    part_sql = partition_clause(min_ym, add_buffer(max_ym, PARTITION_BUFFER_MONTHS))
    cur = conn.cursor()
    cur.execute(
        f"CREATE TABLE `{TABLE_NAME}` (\n"
        f"  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n"
        f"{cols_sql},\n"
        f"  PRIMARY KEY (`id`, `일자`)\n"
        f") ENGINE=InnoDB {TABLE_STORAGE_OPTS} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci\n"
        f"{part_sql}")
    conn.commit(); cur.close()


def setup_schema(conn, *, reset: bool, min_ym: str, max_ym: str):
    cur = conn.cursor()
    if reset:
        cur.execute(f"DROP TABLE IF EXISTS `{TABLE_NAME}`")
        cur.execute(f"DROP TABLE IF EXISTS `{LOG_TABLE}`")
        conn.commit()
        print(f"  [reset] 기존 테이블 삭제: {TABLE_NAME}, {LOG_TABLE}")
    cur.close()
    create_log_table(conn)
    if not table_exists(conn):
        create_main_table(conn, min_ym, max_ym)
        print(f"  [schema] {TABLE_NAME} 생성 (월 파티션 {min_ym}~{add_buffer(max_ym, PARTITION_BUFFER_MONTHS)}, 압축 kb8)")
    elif not table_is_partitioned(conn):
        raise RuntimeError(
            f"`{TABLE_NAME}` 이 구버전(비파티션) 스키마입니다. 새 스키마로 전환하려면 --reset 으로 재생성하세요.")


def build_indexes(conn):
    idx = [("ix_일자", "일자"), ("ix_격자", "250M격자"), ("ix_동코드", "행정동코드")]
    cur = conn.cursor()
    for name, col in idx:
        try:
            print(f"  인덱스 생성 중: {name} ({col}) … (대용량이면 수 분 소요)")
            t0 = time.time()
            cur.execute(f"ALTER TABLE `{TABLE_NAME}` ADD INDEX `{name}` (`{col}`)")
            conn.commit()
            print(f"    완료 {time.time()-t0:.1f}s")
        except mysql.connector.Error as e:
            print(f"    skip ({name}): {e}")
    cur.close()


# ──────────────────────────────────────────────────────────────────────────────
# 5. CSV 파싱
# ──────────────────────────────────────────────────────────────────────────────
def build_insert_sql() -> str:
    cols = ", ".join(f"`{c}`" for c in COL_NAMES)
    ph = ", ".join(["%s"] * N_COLS)
    return f"INSERT INTO `{TABLE_NAME}` ({cols}) VALUES ({ph})"


_LOG_UPSERT = (
    f"INSERT INTO `{LOG_TABLE}` (`파일명`,`일자`,`행수`,`파일크기`,`수정시각`) "
    f"VALUES (%s,%s,%s,%s,%s) "
    f"ON DUPLICATE KEY UPDATE `일자`=VALUES(`일자`),`행수`=VALUES(`행수`),"
    f"`파일크기`=VALUES(`파일크기`),`수정시각`=VALUES(`수정시각`),`적재시각`=CURRENT_TIMESTAMP"
)


def clean_value(raw: str):
    v = raw.strip()
    return None if (v == "" or v == "*") else float(v)


def parse_file(path: Path):
    with open(path, "r", encoding=FILE_ENCODING, newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header is None:
            return
        if [h.strip() for h in header] != EXPECTED_HEADER:
            raise ValueError(f"헤더 불일치: {path.name}")
        for row in reader:
            if len(row) != N_COLS:
                continue
            일자 = datetime.strptime(row[0].strip(), "%Y%m%d").date()
            시간 = int(row[1].strip())
            동코드 = row[2].strip()
            격자 = row[3].strip()
            nums = [clean_value(row[i]) for i in range(N_KEY_COLS, N_COLS)]
            masked = sum(1 for n in nums if n is None)
            yield (일자, 시간, 동코드, 격자, *nums), masked


def insert_file(conn, insert_sql: str, item: FileItem) -> tuple:
    """파일 1개를 단일 트랜잭션으로 적재 + 로그 upsert. (행수, 마스킹수) 반환."""
    cur = conn.cursor()
    batch, total, masked_total = [], 0, 0
    try:
        for tup, masked in parse_file(item.path):
            masked_total += masked
            total += 1
            batch.append(tup)
            if len(batch) >= BATCH_SIZE:
                cur.executemany(insert_sql, batch); batch.clear()
        if batch:
            cur.executemany(insert_sql, batch)
        cur.execute(_LOG_UPSERT, (item.fname,
                                  datetime.strptime(item.date_str, "%Y%m%d").date(),
                                  total, item.size, item.mtime))
        conn.commit(); cur.close()
        return total, masked_total
    except Exception:
        conn.rollback(); cur.close()
        raise


# ──────────────────────────────────────────────────────────────────────────────
# 6. 디스크 탐색 & 신규/갱신 분류
# ──────────────────────────────────────────────────────────────────────────────
def discover_files(data_dir: Path) -> list:
    import re
    pat = re.compile(r"^250_LOCAL_RESD_(\d{8})\.csv$")
    found = {}
    for p in data_dir.rglob(CSV_GLOB):
        m = pat.match(p.name)
        if not m:
            continue
        ds = m.group(1)
        if ds in found:
            continue
        st = p.stat()
        found[ds] = FileItem(ds, ds[:6], p.name, p, st.st_size, int(st.st_mtime))
    return [found[k] for k in sorted(found)]


def load_log(conn) -> dict:
    cur = conn.cursor()
    cur.execute(f"SELECT `파일명`,`파일크기`,`수정시각` FROM `{LOG_TABLE}`")
    log = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    cur.close()
    return log


def classify(files: list, log: dict):
    """(신규 리스트, 갱신 리스트, 갱신월 set) 반환."""
    new, changed = [], []
    for it in files:
        if it.fname not in log:
            new.append(it)
        else:
            lsize, lmtime = log[it.fname]
            if (lsize, lmtime) != (it.size, it.mtime):
                changed.append(it)
    changed_months = {it.ym for it in changed}
    return new, changed, changed_months


# ──────────────────────────────────────────────────────────────────────────────
# 7. 진행바 (tqdm 우선, 없으면 텍스트 폴백)
# ──────────────────────────────────────────────────────────────────────────────
class Progress:
    def __init__(self, total, desc="적재"):
        self.total = total; self.n = 0; self.t0 = time.time(); self.desc = desc
        self.bar = tqdm(total=total, desc=desc, unit="file", ncols=100) if _HAS_TQDM else None

    def update(self, k=1, postfix=""):
        self.n += k
        if self.bar:
            if postfix:
                self.bar.set_postfix_str(postfix)
            self.bar.update(k)
        else:
            el = time.time() - self.t0
            pct = (self.n / self.total * 100) if self.total else 0
            print(f"\r  {self.desc} {self.n}/{self.total} {pct:5.1f}%  {postfix}  ({el:.0f}s)",
                  end="", flush=True)

    def close(self):
        if self.bar:
            self.bar.close()
        else:
            print()


# ──────────────────────────────────────────────────────────────────────────────
# 8. 적재 (직렬 / 병렬)
# ──────────────────────────────────────────────────────────────────────────────
_W_CONN = None
_W_SQL = None


def _pool_init(cfg, batch_size):
    global _W_CONN, _W_SQL, BATCH_SIZE
    BATCH_SIZE = batch_size
    _W_CONN = connect(cfg, with_db=True)
    tune_session(_W_CONN)
    _W_SQL = build_insert_sql()


def _pool_load(item: FileItem):
    t = time.time()
    try:
        rows, masked = insert_file(_W_CONN, _W_SQL, item)
        return (item, rows, masked, time.time() - t, None)
    except Exception as e:
        return (item, 0, 0, time.time() - t, str(e))


def run_load(cfg, to_load: list, reload_months: list, workers: int) -> tuple:
    """to_load 파일 적재. reload_months 는 사전에 파티션 TRUNCATE. (총행수, 실패목록) 반환."""
    if not to_load:
        print("적재할 파일이 없습니다.")
        return 0, []

    conn = connect(cfg, with_db=True)
    ensure_partitions(conn, {it.ym for it in to_load})
    for ym in sorted(set(reload_months)):
        truncate_month(conn, ym)
        print(f"  [교체] {ym[:4]}-{ym[4:]} 파티션 비움 → 재적재")

    insert_sql = build_insert_sql()
    grand, masked_tot, failed = 0, 0, []
    bar = Progress(len(to_load), "적재")

    if workers > 1:
        conn.close()
        pool = mp.Pool(workers, initializer=_pool_init, initargs=(cfg, BATCH_SIZE))
        try:
            for item, rows, masked, fdt, err in pool.imap_unordered(_pool_load, to_load):
                if err:
                    failed.append((item.fname, err))
                else:
                    grand += rows; masked_tot += masked
                rate = grand / max(1e-9, time.time() - bar.t0)
                bar.update(1, f"{item.ym[:4]}-{item.ym[4:]} | {grand:,}행 | {rate:,.0f}행/s")
            pool.close()
        except KeyboardInterrupt:
            print("\n⏸  중단 — 완료 파일은 커밋됨. 재실행 시 이어받기.")
            pool.terminate()
        finally:
            pool.join()
    else:
        tune_session(conn)
        for item in to_load:
            try:
                rows, masked = insert_file(conn, insert_sql, item)
                grand += rows; masked_tot += masked
                rate = grand / max(1e-9, time.time() - bar.t0)
                bar.update(1, f"{item.ym[:4]}-{item.ym[4:]} | {grand:,}행 | {rate:,.0f}행/s")
            except KeyboardInterrupt:
                print("\n⏸  중단 — 완료 파일은 커밋됨. 재실행 시 이어받기.")
                break
            except Exception as e:
                failed.append((item.fname, str(e)))
                if len(failed) >= 5:
                    print("\n❌ 연속 실패 5건 — 중단. 원인 확인 후 재실행.")
                    break
        conn.close()

    bar.close()
    print(f"  ▶ 적재행수={grand:,} · 마스킹셀={masked_tot:,}"
          + (f" · 실패 {len(failed)}건" if failed else ""))
    for fn, err in failed:
        print(f"     - 실패: {fn} → {err}")
    return grand, failed


# ──────────────────────────────────────────────────────────────────────────────
# 9. 동기화 계획 & 질답
# ──────────────────────────────────────────────────────────────────────────────
def _ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        return ""


def plan_sync(files, log, args):
    """신규/갱신 분류 → 요약 출력 → (질답/플래그) 결정 → (to_load, reload_months)."""
    new, changed, changed_months = classify(files, log)
    new_months = sorted({it.ym for it in new})

    def fmt_months(ms):
        return ", ".join(f"{m[:4]}-{m[4:]}" for m in sorted(ms)) or "-"

    files_by_month = {}
    for it in files:
        files_by_month.setdefault(it.ym, []).append(it)
    changed_file_cnt = sum(len(files_by_month[m]) for m in changed_months)

    print("\n=== 디스크 ↔ DB 동기화 점검 ===")
    print(f" 신규 (DB에 없음) : {len(new_months)}개월  {fmt_months(new_months)}  · {len(new)}개 파일")
    print(f" 갱신 (내용 바뀜) : {len(changed_months)}개월  {fmt_months(changed_months)}  · {changed_file_cnt}개 파일  ⚠ 교체 대상")
    print(f" 변경 없음(skip)  : {len(files) - len(new) - changed_file_cnt}개 파일")

    if not new and not changed_months:
        print("이미 최신 상태입니다. 적재할 신규/갱신 데이터가 없습니다.")
        return [], []

    if args.dry_run:
        print("[dry-run] 아무 것도 적재하지 않습니다.")
        return [], []

    # 결정: --yes → 신규+갱신 / 비대화 → 안전종료 / 대화 → 질답
    if args.yes:
        choice = "2"
    elif not sys.stdin.isatty():
        print("비대화 실행입니다. --yes(신규+갱신) 또는 --month/--reload-month 로 지정해 주세요.")
        return [], []
    else:
        print("\n무엇을 할까요?")
        print("  [1] 신규만 적재")
        print("  [2] 신규 + 갱신(교체) 모두   (권장)")
        print("  [3] 직접 선택 — 월별로 물어봄")
        print("  [0] 취소")
        choice = _ask("선택> ")

    if choice == "0" or choice == "":
        print("취소했습니다.")
        return [], []

    to_load, reload_months = [], []
    if choice == "1":
        to_load = list(new)
    elif choice == "2":
        if changed_months and not args.yes:
            if _ask(f"⚠ 갱신 {len(changed_months)}개월을 기존 데이터 지우고 교체합니다. 진행? [y/N] > ").lower() != "y":
                print("취소했습니다.")
                return [], []
        reload_months = sorted(changed_months)
        seen = set()
        for ym in reload_months:
            for it in files_by_month[ym]:
                to_load.append(it); seen.add(it.fname)
        for it in new:
            if it.fname not in seen:
                to_load.append(it)
    elif choice == "3":
        for ym in new_months:
            if _ask(f"신규 {ym[:4]}-{ym[4:]} 적재? [y/N] > ").lower() == "y":
                to_load += [it for it in new if it.ym == ym]
        for ym in sorted(changed_months):
            if _ask(f"갱신 {ym[:4]}-{ym[4:]} 교체(기존 삭제 후 재적재)? [y/N] > ").lower() == "y":
                reload_months.append(ym)
                to_load += files_by_month[ym]
    else:
        print("알 수 없는 선택. 취소합니다.")
        return [], []

    to_load.sort(key=lambda it: it.date_str)
    return to_load, reload_months


def plan_targets(files, log, args):
    """명시적 타깃 플래그(--month/--from/--to/--year/--reload-month) → (to_load, reload_months)."""
    files_by_month = {}
    for it in files:
        files_by_month.setdefault(it.ym, []).append(it)

    if args.reload_month:
        ym = args.reload_month.replace("-", "")
        if ym not in files_by_month:
            print(f"해당 월 파일이 디스크에 없습니다: {args.reload_month}")
            return [], []
        return sorted(files_by_month[ym], key=lambda it: it.date_str), [ym]

    # --month / --from-to / --year → 범위 내 "아직 없는(신규)" 파일만 추가
    def in_scope(ym):
        if args.month:
            return ym == args.month.replace("-", "")
        if args.year:
            return ym[:4] == str(args.year)
        if args.from_ym or args.to_ym:
            lo = (args.from_ym or "000000").replace("-", "")
            hi = (args.to_ym or "999999").replace("-", "")
            return lo <= ym <= hi
        return False

    scope = [it for it in files if in_scope(it.ym)]
    to_load = [it for it in scope if it.fname not in log]
    skipped = len(scope) - len(to_load)
    if skipped:
        print(f"  (범위 내 이미 적재된 {skipped}개 파일은 skip — 강제 교체는 --reload-month)")
    to_load.sort(key=lambda it: it.date_str)
    return to_load, []


def has_targets(args) -> bool:
    return bool(args.month or args.from_ym or args.to_ym or args.year or args.reload_month)


# ──────────────────────────────────────────────────────────────────────────────
# 10. 메인
# ──────────────────────────────────────────────────────────────────────────────
def run(args):
    cfg = load_db_config()

    if args.test_conn:
        ensure_database(cfg)
        conn = connect(cfg, with_db=True); cur = conn.cursor()
        cur.execute("SELECT VERSION()"); ver = cur.fetchone()[0]
        cur.close(); conn.close()
        print(f"✅ 연결 성공 · {cfg['user']}@{cfg['host']}:{cfg['port']} · DB={DB_NAME} · {ver}")
        return

    data_dir = Path(args.data_dir)
    if not data_dir.exists():
        sys.exit(f"❌ 데이터 폴더 없음: {data_dir}")

    print(f"▶ 데이터 폴더 : {data_dir}")
    files = discover_files(data_dir)
    if not files:
        sys.exit("❌ CSV 파일을 찾지 못했습니다.")
    min_ym, max_ym = files[0].ym, files[-1].ym
    print(f"▶ 디스크 CSV  : {len(files)}개 ({files[0].date_str} ~ {files[-1].date_str})")

    ensure_database(cfg)
    conn = connect(cfg, with_db=True)
    setup_schema(conn, reset=args.reset, min_ym=min_ym, max_ym=max_ym)

    if args.build_indexes:
        build_indexes(conn)
        conn.close()
        return

    log = load_log(conn)
    conn.close()

    if has_targets(args):
        to_load, reload_months = plan_targets(files, log, args)
    else:
        to_load, reload_months = plan_sync(files, log, args)

    if not to_load:
        return

    print(f"▶ 적재 대상   : {len(to_load)}개 파일"
          + (f" · 교체월 {len(reload_months)}" if reload_months else "")
          + (f" · 병렬 {args.workers}워커" if args.workers > 1 else ""))
    t0 = time.time()
    grand, failed = run_load(cfg, to_load, reload_months, max(1, args.workers))
    print("─" * 70)
    print(f"완료 · 적재행수={grand:,} · 소요={ (time.time()-t0)/60:.1f}분"
          + (f" · 실패 {len(failed)}건" if failed else ""))
    if not failed:
        print("💡 최초 전체 적재라면 조회 인덱스 생성: python 00.input_data.py --build-indexes")


def parse_args():
    p = argparse.ArgumentParser(description="서울 250M 생활인구 CSV → shin_project 적재/동기화")
    p.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR), help="원본 CSV 루트 폴더")
    p.add_argument("--month", help="특정 월만 적재 (YYYY-MM)")
    p.add_argument("--from", dest="from_ym", help="기간 시작월 (YYYY-MM)")
    p.add_argument("--to", dest="to_ym", help="기간 끝월 (YYYY-MM)")
    p.add_argument("--year", help="특정 연도 (YYYY)")
    p.add_argument("--reload-month", help="그 달 강제 교체 (파티션 TRUNCATE 후 재적재, YYYY-MM)")
    p.add_argument("--reset", action="store_true", help="전체 DROP 후 재생성")
    p.add_argument("--yes", action="store_true", help="묻지 않고 신규+갱신 모두 진행 (무인)")
    p.add_argument("--dry-run", action="store_true", help="점검 결과만 표시")
    p.add_argument("--workers", type=int, default=1, help="병렬 적재 워커 수 (권장 4~8)")
    p.add_argument("--batch-size", type=int, default=None, help="executemany 배치 크기")
    p.add_argument("--build-indexes", action="store_true", help="조회 인덱스 생성(최초 적재 후 1회)")
    p.add_argument("--test-conn", action="store_true", help="DB 연결만 테스트")
    return p.parse_args()


def main():
    global BATCH_SIZE
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    args = parse_args()
    if args.batch_size:
        BATCH_SIZE = args.batch_size
    run(args)


if __name__ == "__main__":
    main()
