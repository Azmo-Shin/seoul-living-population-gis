# -*- coding: utf-8 -*-
"""
99.refresh.py  ─  데이터 갱신 한 줄 오케스트레이터
================================================================================
새 데이터(새 달 폴더 / 기존 달에 날짜 추가 / 재배포 교체)가 생겼을 때 이것 하나만 실행하면:
  ① 00.input_data.py --yes : 원천 동기화 (신규·변경 파일 자동 적재)
  ② 04.build_mart.py        : 변경 감지 → 영향받은 달의 마트만 자동 재빌드

→ 어느 달이 새로/바뀌었는지 신경 쓸 필요 없음. `--month` 같은 옵션 불필요.

사용:
  python 99.refresh.py

참고:
  · 달력(02)·공간(03)은 매번 안 돌립니다(연도 확장·경계 변경 시에만 별도 실행).
  · 어느 단계가 실패하면 즉시 중단하고 원인을 보여줍니다.
================================================================================
"""
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STEPS = [
    ("원천 동기화", ["00.input_data.py", "--yes"]),
    ("마트 갱신 (변경된 달만)", ["04.build_mart.py"]),
]


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass

    t0 = time.time()
    print("=" * 64)
    print(" 데이터 갱신 (refresh): 원천 동기화 → 마트 재빌드")
    print("=" * 64)
    for i, (label, args) in enumerate(STEPS, 1):
        print(f"\n──[{i}/{len(STEPS)}] {label} :: {' '.join(args)}", flush=True)
        r = subprocess.run([sys.executable] + args, cwd=str(HERE))
        if r.returncode != 0:
            sys.exit(f"\n❌ '{label}' 단계 실패(exit {r.returncode}) — 중단합니다. 위 로그를 확인하세요.")
    print(f"\n✅ refresh 완료 · 총 {(time.time() - t0) / 60:.1f}분")


if __name__ == "__main__":
    main()
