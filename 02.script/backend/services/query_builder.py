# -*- coding: utf-8 -*-
"""services/query_builder.py — 대시보드 SQL 생성 레이어 (순수 빌더).

단일 책임: UI 선택값 → (sql, params) 튜플 생성. **DB 호출 없음** (순수 함수).

설계 원칙
---------
- 인젝션 안전: 모든 사용자 값(연월·연주·일자·동코드·시간·주중주말)은 `%s`
  바인딩 또는 화이트리스트 단편(level/source 분기로만 선택되는 컬럼명)으로만
  SQL 에 들어간다. 사용자 값을 문자열 보간하지 않는다.
- metric 인자는 services.metrics.metric_expr() 가 만든 **이미 집계된** 표현식
  (예: "COALESCE(SUM(`생활인구합계`),0)") 으로, 호출자가 검증된 화이트리스트
  컬럼명만으로 생성한 것이다. SELECT 값으로 그대로 사용한다 (다시 SUM 금지).

데이터소스 분기 (핵심)
----------------------
- mart(`마트_월_시간`)  : 격자 컬럼 = `격자코드`
- raw (`생활인구_250m`) : 격자 컬럼 = `250M격자`  ← 같은 값/포맷, 다른 컬럼명
  잘못된 source 로 code_expr 를 만들면 Unknown column 오류.

SARGable 스코프
---------------
부모 영역 제한은 `LEFT()` 를 WHERE 에 쓰지 않는다 (인덱스 무력화 방지).
구 제한은 행정동코드 접두 범위 비교 `>= gu AND < gu+1` 로 표현한다.
"""

# ── 화이트리스트 ─────────────────────────────────────────────────────────────
_VALID_LEVELS = {"gu", "dong", "grid"}
_VALID_SOURCES = {"mart", "raw"}
_VALID_WEEKDAY = {"전체", "주중", "주말"}
_VALID_MODES = {"month", "week", "day"}

# 격자 코드 컬럼명: 데이터소스별 (분기 핵심)
_GRID_COL = {"mart": "`격자코드`", "raw": "`250M격자`"}


# ══════════════════════════════════════════════════════════════════════════════
# 공유 헬퍼
# ══════════════════════════════════════════════════════════════════════════════
def _gu_end(gu: str) -> str:
    """구 접두 범위의 배타 상한. '11680' → '11681' (선행 0 보존).

    행정동코드는 '구코드(5) + 동(3)' 구조이므로, 같은 구의 모든 행정동코드는
    [gu, gu+1) 범위에 속한다. zfill(len) 으로 자릿수/선행 0 유지.
    """
    return str(int(gu) + 1).zfill(len(gu))


def code_expr(level: str, source: str) -> str:
    """공간 그룹 키 표현식 (SELECT/GROUP BY 에 사용).

    Parameters
    ----------
    level : {"gu","dong","grid"}
    source : {"mart","raw"}  — grid 일 때만 컬럼명 분기에 영향.

    Returns
    -------
    str  — 백틱 포함 컬럼/표현식.

    Raises
    ------
    ValueError  — level/source 가 화이트리스트 밖.
    """
    if level not in _VALID_LEVELS:
        raise ValueError(f"level={level!r} 는 {sorted(_VALID_LEVELS)} 중 하나여야 합니다.")
    if source not in _VALID_SOURCES:
        raise ValueError(f"source={source!r} 는 {sorted(_VALID_SOURCES)} 중 하나여야 합니다.")

    if level == "gu":
        return "LEFT(`행정동코드`,5)"
    if level == "dong":
        return "`행정동코드`"
    # level == "grid" — 데이터소스 분기
    return _GRID_COL[source]


