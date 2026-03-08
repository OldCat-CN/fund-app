#!/usr/bin/env node
/**
 * [WHY] 更新本地基金列表，避免 public/fund-list.json 过期
 * [WHAT] 从东方财富 fundcode_search.js 拉取全量基金并落盘
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const outputPath = path.join(repoRoot, 'public', 'fund-list.json')
const sourceUrl = `https://fund.eastmoney.com/js/fundcode_search.js?rt=${Date.now()}`

function isOffMarketFund(item) {
  const code = (item.code || '').trim()
  const name = (item.name || '').trim()
  if (/^5\d{5}$/.test(code)) return false
  if (/^15\d{4}$/.test(code)) return false
  if (/^16\d{4}$/.test(code)) return false
  const hasEtf = /ETF/i.test(name)
  const isOffMarketEtf = /联接|ETF-FOF/i.test(name)
  if (hasEtf && !isOffMarketEtf) return false
  return true
}

function parseFundList(raw) {
  const normalized = raw.replace(/^\uFEFF/, '')
  const match = normalized.match(/var\s+r\s*=\s*(\[[\s\S]*\]);?$/)
  if (!match?.[1]) {
    throw new Error('无法解析 fundcode_search.js: 未找到变量 r')
  }
  const arr = JSON.parse(match[1])
  const list = arr.map((item) => ({
    code: item[0] || '',
    pinyin: item[1] || '',
    name: item[2] || '',
    type: item[3] || '',
    fullPinyin: item[4] || ''
  }))
  return list.filter(isOffMarketFund)
}

async function main() {
  const response = await fetch(sourceUrl)
  if (!response.ok) {
    throw new Error(`下载失败: ${response.status} ${response.statusText}`)
  }
  const text = await response.text()
  const list = parseFundList(text)
  if (!Array.isArray(list) || list.length < 10000) {
    throw new Error(`基金列表异常，数量过少: ${list.length}`)
  }

  await fs.writeFile(outputPath, `${JSON.stringify(list)}\n`, 'utf8')
  const sample = list.find((item) => item.code === '017193')
  console.log(`[fund-list] 已更新: ${list.length} 条 -> ${outputPath}`)
  if (sample) {
    console.log(`[fund-list] 017193: ${sample.name}`)
  }
}

main().catch((err) => {
  console.error('[fund-list] 更新失败:', err)
  process.exit(1)
})
