// [WHY] OCR 识别服务 - 用于从截图中识别基金持仓信息
// [WHAT] 使用 Tesseract.js 进行本地文字识别，无需外部 API
// [DEPS] 依赖 tesseract.js 库

import Tesseract from 'tesseract.js'
import type { Worker, LoggerMessage } from 'tesseract.js'

/**
 * 识别结果中的持仓项
 */
export interface RecognizedHolding {
  /** 基金代码（6位数字），可能为空（需要通过名称搜索） */
  code: string
  /** 基金名称 */
  name: string
  /** 持仓金额（元） */
  amount: number
  /** 持有份额（可选） */
  shares?: number
  /** 识别置信度（0-1） */
  confidence: number
  /** 是否需要手动匹配代码（名称识别但无代码） */
  needsCodeMatch?: boolean
  /** 持仓收益金额（右侧累计收益），可能识别失败 */
  holdingProfit?: number
  /** 持仓收益率（%），可能识别失败 */
  holdingProfitRate?: number
}

/**
 * 收益标题类型（截图顶部）
 */
export type ProfitLabelType = 'today' | 'yesterday' | 'unknown'

/**
 * OCR 持仓快照结果（含收益标题）
 */
export interface RecognizedHoldingSnapshot {
  holdings: RecognizedHolding[]
  profitLabel: ProfitLabelType
  rawText: string
}

const FUND_KEYWORDS = [
  '混合', 'ETF', '联接', '指数', '债券', '股票', '增强', 'LOF', 'QDII', '主题', '精选', '成长', '价值', '量化',
  '稳健', '纯债', '短债', '定开', '创新', '科技', '消费', '医药', '新能源', '半导体', '智选', '优选', '龙头',
  '增利', '发起'
]
const FUND_COMPANY_PREFIXES = [
  '易方达', '华夏', '天弘', '富国', '广发', '博时', '南方', '汇添富', '鹏华', '嘉实', '招商', '工银', '中欧',
  '银华', '景顺', '国泰', '前海开源', '永赢', '德邦', '华安', '中航', '信澳', '摩根'
]

// [WHY] OCR 常见错字修正（基于真实基金库回归样本）
const KNOWN_NAME_CORRECTIONS: Array<[RegExp, string]> = [
  [/永赢守信混合C$/g, '永赢睿信混合C']
]

/**
 * OCR 识别进度回调
 */
export type OcrProgressCallback = (progress: number, status: string) => void

let sharedWorkerPromise: Promise<Worker> | null = null
let activeProgressCallback: OcrProgressCallback | undefined

const OCR_DEBUG_PREFIX = '[OCR 调试]'
const OCR_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0_best'
const OCR_CACHE_PATH = 'ocr-cache/projectnaptha-4.0.0-best-v1'
const OCR_WORKER_PATH = typeof window !== 'undefined' ? '/tesseract/worker.min.js' : undefined
const OCR_CORE_PATH = typeof window !== 'undefined' ? '/tesseract-core' : undefined

function debugOcrStage(stage: string, payload?: unknown) {
  const label = `${OCR_DEBUG_PREFIX}[${stage}]`
  if (payload === undefined) {
    console.log(label)
    return
  }
  console.groupCollapsed(label)
  console.log(payload)
  console.groupEnd()
}

function describeImageSource(imageSource: File | string) {
  if (typeof File !== 'undefined' && imageSource instanceof File) {
    return {
      type: 'file',
      name: imageSource.name,
      size: imageSource.size,
      mimeType: imageSource.type,
      lastModified: imageSource.lastModified
    }
  }
  return {
    type: 'string',
    preview: String(imageSource).slice(0, 120)
  }
}

function mapOcrStatus(status: string): string {
  const statusMap: Record<string, string> = {
    'loading tesseract core': '加载识别引擎...',
    'initializing tesseract': '初始化引擎...',
    'loading language traineddata': '加载语言包...',
    'initializing api': '准备识别...',
    'recognizing text': '识别文字中...'
  }
  return statusMap[status] || status
}

function emitProgress(message: LoggerMessage) {
  if (!activeProgressCallback || !message.status) return
  activeProgressCallback(message.progress || 0, mapOcrStatus(message.status))
}

