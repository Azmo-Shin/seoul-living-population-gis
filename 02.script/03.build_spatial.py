# -*- coding: utf-8 -*-
"""
03.build_spatial.py  ─  공간 차원 빌드 (shp → WGS84 GeoJSON + DB 차원 테이블)
================================================================================
원천 shp 3종을 WGS84(EPSG:4326)로 변환해
  · 프론트 지도용 GeoJSON (구/동/격자)  → 03.result/spatial/
  · 조회용 코드↔이름 매핑 DB 테이블     → shin_project.공간_시군구 / 공간_행정동 / 공간_격자

키 정합 (검증됨):
  · 행정동 shp ADSTRD_CD == 생활인구 행정동코드
  · 격자  shp CELL_ID   == 생활인구 250M격자
  · 구    = 행정동코드 앞 5자리(prefix5)  ← 데이터 롤업 기준. 구명은 시군구 shp와 공간조인으로 부여.

사용:
  python 03.build_spatial.py
  python 03.build_spatial.py --out ../03.result/spatial
================================================================================
"""
import argparse
import importlib.util
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    import geopandas as gpd
except Exception:
    sys.exit("❌ geopandas 필요: pip install geopandas")

WGS84 = 4326
RAW = Path(r"<LOCAL_PATH>")
SHP_GU   = RAW / "서울_시군구" / "서울_시군구_구분.shp"
SHP_DONG = RAW / "서울시 상권분석서비스(영역-행정동)" / "서울시 상권분석서비스(영역-행정동).shp"
SHP_GRID = RAW / "서울시_250m격자" / "match" / "match.shp"