def scope_clause(level: str, gu: str | None, dong: str | None) -> tuple[str, tuple]:
    """부모 영역 제한 절(WHERE 추가 단편) + params 생성 (SARGable).

    - gu   : 전체 서울 → 제한 없음.
    - dong : 구 `gu` 범위로 제한 (접두 범위 비교).
    - grid : dong 우선(동등 비교); 없으면 gu 범위(A-2 구 전체 격자).

    Returns
    -------
    (fragment, params) — fragment 는 ' AND ...' 로 시작하거나 빈 문자열.

    Raises
    ------
    ValueError  — dong level 에 gu 없음 / grid level 에 gu·dong 모두 없음 /
                  잘못된 level.
    """
    if level not in _VALID_LEVELS:
        raise ValueError(f"level={level!r} 는 {sorted(_VALID_LEVELS)} 중 하나여야 합니다.")

    if level == "gu":
        return "", ()

    if level == "dong":
        if not gu:
            raise ValueError("dong level 은 gu 가 필요합니다.")
        return ("AND `행정동코드` >= %s AND `행정동코드` < %s", (gu, _gu_end(gu)))

    # level == "grid"
    if dong:
        return ("AND `행정동코드` = %s", (dong,))
    if gu:
        return ("AND `행정동코드` >= %s AND `행정동코드` < %s", (gu, _gu_end(gu)))
    raise ValueError("grid level 은 gu 또는 dong 이 필요합니다.")


def _weekday_in(weekday: str) -> tuple[str, tuple]:
    """주중주말 IN 단편 + params. 전체 → ('주중','주말')."""
    if weekday not in _VALID_WEEKDAY:
        raise ValueError(f"weekday={weekday!r} 는 {sorted(_VALID_WEEKDAY)} 중 하나여야 합니다.")
    if weekday == "전체":
        vals = ("주중", "주말")
    else:
        vals = (weekday,)
    placeholders = ",".join(["%s"] * len(vals))
    return f"IN ({placeholders})", vals


def _hours_in(hours: list) -> tuple[str, tuple]:
    """시간 IN 단편 + params. 각 시간은 0..23 정수여야 함."""
    if not hours:
        raise ValueError("hours 는 비어 있을 수 없습니다.")
    vals = []
    for h in hours:
        if not isinstance(h, int) or isinstance(h, bool) or not (0 <= h <= 23):
            raise ValueError(f"시간 {h!r} 가 0..23 범위의 정수가 아닙니다.")
        vals.append(h)
    placeholders = ",".join(["%s"] * len(vals))
    return f"IN ({placeholders})", tuple(vals)


# ══════════════════════════════════════════════════════════════════════════════
# 1) build_month_sql — 월 (mart)
# ══════════════════════════════════════════════════════════════════════════════
def build_month_sql(
    level: str,
    period_yeonwol: str,
    gu: str | None,
    dong: str | None,
    hours: list,
    weekday: str,
    metric: str,
) -> tuple[str, tuple]:
    """월 집계 SQL (마트_월_시간).

    grid level 은 각 격자가 속한 `행정동코드` 도 함께 반환한다(동별 격자 분포용).
    각 격자코드는 하나의 행정동코드에 대응하므로 MAX() 로 안전하게 가져온다.

    params 순서: (연월, *weekday, *hours, *scope).
    """
    code = code_expr(level, "mart")
    dong_sel = ", MAX(`행정동코드`) AS 행정동코드" if level == "grid" else ""
    wd_frag, wd_params = _weekday_in(weekday)
    hr_frag, hr_params = _hours_in(hours)
    sc_frag, sc_params = scope_clause(level, gu, dong)

    sql = (
        f"SELECT {code} AS code, {metric} AS 합계{dong_sel}\n"
        f"FROM `마트_월_시간`\n"
        f"WHERE `연월`=%s AND `주중주말` {wd_frag} AND `시간` {hr_frag} {sc_frag}\n"
        f"GROUP BY code"
    )
    params = (period_yeonwol, *wd_params, *hr_params, *sc_params)
    return sql, params