async function getSharedWorker(): Promise<Worker> {
  if (!sharedWorkerPromise) {
    debugOcrStage('Stage 0 OCR资源配置', {
      langs: 'chi_sim+eng',
      workerPath: OCR_WORKER_PATH || '(default)',
      corePath: OCR_CORE_PATH || '(default)',
      langPath: OCR_LANG_PATH,
      cachePath: OCR_CACHE_PATH,
      gzip: true
    })
    const workerOptions = {
      logger: emitProgress,
      langPath: OCR_LANG_PATH,
      cachePath: OCR_CACHE_PATH,
      gzip: true,
      ...(OCR_WORKER_PATH ? { workerPath: OCR_WORKER_PATH } : {}),
      ...(OCR_CORE_PATH ? { corePath: OCR_CORE_PATH } : {})
    }
    sharedWorkerPromise = Tesseract.createWorker('chi_sim+eng', undefined, workerOptions).catch((error) => {
      sharedWorkerPromise = null
      throw error
    })
  }
  return sharedWorkerPromise
}

/**
 * 预加载 OCR 引擎，减少首次识别耗时
 */
export async function preloadOcrEngine(onProgress?: OcrProgressCallback): Promise<void> {
  activeProgressCallback = onProgress
  try {
    await getSharedWorker()
    if (onProgress) onProgress(1, '识别引擎已就绪')
  } finally {
    activeProgressCallback = undefined
  }
}

/**
 * 从图片中识别文字
 * [WHY] 使用 Tesseract.js 进行本地 OCR，支持中英文混合识别
 * [WHAT] 返回识别出的原始文字
 * @param imageSource 图片来源（File 对象、URL 或 Base64）
 * @param onProgress 进度回调
 */
export async function recognizeText(imageSource: File | string, onProgress?: OcrProgressCallback): Promise<string> {
  const worker = await getSharedWorker()
  activeProgressCallback = onProgress
  debugOcrStage('Stage 1 OCR输入图片', describeImageSource(imageSource))

  try {
    const result = await worker.recognize(imageSource)
    const pageData = result.data as typeof result.data & {
      words?: unknown[]
      lines?: unknown[]
    }
    debugOcrStage('Stage 1.5 OCR原始识别结果', {
      confidence: result.data.confidence,
      textLength: result.data.text.length,
      rawText: result.data.text,
      wordCount: pageData.words?.length || 0,
      lineCount: pageData.lines?.length || 0,
      words: pageData.words,
      lines: pageData.lines
    })
    return result.data.text
  } finally {
    activeProgressCallback = undefined
  }
}

/**
 * 从识别文字中解析持仓信息
 * [WHY] 不同平台的截图格式不同，需要灵活解析
 * [WHAT] 尝试多种模式匹配，提取基金代码、名称、金额等信息
 */
