#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地离线 PaddleOCR 服务（持仓截图识别）
[WHY] 替换浏览器端 Tesseract 识别，提升中文基金名称识别精度
[WHAT] 提供 HTTP 接口，输出结构化持仓与基金名称纠错结果
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, jsonify, request
from flask_cors import CORS
from paddleocr import PaddleOCR
from rapidfuzz import fuzz, process


ROOT_DIR = Path(__file__).resolve().parent.parent
FUND_LIST_PATH = ROOT_DIR / "public" / "fund-list.json"

app = Flask(__name__)
CORS(app)

_ocr: Optional[PaddleOCR] = None
_fund_name_index: List[Tuple[str, str]] = []

FUND_KEYWORDS = [
    "混合", "ETF", "联接", "指数", "债券", "股票", "增强", "LOF", "QDII", "主题", "精选",
    "成长", "价值", "量化", "稳健", "纯债", "短债", "定开", "创新", "科技", "消费", "医药",
    "新能源", "半导体", "智选", "优选", "龙头", "增利", "发起", "基金",
]

NOISE_LINE_PATTERNS = [
    r"我的持有", r"近期交易", r"自选榜", r"热搜榜", r"排序", r"全部\(\d+\)",
    r"去加仓", r"立即上车", r"加入", r"基金持仓", r"支持", r"四包四回",
]


@dataclass
class OcrToken:
    text: str
    score: float
    x_left: float
    x_right: float
    y_center: float


def get_ocr() -> PaddleOCR:
    global _ocr
    if _ocr is None:
        _ocr = PaddleOCR(
            lang="ch",
            use_angle_cls=False,
            show_log=False,
            use_gpu=False,
            enable_mkldnn=False,
            cpu_threads=4,
            det_limit_side_len=4000,
            det_limit_type="max",
        )
    return _ocr


def load_fund_name_index() -> List[Tuple[str, str]]:
    global _fund_name_index
    if _fund_name_index:
        return _fund_name_index
    if not FUND_LIST_PATH.exists():
        return []
    data = json.loads(FUND_LIST_PATH.read_text(encoding="utf-8"))
    _fund_name_index = [(str(item.get("name", "")), str(item.get("code", ""))) for item in data if item.get("name")]
    return _fund_name_index


def parse_profit_label(raw_text: str) -> str:
    norm = re.sub(r"\s+", "", raw_text)
    if "昨日收益" in norm:
        return "yesterday"
    if "今日收益" in norm:
        return "today"
    return "unknown"


def parse_amount(token: str) -> Optional[float]:
    cleaned = token.replace(",", "").replace("¥", "").replace("￥", "").strip()
    if cleaned.count(".") > 1:
        idx = cleaned.rfind(".")
        cleaned = cleaned[:idx].replace(".", "") + cleaned[idx:]
    try:
        val = float(cleaned)
        return val if val > 0 else None
    except Exception:
        return None


def clean_fund_name(name: str) -> str:
    n = re.sub(r"\s+", "", name)
    n = re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", n)
    n = re.sub(r"(持有|金额|收益|份额|净值|估值|预计|更新)$", "", n)
    n = re.sub(r"(色|办|本|攻|X)$", "", n)
    return n.strip()


def contains_keyword(text: str) -> bool:
    return any(k in text for k in FUND_KEYWORDS)


def looks_like_fund_name(name: str) -> bool:
    if not name or len(name) < 4:
        return False
    if contains_keyword(name):
        return True
    return len(name) >= 8


def tokenize_ocr_result(result: Any) -> Tuple[List[OcrToken], str]:
    tokens: List[OcrToken] = []
    texts: List[str] = []
    if not result:
        return tokens, ""

    lines = result[0] if isinstance(result, list) and result else []
    for item in lines:
        if not item or len(item) < 2:
            continue
        box = item[0]
        txt_info = item[1]
        if not box or not txt_info or len(txt_info) < 2:
            continue
        text = str(txt_info[0] or "").strip()
        score = float(txt_info[1] or 0)
        if not text:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        tokens.append(
            OcrToken(
                text=text,
                score=score,
                x_left=min(xs),
                x_right=max(xs),
                y_center=(min(ys) + max(ys)) / 2.0,
            )
        )
        texts.append(text)

    tokens.sort(key=lambda t: (t.y_center, t.x_left))
    return tokens, "\n".join(texts)