# ══════════════════════════════════════════════════════════════════════════════
# 2) build_week_sql — 주 (raw + 달력, 파티션 프루닝)
# ══════════════════════════════════════════════════════════════════════════════
def build_week_sql(
    level: str,
    period_yeonju: str,
    gu: str | None,
    dong: str | None,
    hours: list,
    weekday: str,
    metric: str,
) -> tuple[str, tuple]:
    """주 집계 SQL (생활인구_250m + 달력 서브쿼리).

    달력에서 (연주, 주중주말) 에 해당하는 일자 집합을 뽑아 `일자 IN (...)` 로
    raw 의 월-RANGE 파티션을 프루닝한다. raw 인덱스 ix_일자 존재 가정(호출자 책임).

    grid level 은 각 격자가 속한 `행정동코드` 도 함께 반환한다(동별 격자 분포용).

    params 순서: (연주, *weekday, *hours, *scope).
    """
    code = code_expr(level, "raw")
    dong_sel = ", MAX(`행정동코드`) AS 행정동코드" if level == "grid" else ""
    wd_frag, wd_params = _weekday_in(weekday)
    hr_frag, hr_params = _hours_in(hours)
    sc_frag, sc_params = scope_clause(level, gu, dong)

    sql = (
        f"SELECT {code} AS code, {metric} AS 합계{dong_sel}\n"
        f"FROM `생활인구_250m`\n"
        f"WHERE `일자` IN (SELECT `일자` FROM `달력` WHERE `연주`=%s AND `주중주말` {wd_frag})\n"
        f"  AND `시간` {hr_frag} {sc_frag}\n"
        f"GROUP BY code"
    )
    params = (period_yeonju, *wd_params, *hr_params, *sc_params)
    return sql, params


# ══════════════════════════════════════════════════════════════════════════════
# 3) build_day_sql — 일 (raw, 시간별 시계열)
# ══════════════════════════════════════════════════════════════════════════════
def build_day_sql(
    level: str,
    period_date: str,
    gu: str | None,
    dong: str | None,
    metric: str,
) -> tuple[str, tuple]:
    """일 집계 SQL (생활인구_250m, 시간별).

    일 모드 = 시간대별 변화 시계열. 주중주말·시간 필터·일평균 없음.
    단일 일자라 `일자=%s` 가 그대로 파티션 프루닝.

    grid level 은 각 격자가 속한 `행정동코드` 도 함께 반환한다(동별 격자 분포용).

    params 순서: (일자, *scope).
    """
    code = code_expr(level, "raw")
    dong_sel = ", MAX(`행정동코드`) AS 행정동코드" if level == "grid" else ""
    sc_frag, sc_params = scope_clause(level, gu, dong)

    sql = (
        f"SELECT `시간` AS 시간, {code} AS code, {metric} AS 합계{dong_sel}\n"
        f"FROM `생활인구_250m`\n"
        f"WHERE `일자`=%s {sc_frag}\n"
        f"GROUP BY `시간`, code\n"
        f"ORDER BY `시간`"
    )
    params = (period_date, *sc_params)
    return sql, params


# ══════════════════════════════════════════════════════════════════════════════
# 3b) build_grid_breakdown_sql — 구 내 격자 × 행정동 portion 분해 (경계셀 동별)
# ══════════════════════════════════════════════════════════════════════════════
def build_grid_breakdown_sql(
    mode: str,
    period: str,
    gu: str,
    hours: list,
    weekday: str,
    metric: str,
) -> tuple[str, tuple]:
    """A-2(구 전체) 격자 뷰의 경계셀을 **동별로 분해**하는 SQL (month|week).

    메인 격자 쿼리(build_month_sql/build_week_sql)는 `GROUP BY 격자코드`로 동을 합쳐
    한 셀당 한 값(=구 안 합계)을 낸다. 한 격자가 구 안의 여러 행정동에 걸치면
    (서울 데이터는 경계 격자를 행정동별로 쪼개 적재) 그 분해가 사라진다. 이 쿼리는
    `GROUP BY 격자코드, 행정동코드`로 **격자×행정동 portion**을 그대로 돌려줘, 프론트가
    툴팁에 "총합 + 동별 portion"을 표시할 수 있게 한다. 채색/값은 메인 쿼리 그대로 두고
    이 분해는 부가 정보로만 쓴다(저위험).

    gu 범위는 `행정동코드 >= gu AND < gu+1` (SARGable, scope_clause 재사용).
    params 순서: (period, *weekday, *hours, *gu범위).
    """
    if not gu:
        raise ValueError("grid_breakdown 은 gu 가 필요합니다.")
    wd_frag, wd_params = _weekday_in(weekday)
    hr_frag, hr_params = _hours_in(hours)
    sc_frag, sc_params = scope_clause("grid", gu, None)  # AND 행정동코드 >= gu AND < gu_end

    if mode == "month":
        grid_col = _GRID_COL["mart"]
        sql = (
            f"SELECT {grid_col} AS 격자코드, `행정동코드`, {metric} AS 합계\n"
            f"FROM `마트_월_시간`\n"
            f"WHERE `연월`=%s AND `주중주말` {wd_frag} AND `시간` {hr_frag} {sc_frag}\n"
            f"GROUP BY {grid_col}, `행정동코드`"
        )
        params = (period, *wd_params, *hr_params, *sc_params)
        return sql, params
    if mode == "week":
        grid_col = _GRID_COL["raw"]
        sql = (
            f"SELECT {grid_col} AS 격자코드, `행정동코드`, {metric} AS 합계\n"
            f"FROM `생활인구_250m`\n"
            f"WHERE `일자` IN (SELECT `일자` FROM `달력` WHERE `연주`=%s AND `주중주말` {wd_frag})\n"
            f"  AND `시간` {hr_frag} {sc_frag}\n"
            f"GROUP BY {grid_col}, `행정동코드`"
        )
        params = (period, *wd_params, *hr_params, *sc_params)
        return sql, params
    raise ValueError(f"grid_breakdown mode={mode!r} 는 month|week 만 지원합니다.")