export function parseHoldingText(text: string): RecognizedHolding[] {
  const holdings: RecognizedHolding[] = []
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  debugOcrStage('Stage 2 原始文本分行', {
    lineCount: lines.length,
    lines
  })

  const processedLines = preprocessLines(lines)
  debugOcrStage('Stage 3 预处理后文本行', {
    lineCount: processedLines.length,
    processedLines
  })

  const singleLineMatches: Array<{ line: string; holding: RecognizedHolding }> = []
  for (const line of processedLines) {
    const holding = parseSingleLine(line)
    if (holding) {
      holdings.push(holding)
      singleLineMatches.push({ line, holding })
    }
  }
  debugOcrStage('Stage 4 单行解析命中', {
    count: singleLineMatches.length,
    matches: singleLineMatches
  })

  let multiLineHoldings: RecognizedHolding[] = []
  if (holdings.length === 0) {
    multiLineHoldings = parseMultiLine(lines)
    holdings.push(...multiLineHoldings)
  }
  debugOcrStage('Stage 5 多行补充解析', {
    count: multiLineHoldings.length,
    holdings: multiLineHoldings
  })

  const alipayHoldings = parseAlipayFormat(lines)
  debugOcrStage('Stage 6 支付宝格式解析', {
    count: alipayHoldings.length,
    holdings: alipayHoldings
  })

  const mergeActions: Array<Record<string, unknown>> = []
  for (const ah of alipayHoldings) {
    const existingIndex = holdings.findIndex(h => {
      const sameCode = !!h.code && !!ah.code && h.code === ah.code
      const sameAmount = Math.abs((h.amount || 0) - (ah.amount || 0)) <= 0.01
      const hasEnoughNameInfo = !!h.name && !!ah.name && h.name.length >= 4 && ah.name.length >= 4
      const sameName = hasEnoughNameInfo && (
        h.name === ah.name ||
        h.name.includes(ah.name.slice(0, 4)) ||
        ah.name.includes(h.name.slice(0, 4))
      )
      return sameCode || (sameAmount && sameName)
    })
    if (existingIndex === -1) {
      holdings.push(ah)
      mergeActions.push({ action: 'append', holding: ah })
      continue
    }

    const existing = holdings[existingIndex]
    const shouldUpgradeName =
      ah.name.length > existing.name.length &&
      (
        existing.name.length < 6 ||
        ah.name.includes(existing.name) ||
        existing.name.includes(ah.name.slice(0, 4))
      )
    if (shouldUpgradeName) {
      holdings[existingIndex] = {
        ...existing,
        name: ah.name,
        confidence: Math.max(existing.confidence, ah.confidence),
        holdingProfit: ah.holdingProfit ?? existing.holdingProfit,
        holdingProfitRate: ah.holdingProfitRate ?? existing.holdingProfitRate
      }
      mergeActions.push({ action: 'upgrade-name', from: existing, to: holdings[existingIndex] })
    } else {
      mergeActions.push({ action: 'skip-duplicate', existing, incoming: ah })
    }
  }
  debugOcrStage('Stage 7 解析结果合并', {
    count: holdings.length,
    mergeActions,
    holdings
  })

  const filteredOut: Array<{ reason: string; holding: RecognizedHolding }> = []
  const filteredHoldings = holdings.filter(h => {
    if (h.amount < 10) {
      filteredOut.push({ reason: 'amount < 10', holding: h })
      return false
    }
    if (!h.code && (!h.name || h.name.length < 3)) {
      filteredOut.push({ reason: 'name too short', holding: h })
      return false
    }
    if (!h.code && /^(ETF|基金|持仓)$/i.test(h.name.trim())) {
      filteredOut.push({ reason: 'generic noise name', holding: h })
      return false
    }
    if (!h.code && h.name.length <= 4 && !containsFundKeyword(h.name) && !hasFundCompanyPrefix(h.name)) {
      filteredOut.push({ reason: 'short non-fund-like name', holding: h })
      return false
    }
    return true
  })
  debugOcrStage('Stage 8 噪音过滤结果', {
    keptCount: filteredHoldings.length,
    removedCount: filteredOut.length,
    removed: filteredOut,
    holdings: filteredHoldings
  })
  return filteredHoldings
}

/**
 * 解析截图中的收益标题（今日收益/昨日收益）
 */
export function parseProfitLabel(text: string): ProfitLabelType {
  const normalized = text.replace(/\s+/g, '')
  if (normalized.includes('昨日收益')) return 'yesterday'
  if (normalized.includes('今日收益')) return 'today'
  return 'unknown'
}

/**
 * 预处理文本行
 * [WHY] 有些 OCR 结果会把基金名称和代码分到不同行
 */
function preprocessLines(lines: string[]): string[] {
  const result: string[] = []
  let buffer = ''
  
  for (const line of lines) {
    // [WHAT] 如果当前行只有基金代码，与前一行合并
    if (/^\d{6}$/.test(line) && buffer) {
      result.push(`${buffer} ${line}`)
      buffer = ''
    } else if (/^[A-Za-z\u4e00-\u9fa5]+[A-Za-z0-9\u4e00-\u9fa5]*$/.test(line) && !containsNumber(line)) {
      // [WHAT] 纯文字行可能是基金名称，暂存
      buffer = line
    } else {
      if (buffer) {
        result.push(`${buffer} ${line}`)
        buffer = ''
      } else {
        result.push(line)
      }
    }
  }
  
  if (buffer) {
    result.push(buffer)
  }
  
  return result
}

/**
 * 检查字符串是否包含数字
 */
function containsNumber(str: string): boolean {
  return /\d/.test(str)
}

/**
 * 解析单行文本
 * [WHY] 单行可能包含完整的持仓信息
 */
