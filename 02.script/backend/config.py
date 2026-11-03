# -*- coding: utf-8 -*-
"""config.py — 서울 생활인구 GIS 백엔드 상수·경로·설정."""
import os
from pathlib import Path

# ── Paths ──
# backend/config.py → 02.script/backend → 02.script → 2026_06_GIS → 03.result/spatial
SPATIAL_DIR: Path = Path(__file__).resolve().parent.parent.parent / "03.result" / "spatial"

# ── Server ──
API_PORT: int = int(os.getenv("PORT", 9601))

# ── CORS ──
FRONT_ORIGINS: list[str] = [
    "http://localhost:9600",
    "http://127.0.0.1:9600",
]

# ── 연령 버킷 → 마트 컬럼 접미사 매핑 ──
# UI 10세 단위 버킷을 마트 원자 컬럼(남자/여자 접두사 제외한 기본명)으로 확장.
# 주의: 0대는 1개, 70대이상은 1개(비대칭).
AGE_BUCKETS: dict[str, list[str]] = {
    "0대":      ["0~9세"],
    "10대":     ["10~14세", "15~19세"],
    "20대":     ["20~24세", "25~29세"],
    "30대":     ["30~34세", "35~39세"],
    "40대":     ["40~44세", "45~49세"],
    "50대":     ["50~54세", "55~59세"],
    "60대":     ["60~64세", "65~69세"],
    "70대이상": ["70세 이상"],
}