# ══════════════════════════════════════════════════════════════════════════════
# 4) day_count_sql — 일수 (일평균 분모; 실제 적재일 기준 ∩ _적재로그)
# ══════════════════════════════════════════════════════════════════════════════
def day_count_sql(mode: str, period: str, weekday: str) -> tuple[str | None, tuple]:
    """일평균 산출용 '일수' 쿼리.

    달력의 (기간, 주중주말) 일자 중 **실제 raw 에 적재된** 일자만 센다
    (`_적재로그` EXISTS). 달력만 세면 미적재 미래일까지 포함되어 일평균이 왜곡됨.

    - mode="month" : period=연월, `달력.연월`=%s.
    - mode="week"  : period=연주, `달력.연주`=%s.
    - mode="day"   : 일평균 개념 없음 → (None, ()).

    params 순서: (period, *weekday).
    """
    if mode not in _VALID_MODES:
        raise ValueError(f"mode={mode!r} 는 {sorted(_VALID_MODES)} 중 하나여야 합니다.")
    if mode == "day":
        return None, ()

    wd_frag, wd_params = _weekday_in(weekday)
    period_col = "연월" if mode == "month" else "연주"

    sql = (
        f"SELECT COUNT(*) AS 일수\n"
        f"FROM `달력` d\n"
        f"WHERE d.`{period_col}`=%s AND d.`주중주말` {wd_frag}\n"
        f"  AND EXISTS (SELECT 1 FROM `_적재로그` l WHERE l.`일자`=d.`일자`)"
    )
    params = (period, *wd_params)
    return sql, params


# ══════════════════════════════════════════════════════════════════════════════
# 5) 월별 추이 — 단일 영역 헬퍼
# ══════════════════════════════════════════════════════════════════════════════
def _single_code_clause(level: str, code: str) -> tuple[str, tuple]:
    """단일 영역(코드 1개) 제한 절 + params (SARGable, 인젝션 안전).

    - gu   : 행정동코드 접두 범위 비교 `>= code AND < gu_end` (LEFT() 미사용).
             code 는 숫자 5자리여야 한다 (_gu_end 가드와 동일 계약).
    - dong : `행정동코드` = code.
    - grid : `격자코드` = code (mart 컬럼명).

    Returns
    -------
    (fragment, params) — fragment 는 'AND ...' 로 시작.

    Raises
    ------
    ValueError — level 화이트리스트 밖 / code 비어있음 / gu code 가 비숫자·비5자리.
    """
    if level not in _VALID_LEVELS:
        raise ValueError(f"level={level!r} 는 {sorted(_VALID_LEVELS)} 중 하나여야 합니다.")
    if not code:
        raise ValueError("code 는 비어 있을 수 없습니다.")

    if level == "gu":
        if not (code.isdigit() and len(code) == 5):
            raise ValueError(f"gu code={code!r} 는 숫자 5자리여야 합니다.")
        return ("AND `행정동코드` >= %s AND `행정동코드` < %s", (code, _gu_end(code)))
    if level == "dong":
        return ("AND `행정동코드` = %s", (code,))
    # level == "grid"
    return ("AND `격자코드` = %s", (code,))