function parseSingleLine(line: string): RecognizedHolding | null {
  // [WHAT] 模式1：基金代码（6位数字）+ 基金名称 + 金额
  // 例如：000001 华夏成长 10,000.00
  const pattern1 = /(\d{6})\s*([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5]*)\s+([\d,]+\.?\d*)/
  const match1 = line.match(pattern1)
  if (match1) {
    return {
      code: match1[1],
      name: cleanFundName(match1[2]),
      amount: parseAmount(match1[3]),
      confidence: 0.9
    }
  }
  
  // [WHAT] 模式2：基金名称 + 基金代码 + 金额
  // 例如：华夏成长 000001 10,000.00
  const pattern2 = /([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5]*)\s*(\d{6})\s+([\d,]+\.?\d*)/
  const match2 = line.match(pattern2)
  if (match2) {
    return {
      code: match2[2],
      name: cleanFundName(match2[1]),
      amount: parseAmount(match2[3]),
      confidence: 0.9
    }
  }
  
  // [WHAT] 模式3：只有基金代码和金额
  // 例如：000001 10,000.00
  const pattern3 = /(\d{6})\s+([\d,]+\.?\d*)/
  const match3 = line.match(pattern3)
  if (match3) {
    return {
      code: match3[1],
      name: '', // 名称后续通过 API 获取
      amount: parseAmount(match3[2]),
      confidence: 0.7
    }
  }
  
  // [WHAT] 模式4：支付宝/天天基金格式 - 名称在前，金额较大
  // 例如：华夏成长混合A 持有金额 ¥10,000.00
  const pattern4 = /([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5]{2,})\s*.*?[¥￥]?\s*([\d,]+\.?\d{2})/
  const match4 = line.match(pattern4)
  if (match4 && parseAmount(match4[2]) >= 100) { // 金额至少100元
    const parsedName = cleanFundName(match4[1])
    // [WHY] 避免把“易方达/半导体”等短片段误判为完整基金名称
    if (!looksLikeFundName(parsedName)) return null
    // [WHAT] 尝试从名称中提取基金代码
    const codeMatch = line.match(/\d{6}/)
    return {
      code: codeMatch ? codeMatch[0] : '',
      name: parsedName,
      amount: parseAmount(match4[2]),
      confidence: codeMatch ? 0.6 : 0.5,
      needsCodeMatch: !codeMatch // [NEW] 标记需要手动匹配代码
    }
  }
  
  return null
}

/**
 * 解析支付宝持仓截图格式（只有名称没有代码）
 * [WHY] 支付宝持仓页面不显示基金代码，只显示名称和金额
 * [WHAT] 专门解析 "基金名称" + "金额" 的格式
 */
function parseAlipayFormat(lines: string[]): RecognizedHolding[] {
  const holdings: RecognizedHolding[] = []
  
  // [WHAT] 需要排除的非基金名称关键词
  const excludeKeywords = ['持有', '收益', '金额', '份额', '净值', '估值', '日收益', '持有收益', '累计收益', '我的', '全部', '偏股', '偏债', '黄金', '排序', '名称', '添加', '管理']
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // [WHAT] 从当前行提取“主金额”（通常是持仓金额，>=100）
    const amountTokens = line.match(/\d[\d,\.]*\.\d{2}/g) || []
    const amountCandidates = amountTokens
      .map(token => parseAmount(token))
      .filter(amount => amount >= 100)
    const amount = amountCandidates.length ? Math.max(...amountCandidates) : 0
    if (amount <= 0) continue

    // [WHAT] 名称可能分两行：当前行+下一行
    const nextLine = (lines[i + 1] || '').trim()
    let nameCandidate = cleanFundName(
      line
        .replace(/\d[\d,\.]*\.\d{2}/g, '')
        .replace(/[+\-]\d[\d,\.]*\.\d{2}%?/g, '')
        .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    )

    const hasKeyword = containsFundKeyword(nameCandidate)
    const shouldAppendNextLine =
      !hasKeyword ||
      nameCandidate.length < 6 ||
      /(联|接|起|式|主题)$/.test(nameCandidate)
    if (shouldAppendNextLine && nextLine) {
      const nextNamePartRaw = cleanFundName(
        nextLine
          .replace(/\d[\d,\.]*\.\d{2}/g, '')
          .replace(/[+\-]\d[\d,\.]*\.\d{2}%?/g, '')
          .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
      )
      const nextNamePart = stripNameNoiseSuffix(nextNamePartRaw)
      if (shouldJoinNameContinuation(nameCandidate, nextNamePart)) {
        nameCandidate = `${nameCandidate}${nextNamePart}`
      }
    }

    const isFundName = containsFundKeyword(nameCandidate)
    const isExcluded = excludeKeywords.some(kw => nameCandidate.includes(kw)) && !isFundName
    if (!nameCandidate || nameCandidate.length < 3 || isExcluded) continue
    if (!looksLikeFundName(nameCandidate)) continue

    // [WHY] 不再按金额去重，避免不同基金恰好同金额时被误吞
    const exists = holdings.some(h => h.name === nameCandidate)
    if (!exists) {
      const currentSignedNumbers = extractSignedNumbers(line)
      const nextSignedNumbers = extractSignedNumbers(nextLine)
      const holdingProfit =
        currentSignedNumbers.length > 0
          ? currentSignedNumbers[currentSignedNumbers.length - 1]
          : undefined
      const holdingProfitRate = pickHoldingProfitRate(nextSignedNumbers, currentSignedNumbers)
      holdings.push({
        code: '',
        name: nameCandidate,
        amount,
        confidence: 0.65,
        needsCodeMatch: true,
        holdingProfit,
        holdingProfitRate
      })
    }
  }
  
  return holdings
}