def group_rows(tokens: List[OcrToken], y_threshold: float = 14.0) -> List[List[OcrToken]]:
    rows: List[List[OcrToken]] = []
    for t in tokens:
        if not rows:
            rows.append([t])
            continue
        last_row = rows[-1]
        last_y = sum(x.y_center for x in last_row) / len(last_row)
        if abs(t.y_center - last_y) <= y_threshold:
            last_row.append(t)
        else:
            rows.append([t])
    for row in rows:
        row.sort(key=lambda x: x.x_left)
    return rows


def row_to_text(row: List[OcrToken]) -> str:
    return " ".join(t.text for t in row).strip()


def extract_amount_in_row(row: List[OcrToken]) -> Tuple[Optional[float], Optional[int]]:
    best_amount = None
    best_idx = None
    for i, t in enumerate(row):
        cands = re.findall(r"\d[\d,\.]*\.\d{2}", t.text)
        if not cands:
            continue
        for c in cands:
            amt = parse_amount(c)
            if amt is None or amt < 100:
                continue
            if best_amount is None or amt > best_amount:
                best_amount = amt
                best_idx = i
    return best_amount, best_idx


def should_skip_row(text: str) -> bool:
    pure = clean_fund_name(text)
    if not pure:
        return True
    return any(re.search(p, pure) for p in NOISE_LINE_PATTERNS)


def extract_signed_values(text: str) -> List[float]:
    vals: List[float] = []
    for token in re.findall(r"[+\-]\d[\d,\.]*\.\d{2}%?", text):
        v = parse_amount(token.replace("%", ""))
        if v is None:
            continue
        if token.startswith("-"):
            v = -abs(v)
        else:
            v = abs(v)
        vals.append(v)
    return vals


def name_continuation_candidate(row: List[OcrToken], current_name: str) -> str:
    text = clean_fund_name(row_to_text(row))
    if not text:
        return ""
    if re.search(r"(预计|更新|自选|榜|热搜|加仓|关注|建议)", text):
        return ""
    if re.search(r"\d[\d,\.]*\.\d{2}", text):
        return ""
    if len(text) > 24:
        return ""
    if re.match(r"^(ETF|联接|混合|指数|债券|股票|QDII|LOF|发起|A|C|E)", text, re.I):
        return text
    if contains_keyword(text):
        return text
    if re.search(r"(联|接|起|式|主题)$", current_name):
        return text
    return ""


def correct_fund_name(name: str) -> Tuple[str, str, float]:
    index = load_fund_name_index()
    if not index:
        return name, "", 0.0
    clean = clean_fund_name(name)
    if not clean:
        return name, "", 0.0

    # 先做严格包含匹配，避免“睿/守”等单字误差无法命中
    contains_hits = [(n, c) for n, c in index if clean in n or n in clean]
    if contains_hits:
        best = max(contains_hits, key=lambda x: len(x[0]))
        return best[0], best[1], 95.0

    names = [n for n, _ in index]
    best = process.extractOne(clean, names, scorer=fuzz.WRatio, score_cutoff=72)
    if not best:
        return name, "", 0.0
    matched_name = best[0]
    score = float(best[1])
    matched_code = ""
    for n, c in index:
        if n == matched_name:
            matched_code = c
            break
    return matched_name, matched_code, score