def build_trend_sql(
    level: str,
    code: str,
    hours: list,
    weekday: str,
    metric: str,
) -> tuple[str, tuple]:
    """월별 추이 SQL (마트_월_시간) — 단일 영역, 연월별 합계.

    공간 그룹핑 대신 단일 코드로 필터하고 `연월` 기준으로 묶어 모든 연월의
    시계열을 한 번에 반환한다. 시간/주중주말/성별/연령 필터 의미는 월 쿼리와 동일.

    params 순서: (*weekday, *hours, *code).
    """
    cd_frag, cd_params = _single_code_clause(level, code)
    wd_frag, wd_params = _weekday_in(weekday)
    hr_frag, hr_params = _hours_in(hours)

    sql = (
        f"SELECT `연월` AS 연월, {metric} AS 합계\n"
        f"FROM `마트_월_시간`\n"
        f"WHERE `주중주말` {wd_frag} AND `시간` {hr_frag} {cd_frag}\n"
        f"GROUP BY `연월`\n"
        f"ORDER BY `연월`"
    )
    params = (*wd_params, *hr_params, *cd_params)
    return sql, params


# ══════════════════════════════════════════════════════════════════════════════
# 5b) 주/일 추이 — raw(생활인구_250m) 단일 영역, 최근 날짜창
# ══════════════════════════════════════════════════════════════════════════════
def _single_code_clause_raw(level: str, code: str) -> tuple[str, tuple]:
    """raw(생활인구_250m) 용 단일 영역 제한 절 + params (SARGable, 인젝션 안전).

    `_single_code_clause` 의 raw 버전. 차이는 grid 격자 컬럼명뿐이다:
    raw 는 `250M격자`, mart 는 `격자코드`. gu/dong 은 `행정동코드` 로 동일하다.

    - gu   : 행정동코드 접두 범위 `>= code AND < gu_end` (숫자 5자리 계약).
    - dong : `행정동코드` = code.
    - grid : `250M격자` = code (raw 컬럼명).

    Raises
    ------
    ValueError — level 화이트리스트 밖 / code 비어있음 / gu code 가 비숫자·비5자리.
    """
    if level not in _VALID_LEVELS:
        raise ValueError(f"level={level!r} 는 {sorted(_VALID_LEVELS)} 중 하나여야 합니다.")
    if not code:
        raise ValueError("code 는 비어 있을 수 없습니다.")

    if level == "gu":
        if not (code.isdigit() and len(code) == 5):
            raise ValueError(f"gu code={code!r} 는 숫자 5자리여야 합니다.")
        return ("AND `행정동코드` >= %s AND `행정동코드` < %s", (code, _gu_end(code)))
    if level == "dong":
        return ("AND `행정동코드` = %s", (code,))
    # level == "grid" — raw 격자 컬럼명
    return ("AND `250M격자` = %s", (code,))


