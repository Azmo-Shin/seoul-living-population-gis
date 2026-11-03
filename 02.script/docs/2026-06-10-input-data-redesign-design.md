# 설계: 서울 250M 생활인구 적재 스크립트 재작성 (운영용)

- 날짜: 2026-06-10
- 대상: `2026_06_GIS/02.script/00.input_data.py` (DB 접속정보: `2026_06_GIS/.env`)
- 목적: 일회성 적재 → **운영 반복 적재**(터미널 직접 실행)로 전환. 진행바, 월 파티셔닝, 변경 감지 질답형 동기화.

## 1. 데이터 / 대상
- 원본: `2026_06_GIS/01.data/01.raw_data/서울_250M_생활인구/250_LOCAL_RESD_YYYYMM/…YYYYMMDD.csv`
  - CP949, 일별, 33컬럼(일자·시간0~23·행정동코드·250M격자·생활인구합계 + 남/여 14연령대), `*`=마스킹.
  - 882파일(2024-01~2026-05), 일부 폴더 이중 중첩 → **재귀 탐색**.
- 대상: `shin_project.생활인구_250m` (서버 99 = <DB_SERVER_IP>, MySQL 8.0). 한글 컬럼 유지.

## 2. 스키마 — 월 파티셔닝 + 압축
```sql
CREATE TABLE `생활인구_250m` (
  `일자` DATE NOT NULL, `시간` TINYINT UNSIGNED NOT NULL,
  `행정동코드` VARCHAR(10) NOT NULL, `250M격자` VARCHAR(20) NOT NULL,
  `생활인구합계` DECIMAL(12,2) NULL, … 28 연령성별 DECIMAL(12,2) NULL …,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`,`일자`)
) ENGINE=InnoDB ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8 DEFAULT CHARSET=utf8mb4
  PARTITION BY RANGE COLUMNS(`일자`) ( PARTITION pYYYYMM VALUES LESS THAN ('익월-01'), … );
```
- PK `(id,일자)`: id 선두(순차·자동증가), 일자 포함(파티션 키 필수).
- 압축 kb8 (원본 CSV의 35.7%, 전체 ~18~19GB).
- 파티션 자동 관리: 생성 시 데이터 범위+24개월 버퍼까지 월 파티션 생성, 적재 전 `ensure_partitions()`로 미존재 월 자동 ADD.

## 3. 변경 감지 + 질답형 동기화 (핵심)
`_적재로그(파일명 PK, 일자, 행수, 파일크기, 수정시각, 적재시각)` — 파일 "지문" 저장.

기본 실행 시 디스크 전체 스캔 → 로그와 대조 분류:
- **신규**: 로그에 없음 → 적재
- **갱신**: 크기 또는 mtime 다름 → 그 **달 전체 재적재**(파티션 TRUNCATE 후 그 달 모든 파일 재적재)
- **변경 없음**: skip

분류 결과를 요약 출력 후 **질답**:
```
[1] 신규만  [2] 신규+갱신(권장)  [3] 월별 직접 선택  [0] 취소
```
- 갱신(파티션 교체)은 파괴적 → 추가 확인.
- 변경 감지: 파일 **크기+수정시각**(빠름). (해시는 `--verify-hash` 옵션만)

## 4. CLI
| 옵션 | 동작 |
|---|---|
| (없음) | 질답형 동기화 (기본, 사람이 운영) |
| `--yes` | 묻지 않고 신규+갱신 진행 (무인/배치) |
| `--month YYYY-MM` | 그 달만 |
| `--from / --to YYYY-MM` | 기간 |
| `--year YYYY` | 그 해 |
| `--reload-month YYYY-MM` | 그 달 강제 교체 |
| `--reset` | 전체 DROP 후 재적재 (스키마 전환 첫 실행 시 필요) |
| `--dry-run` | 점검 결과만 표시 |
| `--workers N` | 병렬 적재 (멀티프로세스, 워커별 커넥션) |
| `--build-indexes` | 최초 전체 적재 후 1회: (일자),(250M격자),(행정동코드) 인덱스 |
| `--test-conn` | 연결 확인 |

비대화(stdin 비-TTY)인데 선택 플래그가 없으면 → 계획만 출력하고 안전 종료(`--yes`/타깃 안내).

## 5. 진행바 / 상태표시
- tqdm(설치됨) 파일 단위 진행바 + postfix: 현재 월·누적 행수·처리량(행/s)·ETA·마스킹수.
- tqdm 없으면 자체 텍스트 진행바로 폴백.
- 병렬에서도 완료되는 대로 바 갱신.

## 6. 적재 엔진 (기존 검증 로직 유지)
- 파일 단위 트랜잭션(원자성) + executemany 배치 + 재개로그 + 멀티프로세스 병렬.
- 로그 기록은 `INSERT … ON DUPLICATE KEY UPDATE`(재적재 시 지문 갱신).
- 세션 튜닝(unique_checks=0 등). 압축 적재라 직렬 ~21초/파일, 병렬 6워커 ~4배.

## 7. 인덱스 / 조회 성능
- 초기 대량 적재는 인덱스 없이(빠름) → `--build-indexes`로 사후 생성. 이후 월 증분은 인덱스 유지.
- 파티션 프루닝 + 인덱스로 날짜·격자 조건 조회 개선. 전체 무조건 조회는 지양.
- (향후 옵션) 대시보드용 요약·집계 테이블은 조회 패턴 확정 후 별도 추가.

## 8. 구조
단일 파일 `00.input_data.py`. 섹션: 설정 / DB·파티션 / 파싱 / 분류·동기화 / 적재(직렬·병렬) / 진행바 / 질답 / CLI.

## 검증 계획
py_compile → `--help` → `--test-conn` → `--reset --yes --month 2024-01 --workers 6`(소량) → 파티션·로그·무결성 확인.
