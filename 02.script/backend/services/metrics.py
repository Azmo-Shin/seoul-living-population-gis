# -*- coding: utf-8 -*-
"""services/metrics.py — UI 성별·연령 선택 → SQL 집계 표현식 매핑.

단일 책임: metric_expr() 순수 함수 하나.
- DB·HTTP 의존 없음.
- 생성하는 컬럼명은 config.AGE_BUCKETS 화이트리스트에서만 가져오므로
  SQL 인젝션 안전.
- NULL 안전 설계: COALESCE(SUM(`col`),0) 을 컬럼별로 독립 적용한 뒤 덧셈.
  SUM(`a` + `b`) 패턴은 한 컬럼이라도 NULL 이면 행 전체를 무효화하므로 금지.
"""
from config import AGE_BUCKETS

# 정규 원자 연령 레이블 순서 (AGE_BUCKETS 삽입 순서 그대로 유지)
_ALL_ATOMIC: list[str] = [
    atomic
    for labels in AGE_BUCKETS.values()
    for atomic in labels
]

_VALID_SEX = {"전체", "남", "여"}

# UI sex 값 → 마트 컬럼 접두사 목록 (남자 먼저 고정)
_SEX_PREFIXES: dict[str, list[str]] = {
    "전체": ["남자", "여자"],
    "남":   ["남자"],
    "여":   ["여자"],
}


def metric_expr(sex: str, ages: list[str]) -> str:
    """UI 성별·연령 선택을 SQL SELECT 집계 표현식으로 변환한다.

    Parameters
    ----------
    sex:
        "전체" | "남" | "여"
    ages:
        AGE_BUCKETS 키 목록 (e.g. ["20대","30대"]).
        빈 리스트 [] 는 전체 연령을 의미한다.

    Returns
    -------
    str
        SELECT 절에 바로 쓸 수 있는 SQL 표현식.
        예) "COALESCE(SUM(`생활인구합계`),0)"
            "(COALESCE(SUM(`남자 20~24세`),0) + COALESCE(SUM(`남자 25~29세`),0))"

    Raises
    ------
    ValueError
        sex 가 유효 값 외이거나 ages 에 알 수 없는 버킷이 포함된 경우.
    """
    # ── 유효성 검사 ──────────────────────────────────────────────────────────
    if sex not in _VALID_SEX:
        raise ValueError(
            f"sex={sex!r} 는 유효하지 않습니다. 허용 값: {sorted(_VALID_SEX)}"
        )
    for bucket in ages:
        if bucket not in AGE_BUCKETS:
            raise ValueError(
                f"age 버킷 {bucket!r} 가 AGE_BUCKETS 에 없습니다. "
                f"허용 버킷: {list(AGE_BUCKETS)}"
            )

    # ── 단축 경로: 전체 성별 + 전체 연령 ────────────────────────────────────
    if sex == "전체" and not ages:
        return "COALESCE(SUM(`생활인구합계`),0)"

    # ── 원자 연령 레이블 결정 (정규 순서 유지) ───────────────────────────────
    if ages:
        # 지정된 버킷만 확장; 정규 순서 준수 + 중복 제거
        seen: set[str] = set()
        atomic_ages: list[str] = []
        for bucket in ages:
            for label in AGE_BUCKETS[bucket]:
                if label not in seen:
                    seen.add(label)
                    atomic_ages.append(label)
        # 정규 순서로 재정렬 (여러 버킷이 넘어올 때 순서 보장)
        canonical_idx = {label: i for i, label in enumerate(_ALL_ATOMIC)}
        atomic_ages.sort(key=lambda lbl: canonical_idx[lbl])
    else:
        atomic_ages = _ALL_ATOMIC  # 전체 14개

    # ── 성별 접두사 결정 ─────────────────────────────────────────────────────
    prefixes = _SEX_PREFIXES[sex]  # ["남자"] or ["여자"] or ["남자","여자"]

    # ── 컬럼별 COALESCE(SUM(`col`),0) 항 생성 ───────────────────────────────
    # 접두사 순 × 원자연령 순 — 남자가 항상 앞에 온다
    terms: list[str] = [
        f"COALESCE(SUM(`{prefix} {atomic}`),0)"
        for prefix in prefixes
        for atomic in atomic_ages
    ]

    # 여러 항을 + 로 연결, 전체를 괄호로 감쌈
    return "(" + " + ".join(terms) + ")"