def build_trend_week_sql(
    level: str,
    code: str,
    date_start: str,
    date_end: str,
    hours: list,
    weekday: str,
    metric: str,
) -> tuple[str, tuple]:
    """주별 추이 SQL (생활인구_250m + 달력) — 단일 영역, 연주별 합계.

    build_week_sql 의 영역 필터 + metric 을 단일 코드로 좁히고, **연주별로** 묶는다.
    [date_start, date_end] 날짜창으로 제한해 raw 의 월-RANGE 파티션 프루닝 +
    복합 인덱스(`행정동코드`/`250M격자`, `일자`) 레인지 스캔을 타게 한다.

    연주 라벨은 달력을 INNER JOIN 하여 가져온다 (raw 자체엔 연주 컬럼 없음).
    날짜창은 호출자(라우트)가 '최근 ~12주' 경계로 계산해 넘긴다.

    params 순서: (date_start, date_end, *weekday, *hours, *code).

    Returns
    -------
    (sql, params) — 행: {연주, 합계}, 연주 오름차순.
    """
    cd_frag, cd_params = _single_code_clause_raw(level, code)
    wd_frag, wd_params = _weekday_in(weekday)
    hr_frag, hr_params = _hours_in(hours)

    sql = (
        f"SELECT c.`연주` AS 연주, {metric} AS 합계\n"
        f"FROM `생활인구_250m` r\n"
        f"JOIN `달력` c ON c.`일자` = r.`일자`\n"
        f"WHERE r.`일자` >= %s AND r.`일자` <= %s\n"
        f"  AND c.`주중주말` {wd_frag} AND r.`시간` {hr_frag} {cd_frag}\n"
        f"GROUP BY c.`연주`\n"
        f"ORDER BY c.`연주`"
    )
    params = (date_start, date_end, *wd_params, *hr_params, *cd_params)
    return sql, params


def build_trend_day_sql(
    level: str,
    code: str,
    date_start: str,
    date_end: str,
    hours: list,
    weekday: str,
    metric: str,
) -> tuple[str, tuple]:
    """일별 추이 SQL (생활인구_250m) — 단일 영역, 일자별 합계.

    build_day_sql 와 달리 시간별이 아니라 **일자별** 합계(하루 1점)를 낸다.
    [date_start, date_end] 날짜창 + 단일 코드로 좁혀 파티션 프루닝 + 복합 인덱스
    (`행정동코드`/`250M격자`, `일자`) 레인지 스캔을 탄다.

    weekday 가 '주중'/'주말' 이면 달력 INNER JOIN 으로 해당 일자만 남긴다
    (동일요일 계열에선 weekday='전체' 로 호출되어 JOIN 이 생략된다).
    hours 는 0..23 부분 시간대 필터 (프론트 평균 = 합계 / (1 × 시간수) 와 일관).

    params 순서:
      weekday=전체 : (date_start, date_end, *hours, *code)
      weekday!=전체: (date_start, date_end, *weekday, *hours, *code)

    Returns
    -------
    (sql, params) — 행: {일자, 합계}, 일자 오름차순.
    """
    cd_frag, cd_params = _single_code_clause_raw(level, code)
    hr_frag, hr_params = _hours_in(hours)

    if weekday == "전체":
        # 달력 JOIN 불필요 — raw 단독 (가장 빠름).
        sql = (
            f"SELECT r.`일자` AS 일자, {metric} AS 합계\n"
            f"FROM `생활인구_250m` r\n"
            f"WHERE r.`일자` >= %s AND r.`일자` <= %s\n"
            f"  AND r.`시간` {hr_frag} {cd_frag}\n"
            f"GROUP BY r.`일자`\n"
            f"ORDER BY r.`일자`"
        )
        params = (date_start, date_end, *hr_params, *cd_params)
        return sql, params

    # 주중/주말 — 달력으로 해당 일자만 필터.
    wd_frag, wd_params = _weekday_in(weekday)
    sql = (
        f"SELECT r.`일자` AS 일자, {metric} AS 합계\n"
        f"FROM `생활인구_250m` r\n"
        f"JOIN `달력` c ON c.`일자` = r.`일자`\n"
        f"WHERE r.`일자` >= %s AND r.`일자` <= %s\n"
        f"  AND c.`주중주말` {wd_frag} AND r.`시간` {hr_frag} {cd_frag}\n"
        f"GROUP BY r.`일자`\n"
        f"ORDER BY r.`일자`"
    )
    params = (date_start, date_end, *wd_params, *hr_params, *cd_params)
    return sql, params