def load_ingest():
    p = Path(__file__).resolve().parent / "00.input_data.py"
    spec = importlib.util.spec_from_file_location("ingest", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── 행정동 코드 vintage 정합 ───────────────────────────────────────────────────
# 상권분석 행정동 SHP(구버전)을 생활인구 데이터의 행정동코드 체계에 맞춘다. 데이터엔
# 있으나 SHP엔 없는 3개를 보정(전수 비교로 확인된 케이스):
#   · 일원2동 : 같은 동인데 코드만 다름 → 데이터 코드로 리코딩 (지오/이름 유지)
#   · 상일동  : 데이터에선 상일1·2동으로 분동 → 마트 격자 멤버십으로 SHP 폴리곤 분할
_RECODE_DONG = {"11680740": "11680675"}  # 일원2동: SHP코드 → 데이터코드
_SPLIT_DONG = {
    "11740520": [("11740525", "상일1동"), ("11740526", "상일2동")],
}


def reconcile_dongs(dong, grid, ing):
    """SHP 행정동을 생활인구 데이터 행정동코드에 정합(코드 vintage 불일치 보정).

    recode: 같은 동인데 코드만 다른 경우 데이터 코드로 교체(지오/이름 유지).
    split : SHP 한 동이 데이터에선 둘로 분동된 경우, 마트의 격자×행정동 멤버십으로
            SHP 폴리곤을 분할 — 앞 동 = (그 동 격자 dissolve ∩ 원폴리곤), 마지막 동 =
            (원폴리곤 − 앞 동들). 겹침 없는 깔끔한 분할(250m 격자 해상도 근사 경계).
    반환: 정합된 dong (중심좌표 재계산 포함).
    """
    import pandas as pd
    from shapely.ops import unary_union

    KEY = "행정동코드"
    for old, new in _RECODE_DONG.items():
        dong.loc[dong[KEY] == old, KEY] = new

    rows_to_add, drop_codes = [], []
    conn = ing.connect(ing.load_db_config(), with_db=True)
    try:
        cur = conn.cursor()
        for old, parts in _SPLIT_DONG.items():
            sel = dong[dong[KEY] == old]
            if sel.empty:
                continue
            base = sel.geometry.iloc[0]
            gu_co, gu_nm = sel["구코드"].iloc[0], sel["구명"].iloc[0]
            drop_codes.append(old)
            remaining = base
            for i, (new_code, new_name) in enumerate(parts):
                if i == len(parts) - 1:
                    geom = remaining  # 마지막 동 = 남은 영역 (겹침 없음)
                else:
                    cur.execute(
                        "SELECT DISTINCT `격자코드` FROM `마트_월_시간` WHERE `행정동코드`=%s",
                        (new_code,),
                    )
                    codes = {str(r[0]).strip() for r in cur.fetchall()}
                    sub = grid[grid["격자코드"].isin(codes)]
                    g = unary_union(sub.geometry.values) if len(sub) else base
                    geom = g.intersection(base).buffer(0)
                    remaining = remaining.difference(geom).buffer(0)
                rows_to_add.append({
                    KEY: new_code, "행정동명": new_name,
                    "구코드": gu_co, "구명": gu_nm, "geometry": geom,
                })
        cur.close()
    finally:
        conn.close()

    if drop_codes:
        dong = dong[~dong[KEY].isin(drop_codes)]
    if rows_to_add:
        dong = pd.concat(
            [dong, gpd.GeoDataFrame(rows_to_add, crs=dong.crs)], ignore_index=True
        )
    rp = dong.geometry.representative_point()
    dong["중심경도"], dong["중심위도"] = rp.x, rp.y
    print(f"   행정동 정합: recode {list(_RECODE_DONG)} · split {list(_SPLIT_DONG)} → 동 {len(dong)}개")
    return dong


def main():
    ap = argparse.ArgumentParser(description="공간 차원 빌드")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "03.result" / "spatial"),
                    help="GeoJSON 출력 폴더")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    print("▶ shp 읽기 + WGS84 변환")
    gu = gpd.read_file(SHP_GU).to_crs(WGS84)
    dong = gpd.read_file(SHP_DONG).to_crs(WGS84)
    grid = gpd.read_file(SHP_GRID).to_crs(WGS84)
    print(f"   구 {len(gu)} · 동 {len(dong)} · 격자 {len(grid):,}")

    # ── 구명 부여: 동 대표점이 어느 시군구 폴리곤 안인지 공간조인 ──
    dong["행정동코드"] = dong["ADSTRD_CD"].astype(str).str.strip()
    dong["행정동명"] = dong["ADSTRD_NM"].astype(str).str.strip()
    dong["구코드"] = dong["행정동코드"].str[:5]
    pts = dong.copy()
    pts["geometry"] = dong.geometry.representative_point()
    j = gpd.sjoin(pts[["구코드", "geometry"]], gu[["SIGUNGU_NM", "geometry"]],
                  how="left", predicate="within")
    j = j[~j.index.duplicated(keep="first")]
    dong["구명"] = j["SIGUNGU_NM"].values
    n_nogu = int(dong["구명"].isna().sum())
    # 폴백: 같은 구코드의 다른 동에서 구명 채우기
    fill = dong.dropna(subset=["구명"]).drop_duplicates("구코드").set_index("구코드")["구명"]
    dong["구명"] = dong["구명"].fillna(dong["구코드"].map(fill))
    print(f"   동→구 공간조인: 미매칭 {n_nogu} → 폴백 후 남은 결측 {int(dong['구명'].isna().sum())}")

    # 중심좌표(라벨용)
    dong["중심경도"] = dong.geometry.representative_point().x
    dong["중심위도"] = dong.geometry.representative_point().y
    grid["격자코드"] = grid["CELL_ID"].astype(str).str.strip()
    gpt = grid.geometry.representative_point()
    grid["중심경도"] = gpt.x
    grid["중심위도"] = gpt.y

    # ── 행정동 코드 정합 (SHP↔생활인구 데이터 vintage 보정) ──
    ing = load_ingest()
    dong = reconcile_dongs(dong, grid, ing)

    # ── GeoJSON 출력 (구는 동을 구코드로 dissolve) ──
    print("▶ GeoJSON 출력")
    gu_diss = dong.dissolve(by="구코드", aggfunc="first")[["구명", "geometry"]].reset_index()
    gu_diss.to_file(out / "시군구.geojson", driver="GeoJSON")
    dong[["행정동코드", "행정동명", "구코드", "구명", "geometry"]].to_file(out / "행정동.geojson", driver="GeoJSON")
    grid[["격자코드", "geometry"]].to_file(out / "격자.geojson", driver="GeoJSON")
    for f in ("시군구.geojson", "행정동.geojson", "격자.geojson"):
        print(f"   {f}  ({(out/f).stat().st_size/1024/1024:.1f} MB)")

    # ── DB 차원 테이블 ──
    print("▶ DB 차원 테이블 적재")
    conn = ing.connect(ing.load_db_config(), with_db=True)
    cur = conn.cursor()

    cur.execute("DROP TABLE IF EXISTS `공간_시군구`")
    cur.execute("""CREATE TABLE `공간_시군구` (
        `구코드` CHAR(5) NOT NULL, `구명` VARCHAR(20) NULL,
        PRIMARY KEY (`구코드`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")
    gu_rows = sorted({(r["구코드"], r["구명"]) for _, r in dong[["구코드", "구명"]].drop_duplicates().iterrows()})
    cur.executemany("INSERT INTO `공간_시군구` VALUES (%s,%s)", gu_rows)

    cur.execute("DROP TABLE IF EXISTS `공간_행정동`")
    cur.execute("""CREATE TABLE `공간_행정동` (
        `행정동코드` CHAR(8) NOT NULL, `행정동명` VARCHAR(40) NULL,
        `구코드` CHAR(5) NULL, `구명` VARCHAR(20) NULL,
        `중심위도` DOUBLE NULL, `중심경도` DOUBLE NULL,
        PRIMARY KEY (`행정동코드`), KEY `ix_구` (`구코드`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")
    dong_rows = [(r["행정동코드"], r["행정동명"], r["구코드"], r["구명"],
                  float(r["중심위도"]), float(r["중심경도"]))
                 for _, r in dong.iterrows()]
    cur.executemany("INSERT INTO `공간_행정동` VALUES (%s,%s,%s,%s,%s,%s)", dong_rows)

    cur.execute("DROP TABLE IF EXISTS `공간_격자`")
    cur.execute("""CREATE TABLE `공간_격자` (
        `격자코드` VARCHAR(20) NOT NULL,
        `중심위도` DOUBLE NULL, `중심경도` DOUBLE NULL,
        PRIMARY KEY (`격자코드`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")
    grid_rows = [(r["격자코드"], float(r["중심위도"]), float(r["중심경도"]))
                 for _, r in grid.iterrows()]
    cur.executemany("INSERT INTO `공간_격자` VALUES (%s,%s,%s)", grid_rows)

    conn.commit()
    cur.execute("SELECT COUNT(*) FROM `공간_시군구`"); n1 = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM `공간_행정동`"); n2 = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM `공간_격자`"); n3 = cur.fetchone()[0]
    cur.execute("SELECT `구코드`,`구명` FROM `공간_시군구` ORDER BY `구코드`")
    gus = cur.fetchall()
    cur.close(); conn.close()

    print(f"✅ 공간 차원 완료: 시군구 {n1} · 행정동 {n2} · 격자 {n3:,}")
    print(f"   구 목록: " + ", ".join(f"{c}={n}" for c, n in gus[:8]) + " …")


if __name__ == "__main__":
    main()
