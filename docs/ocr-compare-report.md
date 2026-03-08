# OCR 对比报告（test2.jpg）

- 测试时间: 2026-03-08
- 测试图片: `public/test2.jpg`
- Tesseract 路径: `recognizeText + parseHoldingText`
- Paddle 路径: 本地服务 `scripts/paddle_ocr_server.py`（离线）+ `parseHoldingText`

## 结果摘要

```json
{
  "image": "/data2/user24262896/home/future/fund-app/public/test2.jpg",
  "tesseract": {
    "count": 28,
    "profitLabel": "unknown",
    "has_yongying_ruixin": false,
    "has_yongying_shouxin": true,
    "top_names": [
      "富国中证农业主题ETF联接C",
      "银华体育文化灵活配置混合C",
      "华夏中证金融科技",
      "天弘中证工业有色金属主题ETF发起",
      "华夏有色金属ETF联接CX",
      "鹏华国证石油天然气ETF联接C色",
      "华夏国证半导体芯",
      "德邦稳盈增长灵活配置混合C色"
    ]
  },
  "paddle": {
    "count": 27,
    "profitLabel": "yesterday",
    "has_yongying_ruixin": true,
    "has_yongying_shouxin": false,
    "top_names": [
      "富国中证农业主题",
      "银华体育文化灵活",
      "华夏中证金融科技",
      "天弘中证工业有色",
      "华夏有色金属ETF联",
      "鹏华国证石油天然",
      "华夏国证半导体芯",
      "德邦稳盈增长灵活"
    ]
  },
  "delta_count": -1
}
```

## 结论

1. Paddle 方案在该长图上识别条数与 Tesseract 接近（见上方 `count`）。
2. Paddle 方案识别到了 `永赢睿信`，而 Tesseract 识别为 `永赢守信`。
3. 当前仍有部分基金名称尾部截断，已通过“基金名称纠错（fund-list）”在导入流程中做二次修正。
