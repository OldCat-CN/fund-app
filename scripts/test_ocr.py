#!/usr/bin/env python3
"""Quick OCR regression runner for fund screenshot import.

Default image: public/test2.jpg
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def run_ocr(repo_root: Path, image_path: Path) -> dict:
    node_code = r"""
import('./src/utils/ocr.ts').then(async ({ recognizeHoldingSnapshot }) => {
  const image = process.argv[1]
  const result = await recognizeHoldingSnapshot(image)
  console.log('===OCR_JSON_START===')
  console.log(JSON.stringify(result, null, 2))
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
        raise RuntimeError(f"Unexpected OCR output:\n{output}")

    payload = output[start + len("===OCR_JSON_START==="):end].strip()
    return json.loads(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run OCR snapshot recognition test")
    parser.add_argument(
        "image",
        nargs="?",
        default="public/test2.jpg",
        help="Image path relative to repo root or absolute path",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    image_path = Path(args.image)
    if not image_path.is_absolute():
        image_path = repo_root / image_path
    image_path = image_path.resolve()

    if not image_path.exists():
        print(f"Image not found: {image_path}", file=sys.stderr)
        return 2

    try:
        result = run_ocr(repo_root, image_path)
    except Exception as exc:
        print(f"OCR test failed: {exc}", file=sys.stderr)
        return 1

    holdings = result.get("holdings", [])
    print(f"Image: {image_path}")
    print(f"Profit Label: {result.get('profitLabel', 'unknown')}")
    print(f"Recognized Holdings: {len(holdings)}")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