def build_trend_same_weekday_sql(
    level: str,
    code: str,
    date_start: str,
    date_end: str,
    yoil: int,
    hours: list,
    metric: str,
) -> tuple[str, tuple]:
    """동일요일 일별 추이 SQL (생활인구_250m + 달력) — 단일 영역.

    [date_start, date_end] 날짜창에서 달력 `요일` 이 `yoil` 인 일자만(예: 모든 금요일)
    골라 일자별 합계를 낸다. 날짜창 파티션 프루닝 + 복합 인덱스 레인지 스캔을 탄다.

    `yoil` 은 달력의 정수 요일값(검증된 정수만 허용 — 인젝션 안전)으로,
    라우트가 최신 적재일의 요일을 조회해 넘긴다. 주중주말 필터는 적용하지 않는다
    (요일이 곧 주중/주말을 결정하므로 중복).

    params 순서: (date_start, date_end, yoil, *hours, *code).

    Returns
    -------
    (sql, params) — 행: {일자, 합계}, 일자 오름차순.
    """
    if not isinstance(yoil, int) or isinstance(yoil, bool):
        raise ValueError(f"yoil={yoil!r} 는 정수여야 합니다.")
    cd_frag, cd_params = _single_code_clause_raw(level, code)
    hr_frag, hr_params = _hours_in(hours)

    sql = (
        f"SELECT r.`일자` AS 일자, {metric} AS 합계\n"
        f"FROM `생활인구_250m` r\n"
        f"JOIN `달력` c ON c.`일자` = r.`일자`\n"
        f"WHERE r.`일자` >= %s AND r.`일자` <= %s\n"
        f"  AND c.`요일` = %s AND r.`시간` {hr_frag} {cd_frag}\n"
        f"GROUP BY r.`일자`\n"
        f"ORDER BY r.`일자`"
    )
    params = (date_start, date_end, yoil, *hr_params, *cd_params)
    return sql, params


# ══════════════════════════════════════════════════════════════════════════════
# 5c) 전체 구 추이 — 25개 자치구를 한 번에 (구별 비교용 라인차트)
# ══════════════════════════════════════════════════════════════════════════════
def build_trend_all_gu_sql(
    mode: str,
    date_start: str | None,
    date_end: str | None,
    hours: list,
    weekday: str,
    metric: str,
) -> tuple[str, tuple]:
    """모든 자치구의 추이를 한 번에 — `LEFT(행정동코드,5)` 로 구별 그룹.

    단일 영역 추이(build_trend_*)의 구별 버전. 25개 구 × 기간 라벨을 한 쿼리로 낸다.
    - month : 마트_월_시간, 구×연월 (전체 기간, 빠름).
    - week  : 생활인구_250m+달력, 구×연주 (date 창 = 최근 ~12주).
    - day   : 생활인구_250m, 구×일자 (date 창 = 최근 ~30일).
    프론트 평균 = 합계 / (일수 × 시간수); day 는 일수=1. 라벨 = 연월/연주/일자.

    params 순서:
      month : (*weekday, *hours)
      week  : (date_start, date_end, *weekday, *hours)
      day   : (date_start, date_end, *hours)
    """
    wd_frag, wd_params = _weekday_in(weekday)
    hr_frag, hr_params = _hours_in(hours)

    if mode == "month":
        # 구-월 요약 마트(마트_구_월_시간, ~36K행)를 조회 — 전체 구 집계도 즉시.
        # (마트_월_시간 직접 집계는 마트 전체 스캔이라 120s+; 04b.build_gu_mart 참고)
        sql = (
            f"SELECT `구코드` AS 구, `연월` AS 라벨, {metric} AS 합계\n"
            f"FROM `마트_구_월_시간`\n"
            f"WHERE `주중주말` {wd_frag} AND `시간` {hr_frag}\n"
            f"GROUP BY `구코드`, `연월`\n"
            f"ORDER BY `구코드`, `연월`"
        )
        return sql, (*wd_params, *hr_params)
    # 주/일은 구-일 요약 마트(마트_구_일_시간, ~530K행)를 조회 — raw 직접은 전체 스캔이라
    # 120s+ (04c.build_gu_day_mart 참고). 연주/주중주말은 달력 JOIN 으로 파생.
    if mode == "week":
        sql = (
            f"SELECT s.`구코드` AS 구, c.`연주` AS 라벨, {metric} AS 합계\n"
            f"FROM `마트_구_일_시간` s\n"
            f"JOIN `달력` c ON c.`일자` = s.`일자`\n"
            f"WHERE s.`일자` >= %s AND s.`일자` <= %s\n"
            f"  AND c.`주중주말` {wd_frag} AND s.`시간` {hr_frag}\n"
            f"GROUP BY s.`구코드`, c.`연주`\n"
            f"ORDER BY s.`구코드`, c.`연주`"
        )
        return sql, (date_start, date_end, *wd_params, *hr_params)
    if mode == "day":
        if weekday == "전체":
            sql = (
                f"SELECT s.`구코드` AS 구, s.`일자` AS 라벨, {metric} AS 합계\n"
                f"FROM `마트_구_일_시간` s\n"
                f"WHERE s.`일자` >= %s AND s.`일자` <= %s AND s.`시간` {hr_frag}\n"
                f"GROUP BY s.`구코드`, s.`일자`\n"
                f"ORDER BY s.`구코드`, s.`일자`"
            )
            return sql, (date_start, date_end, *hr_params)
        sql = (
            f"SELECT s.`구코드` AS 구, s.`일자` AS 라벨, {metric} AS 합계\n"
            f"FROM `마트_구_일_시간` s\n"
            f"JOIN `달력` c ON c.`일자` = s.`일자`\n"
            f"WHERE s.`일자` >= %s AND s.`일자` <= %s\n"
            f"  AND c.`주중주말` {wd_frag} AND s.`시간` {hr_frag}\n"
            f"GROUP BY s.`구코드`, s.`일자`\n"
            f"ORDER BY s.`구코드`, s.`일자`"
        )
        return sql, (date_start, date_end, *wd_params, *hr_params)
    raise ValueError(f"mode={mode!r} 는 month|week|day 중 하나여야 합니다.")


