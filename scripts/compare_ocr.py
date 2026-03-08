#!/usr/bin/env python3
"""OCR 对比脚本：Tesseract vs 本地 PaddleOCR 服务。

默认图片: public/test2.jpg
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import requests


def run_tesseract(repo_root: Path, image_path: Path) -> dict:
    node_code = r"""
import('./src/utils/ocr.ts').then(async ({ recognizeText, parseHoldingText, parseProfitLabel }) => {
  const image = process.argv[1]
  const text = await recognizeText(image)
  const holdings = parseHoldingText(text)
  const profitLabel = parseProfitLabel(text)
  console.log('===OCR_JSON_START===')
  console.log(JSON.stringify({ holdings, profitLabel, rawText: text }, null, 2))
  console.log('===OCR_JSON_END===')
  process.exit(0)
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
"""
    proc = subprocess.run(
        ["node", "-e", node_code, str(image_path)],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    output = proc.stdout
    start = output.find("===OCR_JSON_START===")
    end = output.find("===OCR_JSON_END===")
    if start == -1 or end == -1:
        raise RuntimeError("Unexpected tesseract output")
    payload = output[start + len("===OCR_JSON_START==="):end].strip()
    return json.loads(payload)


def run_paddle(image_path: Path) -> dict:
    with image_path.open("rb") as f:
        resp = requests.post(
            "http://127.0.0.1:5005/api/ocr/holding-snapshot",
            files={"image": (image_path.name, f, "image/jpeg")},
            timeout=90,
        )
    resp.raise_for_status()
    payload = resp.json()
    if not payload.get("success"):
        raise RuntimeError(payload.get("error") or "paddle ocr failed")
    return payload["data"]


def parse_text_with_ts(repo_root: Path, text: str) -> dict:
    node_code = r"""
import('./src/utils/ocr.ts').then(({ parseHoldingText, parseProfitLabel }) => {
  const raw = process.argv[1] || ''
  const holdings = parseHoldingText(raw)
  const profitLabel = parseProfitLabel(raw)
  console.log('===OCR_JSON_START===')
  console.log(JSON.stringify({ holdings, profitLabel, rawText: raw }, null, 2))
  console.log('===OCR_JSON_END===')
  process.exit(0)
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
"""
    proc = subprocess.run(
        ["node", "-e", node_code, text],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    output = proc.stdout
    start = output.find("===OCR_JSON_START===")
    end = output.find("===OCR_JSON_END===")
    if start == -1 or end == -1:
        raise RuntimeError("Unexpected parse output")
    payload = output[start + len("===OCR_JSON_START==="):end].strip()
    return json.loads(payload)


def summary(data: dict) -> dict:
    holdings = data.get("holdings", [])
    names = [h.get("name", "") for h in holdings]
    return {
        "count": len(holdings),
        "profitLabel": data.get("profitLabel", "unknown"),
        "has_yongying_ruixin": any("永赢睿信" in n for n in names),
        "has_yongying_shouxin": any("永赢守信" in n for n in names),
        "top_names": names[:8],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare OCR engines on one image")
    parser.add_argument("image", nargs="?", default="public/test2.jpg")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    image_path = Path(args.image)
    if not image_path.is_absolute():
        image_path = (repo_root / image_path).resolve()
    if not image_path.exists():
        print(f"Image not found: {image_path}", file=sys.stderr)
        return 2

    try:
        tess = run_tesseract(repo_root, image_path)
    except Exception as exc:
        print(f"Tesseract failed: {exc}", file=sys.stderr)
        return 1

    try:
        paddle_raw = run_paddle(image_path)
    except Exception as exc:
        print(f"PaddleOCR failed: {exc}", file=sys.stderr)
        print("Hint: start service with `python3 scripts/paddle_ocr_server.py`", file=sys.stderr)
        return 1
    paddle = parse_text_with_ts(repo_root, paddle_raw.get("rawText", ""))

    t_sum = summary(tess)
    p_sum = summary(paddle)

    report = {
        "image": str(image_path),
        "tesseract": t_sum,
        "paddle": p_sum,
        "delta_count": p_sum["count"] - t_sum["count"],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