def parse_holdings_with_layout(result: Any) -> Tuple[List[Dict[str, Any]], str, str]:
    tokens, raw_text = tokenize_ocr_result(result)
    rows = group_rows(tokens)
    holdings: List[Dict[str, Any]] = []

    i = 0
    while i < len(rows):
        row = rows[i]
        row_text = row_to_text(row)
        if should_skip_row(row_text):
            i += 1
            continue

        amount, amount_idx = extract_amount_in_row(row)
        if amount is None or amount_idx is None:
            i += 1
            continue

        left_name_text = clean_fund_name("".join(t.text for t in row[:amount_idx + 1]))
        left_name_text = re.sub(r"\d[\d,\.]*\.\d{2}", "", left_name_text)
        name = clean_fund_name(left_name_text)

        # 跨行名称拼接：当前行后若为纯名称续行则拼接
        if i + 1 < len(rows):
            next_row = rows[i + 1]
            next_text = name_continuation_candidate(next_row, name)
            if next_text:
                name = clean_fund_name(name + next_text)

        if not looks_like_fund_name(name):
            i += 1
            continue

        signed_curr = extract_signed_values(row_text)
        signed_next = extract_signed_values(row_to_text(rows[i + 1])) if i + 1 < len(rows) else []
        holding_profit = signed_curr[-1] if signed_curr else None
        holding_profit_rate = None
        if signed_next:
            cand = [v for v in signed_next if abs(v) <= 100]
            if cand:
                holding_profit_rate = cand[-1]
        if holding_profit_rate is None and signed_curr:
            cand = [v for v in signed_curr if abs(v) <= 100]
            if cand:
                holding_profit_rate = cand[-1]

        corrected_name, corrected_code, score = correct_fund_name(name)
        final_name = corrected_name if score >= 72 else name
        final_code = corrected_code if score >= 72 else ""

        exists = any(
            abs((h.get("amount", 0.0) or 0.0) - amount) <= 0.01
            and (
                h.get("name") == final_name
                or str(h.get("name", "")).startswith(final_name[:4])
                or final_name.startswith(str(h.get("name", "")[:4]))
            )
            for h in holdings
        )
        if not exists:
            row_scores = [t.score for t in row] or [0.6]
            item: Dict[str, Any] = {
                "code": final_code,
                "name": final_name,
                "amount": round(amount, 2),
                "confidence": round(sum(row_scores) / len(row_scores), 2),
                "needsCodeMatch": not bool(final_code),
            }
            if holding_profit is not None:
                item["holdingProfit"] = round(float(holding_profit), 2)
            if holding_profit_rate is not None:
                item["holdingProfitRate"] = round(float(holding_profit_rate), 2)
            holdings.append(item)
        i += 1

    # 再过滤一次明显噪音
    filtered = []
    for h in holdings:
        n = str(h.get("name", ""))
        if not n or len(n) < 3:
            continue
        if h.get("amount", 0) < 10:
            continue
        filtered.append(h)

    return filtered, parse_profit_label(raw_text), raw_text


@app.route("/api/ocr/health", methods=["GET"])
def health():
    return jsonify({"success": True, "message": "paddle ocr server ready"})


@app.route("/api/ocr/holding-snapshot", methods=["POST"])
def ocr_holding_snapshot():
    file = request.files.get("image")
    if file is None:
        return jsonify({"success": False, "error": "missing image"}), 400

    ocr = get_ocr()
    # PaddleOCR 支持文件对象，落地临时文件更稳
    tmp_path = ROOT_DIR / "tmp_ocr_upload.jpg"
    file.save(tmp_path)
    try:
        try:
            result = ocr.ocr(
                str(tmp_path),
                cls=False,
                slice={
                    "horizontal_stride": 300,
                    "vertical_stride": 800,
                    "merge_x_thres": 50,
                    "merge_y_thres": 35,
                },
            )
        except RuntimeError:
            # [EDGE] 少量环境会在切片推理时报 oneDNN primitive 错误，回退普通识别保障可用性
            result = ocr.ocr(str(tmp_path), cls=False)
        holdings, profit_label, raw_text = parse_holdings_with_layout(result)
        return jsonify(
            {
                "success": True,
                "data": {
                    "holdings": holdings,
                    "profitLabel": profit_label,
                    "rawText": raw_text,
                    "engine": "paddleocr",
                },
            }
        )
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    print("Starting Paddle OCR service at http://127.0.0.1:5005")
    app.run(host="127.0.0.1", port=5005, debug=False)