def week_trend_day_count_sql(
    date_start: str, date_end: str, weekday: str
) -> tuple[str, tuple]:
    """주별 추이용 '일수' 쿼리 — 날짜창 내 연주별 실제 적재일수.

    `trend_day_count_sql` 의 연주 버전 + 날짜창 제한. 달력의 [date_start, date_end]
    (연주, 주중주말) 일자 중 **실제 raw 에 적재된** 일자(`_적재로그` EXISTS)만 센다.
    build_trend_week_sql 과 같은 날짜창·주중주말 필터를 써서 분모가 일관된다.

    params 순서: (date_start, date_end, *weekday).

    Returns
    -------
    (sql, params) — 행: {연주, 일수}.
    """
    wd_frag, wd_params = _weekday_in(weekday)
    sql = (
        f"SELECT d.`연주` AS 연주, COUNT(*) AS 일수\n"
        f"FROM `달력` d\n"
        f"WHERE d.`일자` >= %s AND d.`일자` <= %s AND d.`주중주말` {wd_frag}\n"
        f"  AND EXISTS (SELECT 1 FROM `_적재로그` l WHERE l.`일자`=d.`일자`)\n"
        f"GROUP BY d.`연주`"
    )
    params = (date_start, date_end, *wd_params)
    return sql, params


def trend_day_count_sql(weekday: str) -> tuple[str, tuple]:
    """월별 추이용 '일수' 쿼리 — 연월별 실제 적재일수 (달력 ∩ _적재로그).

    day_count_sql 의 (달력 ∩ _적재로그) 로직을 연월 단위로 그룹화한 버전.
    주중주말 필터는 일수 분모에도 동일 적용된다 (월 쿼리와 일관).

    params 순서: (*weekday).

    Returns
    -------
    (sql, params) — 행: {연월, 일수}, 연월 오름차순.
    """
    wd_frag, wd_params = _weekday_in(weekday)
    sql = (
        f"SELECT d.`연월` AS 연월, COUNT(*) AS 일수\n"
        f"FROM `달력` d\n"
        f"WHERE d.`주중주말` {wd_frag}\n"
        f"  AND EXISTS (SELECT 1 FROM `_적재로그` l WHERE l.`일자`=d.`일자`)\n"
        f"GROUP BY d.`연월`"
    )
    return sql, tuple(wd_params)