/**
 * 多行组合解析
 * [WHY] 有些截图格式中，基金信息分散在多行
 */
function parseMultiLine(lines: string[]): RecognizedHolding[] {
  const holdings: RecognizedHolding[] = []
  
  // [WHAT] 查找所有基金代码
  const codePattern = /\d{6}/g
  const amountPattern = /[\d,]+\.\d{2}/g
  
  const codes: string[] = []
  const amounts: number[] = []
  
  for (const line of lines) {
    // [WHAT] 提取基金代码
    const codeMatches = line.match(codePattern)
    if (codeMatches) {
      codes.push(...codeMatches.filter(c => isValidFundCode(c)))
    }
    
    // [WHAT] 提取金额（大于100的数字）
    const amountMatches = line.match(amountPattern)
    if (amountMatches) {
      for (const m of amountMatches) {
        const amount = parseAmount(m)
        if (amount >= 100) {
          amounts.push(amount)
        }
      }
    }
  }
  
  // [WHAT] 如果代码和金额数量匹配，尝试配对
  if (codes.length > 0 && codes.length === amounts.length) {
    for (let i = 0; i < codes.length; i++) {
      holdings.push({
        code: codes[i],
        name: '',
        amount: amounts[i],
        confidence: 0.5
      })
    }
  } else if (codes.length > 0) {
    // [WHAT] 只有代码没有金额，也返回（用户可以手动填写金额）
    for (const code of codes) {
      holdings.push({
        code,
        name: '',
        amount: 0,
        confidence: 0.3
      })
    }
  }
  
  return holdings
}

/**
 * 验证基金代码是否合法
 * [WHY] 过滤掉明显不是基金代码的6位数字（如日期、时间等）
 */
function isValidFundCode(code: string): boolean {
  // [EDGE] 排除常见的非基金代码模式
  // 日期格式：202401、202312等
  if (/^20[0-9]{4}$/.test(code)) return false
  // 时间格式：开头为1-2的6位数可能是时间
  if (/^[0-2]\d{5}$/.test(code) && parseInt(code.slice(0, 2)) <= 24) {
    // 进一步检查是否像时间 HHMMSS
    const hh = parseInt(code.slice(0, 2))
    const mm = parseInt(code.slice(2, 4))
    const ss = parseInt(code.slice(4, 6))
    if (hh <= 23 && mm <= 59 && ss <= 59) return false
  }
  return true
}

/**
 * 清理基金名称
 * [WHY] 去除名称中的噪音字符
 */
function cleanFundName(name: string): string {
  const cleaned = name
    .replace(/持有|金额|收益|份额|净值|估值/g, '')
    .replace(/[¥￥%]/g, '')
    // [WHY] OCR 常见尾部噪声字符（如“本/色/办/攻/汪/X”）
    .replace(/[为儿本色办攻汪Xx]$/g, '')
    .trim()

  return applyKnownNameCorrections(cleaned)
}

function applyKnownNameCorrections(name: string): string {
  let normalized = name
  for (const [pattern, replacement] of KNOWN_NAME_CORRECTIONS) {
    normalized = normalized.replace(pattern, replacement)
  }
  return normalized
}

function containsFundKeyword(name: string): boolean {
  return FUND_KEYWORDS.some(kw => name.includes(kw))
}

