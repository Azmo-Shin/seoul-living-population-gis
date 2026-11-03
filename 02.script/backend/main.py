# -*- coding: utf-8 -*-
"""main.py — 서울 생활인구 GIS FastAPI 백엔드.

구→동→격자 드릴다운 + 일/주/월 시간집계 지도 데이터 API.
포트 9601, API 전용 (프론트엔드는 별도 서버 9600에서 서빙).
"""
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import API_PORT, FRONT_ORIGINS, SPATIAL_DIR

# ── 로깅 설정 ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


# ── Lifespan ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    """서버 시작/종료 시 초기화 및 정리."""
    logger.info("=" * 60)
    logger.info("서울 생활인구 GIS API 서버 시작 (포트 %s)", API_PORT)
    logger.info("=" * 60)
    logger.info("SPATIAL_DIR: %s (exists=%s)", SPATIAL_DIR, SPATIAL_DIR.exists())
    yield
    # shutdown: 후속 태스크에서 teardown 추가


# ── FastAPI 앱 ──
app = FastAPI(
    title="서울 생활인구 GIS API",
    version="1.0.0",
    description="서울 250m 격자 생활인구 드릴다운 분석 API",
    lifespan=lifespan,
)

# ── CORS ──
app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONT_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# ── 라우터 등록 ──
from api.routes_meta import router as meta_router  # Task 3
app.include_router(meta_router)

from api.routes_geo import router as geo_router    # Task 4
app.include_router(geo_router)

from api.routes_query import router as query_router  # Task 7
app.include_router(query_router)


# ── Health check ──
@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    """서버 상태 확인."""
    return {"ok": True}


# ── 직접 실행 ──
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=API_PORT, reload=False)