function hasFundCompanyPrefix(name: string): boolean {
  return FUND_COMPANY_PREFIXES.some(prefix => name.startsWith(prefix))
}

function looksLikeFundName(name: string): boolean {
  if (!name || name.length < 4) return false
  const chineseCount = (name.match(/[\u4e00-\u9fa5]/g) || []).length
  // [WHY] 过滤“KmBEERAC本”这类英文噪声，至少要有一定中文信息
  if (chineseCount < 2) return false
  if (containsFundKeyword(name)) return true
  // [EDGE] 某些名称关键词缺失时，要求中文字符更充分
  return chineseCount >= 4 && name.length >= 8
}

function stripNameNoiseSuffix(text: string): string {
  if (!text) return ''
  const noiseTokens = ['预计', '更新', '今日', '昨日', '自选', '热搜', '榜', 'No', 'NO']
  let cropped = text
  for (const token of noiseTokens) {
    const idx = cropped.indexOf(token)
    if (idx > 0) {
      cropped = cropped.slice(0, idx)
      break
    }
  }
  return cropped.trim()
}

function shouldJoinNameContinuation(current: string, nextPart: string): boolean {
  if (!current || !nextPart) return false
  if (nextPart.length > 18) return false
  if (/(今日|昨日|自选|热搜|榜|建议|关注|加仓)/.test(nextPart)) return false
  // [WHY] 常见跨行：第一行到“主题/联/接”，第二行补“ETF联接C”
  if (/^(ETF|联接|混合|指数|债券|股票|QDII|LOF|发起|A|C|E)/i.test(nextPart)) return true
  if (containsFundKeyword(nextPart)) return true
  return /(联|接|起|式|主题)$/.test(current)
}

/**
 * 解析金额字符串
 * [WHY] 处理各种金额格式（带逗号、带货币符号等）
 */
function parseAmount(amountStr: string): number {
  let cleaned = amountStr.replace(/[¥￥\s]/g, '').replace(/,/g, '')
  // [WHY] OCR 常见误识别："1.479.28" 实际应为 "1479.28"
  const dotCount = (cleaned.match(/\./g) || []).length
  if (dotCount > 1) {
    const lastDotIndex = cleaned.lastIndexOf('.')
    const intPart = cleaned.slice(0, lastDotIndex).replace(/\./g, '')
    const fracPart = cleaned.slice(lastDotIndex + 1)
    cleaned = `${intPart}.${fracPart}`
  }
  const amount = parseFloat(cleaned)
  return isNaN(amount) ? 0 : amount
}

/**
 * 提取带符号的小数（支持 OCR 异常格式）
 */
function extractSignedNumbers(line: string): number[] {
  const tokens = line.match(/[+\-]\d[\d,\.]*\.\d{2}%?/g) || []
  return tokens
    .map(token => parseAmount(token.replace('%', '')))
    .filter(num => !isNaN(num) && isFinite(num))
}

/**
 * 选择持仓收益率（优先使用下一行最后一个带符号数）
 */
function pickHoldingProfitRate(nextLineNums: number[], currentLineNums: number[]): number | undefined {
  const fromNext = [...nextLineNums]
    .reverse()
    .find(num => Math.abs(num) <= 100)
  if (fromNext !== undefined) return fromNext
  const fromCurrent = [...currentLineNums]
    .reverse()
    .find(num => Math.abs(num) <= 100)
  return fromCurrent
}

/**
 * 从图片识别并解析持仓快照（持仓 + 收益标题）
 */
export async function recognizeHoldingSnapshot(
  imageSource: File | string,
  onProgress?: OcrProgressCallback
): Promise<RecognizedHoldingSnapshot> {
  const text = await recognizeText(imageSource, onProgress)
  const holdings = parseHoldingText(text)
  const profitLabel = parseProfitLabel(text)
  const snapshot = {
    holdings,
    profitLabel,
    rawText: text
  }
  debugOcrStage('Stage 9 OCR快照汇总', snapshot)
  return snapshot
}

/**
 * 从图片识别并解析持仓信息
 * [WHY] 一站式接口，图片 -> 持仓列表
 */
export async function recognizeHoldings(
  imageSource: File | string,
  onProgress?: OcrProgressCallback
): Promise<RecognizedHolding[]> {
  const snapshot = await recognizeHoldingSnapshot(imageSource, onProgress)
  return snapshot.holdings
}
