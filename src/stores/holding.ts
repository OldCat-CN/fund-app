// [WHY] 持仓数据状态管理，计算收益和汇总统计
// [WHAT] 管理用户录入的持仓信息，结合实时估值计算浮动盈亏
// [WHAT] 支持 A类/C类基金费用计算
// [DEPS] 依赖 fund store 获取实时估值，依赖 storage 持久化数据

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { HoldingRecord, HoldingSummary } from '@/types/fund'
import {
  getHoldings,
  upsertHolding,
  removeHolding as removeFromStorage
} from '@/utils/storage'
import { fetchFundAccurateData, type FundAccurateData } from '@/api/fundFast'
import { fetchNetValueHistoryFast } from '@/api/fundFast'
import { calculateDailyServiceFee } from '@/api/fund'

type HoldingTradeType = 'buy' | 'sell'

interface PendingTrade {
  id: string
  code: string
  name: string
  type: HoldingTradeType
  date: string
  time: string
  amount?: number
  shares?: number
  createdAt: number
}

const PENDING_TRADE_KEY = 'fund_pending_holding_trades'

function loadPendingTrades(): PendingTrade[] {
  try {
    const raw = localStorage.getItem(PENDING_TRADE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function savePendingTrades(list: PendingTrade[]) {
  localStorage.setItem(PENDING_TRADE_KEY, JSON.stringify(list))
}

/** 持仓项（包含实时估值和收益计算） */
export interface HoldingWithProfit extends HoldingRecord {
  /** 当前估值（净值） */
  currentValue?: number
  /** 当前市值 */
  marketValue?: number
  /** 持有收益金额 */
  profit?: number
  /** 持有收益率 */
  profitRate?: number
  /** 当日涨跌幅 */
  todayChange?: string
  /** 当日收益金额 */
  todayProfit?: number
  /** 是否加载中 */
  loading?: boolean
}

export const useHoldingStore = defineStore('holding', () => {
  // ========== State ==========
  
  /** 持仓列表（包含收益计算） */
  const holdings = ref<HoldingWithProfit[]>([])
  
  /** 是否正在刷新 */
  const isRefreshing = ref(false)
  
  /** 当日待确认交易（基金公司净值确认后生效） */
  const pendingTrades = ref<PendingTrade[]>(loadPendingTrades())

  // ========== Getters ==========

  /** 持仓汇总统计 */
  // [FIX] #54 修复资产统计逻辑
  const summary = computed<HoldingSummary>(() => {
    let totalValue = 0
    let totalCost = 0
    let todayProfit = 0

    holdings.value.forEach((h) => {
      // [FIX] #54 如果没有市值，使用持仓成本作为市值
      if (h.marketValue !== undefined && h.marketValue > 0) {
        totalValue += h.marketValue
      } else {
        // 没有获取到估值时，使用买入金额作为当前市值
        totalValue += h.amount
      }
      totalCost += h.amount // 持仓成本就是买入金额
      if (h.todayProfit !== undefined && !isNaN(h.todayProfit)) {
        todayProfit += h.todayProfit
      }
    })

    const totalProfit = totalValue - totalCost
    // [FIX] #54 避免除零错误
    const totalProfitRate = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0

    return {
      totalValue,
      totalCost,
      totalProfit,
      totalProfitRate,
      todayProfit
    }
  })

  /** 持仓基金代码列表 */
  const holdingCodes = computed(() => holdings.value.map((h) => h.code))

  // ========== Actions ==========

  /**
   * 初始化持仓列表
   * [WHY] APP 启动时从本地存储恢复数据
   */
  function initHoldings() {
    const records = getHoldings()
    holdings.value = records.map((r) => ({
      ...r,
      loading: true
    }))
    // 初始化后立即刷新估值
    if (records.length > 0) {
      refreshEstimates()
    }
  }

  /**
   * 刷新所有持仓的估值和收益
   * [WHAT] 使用综合数据获取函数，确保数据准确
   */
  async function refreshEstimates() {
    if (holdings.value.length === 0) {
      isRefreshing.value = false
      return
    }

    isRefreshing.value = true
    const codes = holdings.value.map((h) => h.code)

    try {
      // [WHAT] 并发获取所有基金的准确数据
      const results = await Promise.all(
        codes.map(code => fetchFundAccurateData(code).catch(() => null))
      )
      
      results.forEach((data, index) => {
        if (data) {
          applyPendingTradesIfConfirmed(codes[index], data)
          updateHoldingWithAccurateData(codes[index], data)
        } else {
          const item = holdings.value.find((h) => h.code === codes[index])
          if (item) item.loading = false
        }
      })
    } finally {
      isRefreshing.value = false
    }
  }

  /**
   * 使用准确数据更新持仓
   * [WHAT] 接收多源验证后的准确数据，计算收益
   */
  function updateHoldingWithAccurateData(code: string, data: FundAccurateData) {
    const index = holdings.value.findIndex((h) => h.code === code)
    if (index === -1) return

    const holding = holdings.value[index]
    const currentValue = data.currentValue
    
    // [EDGE] 如果净值无效，跳过计算
    if (currentValue <= 0) {
      holdings.value[index] = {
        ...holding,
        name: data.name || holding.name,
        loading: false
      }
      return
    }
    
    // [EDGE] 如果份额无效，重新计算
    let shares = holding.shares
    if (!shares || shares <= 0) {
      const buyNav = holding.buyNetValue > 0 ? holding.buyNetValue : currentValue
      shares = holding.amount / buyNav
    }
    
    // [WHAT] 计算市值
    const marketValue = shares * currentValue
    
    // [WHAT] C类累计销售服务费
    let totalServiceFee = 0
    if (holding.shareClass === 'C' && holding.serviceFeeRate) {
      const days = holding.holdingDays || 0
      if (days > 0) {
        const dailyFee = calculateDailyServiceFee(shares, currentValue, holding.serviceFeeRate)
        totalServiceFee = dailyFee * days
      }
    }
    
    // [WHAT] 计算收益
    const profit = marketValue - holding.amount - totalServiceFee
    const profitRate = holding.amount > 0 ? (profit / holding.amount) * 100 : 0
    
    // [WHAT] 计算当日收益
    // [FIX] #45 增强涨幅数据验证
    let todayProfit = 0
    const dayChangePercent = typeof data.dayChange === 'number' && !isNaN(data.dayChange) ? data.dayChange : 0
    
    if (dayChangePercent !== 0 && Math.abs(dayChangePercent) < 20) {
      // [FIX] #45 验证涨幅在合理范围内（-20% ~ +20%）
      const prevNav = currentValue / (1 + dayChangePercent / 100)
      todayProfit = shares * (currentValue - prevNav)
      
      // C类扣除当日服务费
      if (holding.shareClass === 'C' && holding.serviceFeeRate) {
        const dailyFee = calculateDailyServiceFee(shares, currentValue, holding.serviceFeeRate)
        todayProfit -= dailyFee
      }
    }

    holdings.value[index] = {
      ...holding,
      name: data.name || holding.name,
      currentValue,
      marketValue,
      profit,
      profitRate,
      // [FIX] #45 确保 todayChange 是有效数值
      todayChange: dayChangePercent.toFixed(2),
      todayProfit,
      loading: false,
      shares,
      serviceFeeDeducted: holding.shareClass === 'C' ? totalServiceFee : undefined
    }
  }

  /**
   * 添加或更新持仓
   * @param record 持仓记录
   */
  async function addOrUpdateHolding(record: HoldingRecord) {
    upsertHolding(record)
    
    // [WHAT] 更新内存中的数据
    const index = holdings.value.findIndex((h) => h.code === record.code)
    if (index > -1) {
      holdings.value[index] = {
        ...holdings.value[index],
        ...record
      }
    } else {
      holdings.value.push({
        ...record,
        loading: true
      })
    }
    
    // 刷新估值
    await refreshEstimates()
  }

  /**
   * 删除持仓
   */
  function removeHolding(code: string) {
    removeFromStorage(code)
    const index = holdings.value.findIndex((h) => h.code === code)
    if (index > -1) {
      holdings.value.splice(index, 1)
    }
    pendingTrades.value = pendingTrades.value.filter(t => t.code !== code)
    savePendingTrades(pendingTrades.value)
  }

  /**
   * 检查是否有该基金的持仓
   */
  function hasHolding(code: string): boolean {
    return holdingCodes.value.includes(code)
  }

  /**
   * 获取单个持仓
   */
  function getHoldingByCode(code: string): HoldingWithProfit | undefined {
    return holdings.value.find((h) => h.code === code)
  }

  function normalizeDate(date: string): string {
    if (!date) return ''
    return date.slice(0, 10)
  }

  function todayStr(): string {
    return new Date().toISOString().split('T')[0] || ''
  }

  function toTimeValue(date: string, time: string): number {
    const hhmm = /^\d{2}:\d{2}$/.test(time) ? time : '00:00'
    return new Date(`${date}T${hhmm}:00`).getTime()
  }

  function sortPendingTrades(list: PendingTrade[]): PendingTrade[] {
    return [...list].sort((a, b) => {
      return toTimeValue(a.date, a.time) - toTimeValue(b.date, b.time) || a.createdAt - b.createdAt
    })
  }

  function createPendingTrade(params: Omit<PendingTrade, 'id' | 'createdAt'>) {
    const trade: PendingTrade = {
      ...params,
      id: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now()
    }
    pendingTrades.value.push(trade)
    pendingTrades.value = sortPendingTrades(pendingTrades.value)
    savePendingTrades(pendingTrades.value)
  }

  async function getNavByDate(code: string, date: string): Promise<number | null> {
    const targetDate = normalizeDate(date)
    if (!targetDate) return null
    const targetTs = new Date(`${targetDate}T23:59:59`).getTime()
    const todayTs = new Date(`${todayStr()}T23:59:59`).getTime()
    const diffDays = Math.max(30, Math.ceil((todayTs - targetTs) / (1000 * 60 * 60 * 24)) + 15)
    const historyDays = Math.min(3000, diffDays)
    const history = await fetchNetValueHistoryFast(code, historyDays)
    if (!history.length) return null

    const matched = history.find(item => {
      const ts = new Date(`${item.date}T00:00:00`).getTime()
      return ts <= targetTs && item.netValue > 0
    })

    return matched?.netValue || null
  }

  function updateHoldingRecord(record: HoldingRecord) {
    const index = holdings.value.findIndex(h => h.code === record.code)
    if (index > -1) {
      holdings.value[index] = { ...holdings.value[index], ...record }
    } else {
      holdings.value.push({ ...record, loading: true })
    }
    upsertHolding(record)
  }

  function applyBuyToHolding(code: string, amount: number, nav: number, date: string) {
    const holding = getHoldingByCode(code)
    if (!holding || nav <= 0 || amount <= 0) return

    const addedShares = amount / nav
    const newShares = holding.shares + addedShares
    const newAmount = holding.amount + amount
    const existingBuyDate = normalizeDate(holding.buyDate)
    const tradeDate = normalizeDate(date)
    const newBuyDate = existingBuyDate && existingBuyDate < tradeDate ? existingBuyDate : tradeDate
    const holdingDays = Math.max(0, Math.ceil((new Date().getTime() - new Date(newBuyDate).getTime()) / (1000 * 60 * 60 * 24)))

    const updated: HoldingRecord = {
      ...holding,
      amount: newAmount,
      shares: newShares,
      buyNetValue: newShares > 0 ? newAmount / newShares : holding.buyNetValue,
      buyDate: newBuyDate,
      holdingDays
    }
    updateHoldingRecord(updated)
  }

  function applySellToHolding(code: string, shares: number) {
    const holding = getHoldingByCode(code)
    if (!holding || shares <= 0) return
    if (shares > holding.shares + 1e-6) {
      throw new Error('卖出份额超过当前持仓')
    }

    const ratio = holding.shares > 0 ? shares / holding.shares : 0
    const costReduced = holding.amount * ratio
    const newShares = Math.max(0, holding.shares - shares)
    const newAmount = Math.max(0, holding.amount - costReduced)

    if (newShares <= 1e-6) {
      removeHolding(code)
      return
    }

    const updated: HoldingRecord = {
      ...holding,
      shares: newShares,
      amount: newAmount,
      buyNetValue: newAmount / newShares
    }
    updateHoldingRecord(updated)
  }

  function applyPendingTradesIfConfirmed(code: string, data: FundAccurateData) {
    const today = todayStr()
    if (data.navDate !== today || data.nav <= 0) return

    const targetTrades = sortPendingTrades(
      pendingTrades.value.filter(t => t.code === code && normalizeDate(t.date) === today)
    )
    if (!targetTrades.length) return

    for (const trade of targetTrades) {
      try {
        if (trade.type === 'buy') {
          applyBuyToHolding(code, trade.amount || 0, data.nav, trade.date)
        } else {
          applySellToHolding(code, trade.shares || 0)
        }
      } catch {
        // [EDGE] 异常待确认单直接跳过，避免阻塞其他持仓刷新
      }
    }

    pendingTrades.value = pendingTrades.value.filter(t => !targetTrades.some(p => p.id === t.id))
    savePendingTrades(pendingTrades.value)
  }

  async function addBuyTrade(params: {
    code: string
    amount: number
    date: string
    time: string
  }): Promise<{ pending: boolean }> {
    const code = params.code
    const amount = params.amount
    const date = normalizeDate(params.date)
    const time = params.time

    if (!code) throw new Error('基金代码不能为空')
    if (!amount || amount <= 0) throw new Error('买入金额必须大于0')
    const holding = getHoldingByCode(code)
    if (!holding) throw new Error('未找到对应持仓')

    const today = todayStr()
    if (date === today) {
      const accurateData = await fetchFundAccurateData(code).catch(() => null)
      if (accurateData && accurateData.navDate === today && accurateData.nav > 0) {
        applyBuyToHolding(code, amount, accurateData.nav, date)
        await refreshEstimates()
        return { pending: false }
      }

      createPendingTrade({
        code,
        name: holding.name,
        type: 'buy',
        date,
        time,
        amount
      })
      return { pending: true }
    }

    const nav = await getNavByDate(code, date)
    if (!nav) throw new Error('未找到该日期可用净值')
    applyBuyToHolding(code, amount, nav, date)
    await refreshEstimates()
    return { pending: false }
  }

  async function addSellTrade(params: {
    code: string
    shares: number
    date: string
    time: string
  }): Promise<{ pending: boolean }> {
    const code = params.code
    const shares = params.shares
    const date = normalizeDate(params.date)
    const time = params.time

    if (!code) throw new Error('基金代码不能为空')
    if (!shares || shares <= 0) throw new Error('卖出份额必须大于0')
    const holding = getHoldingByCode(code)
    if (!holding) throw new Error('未找到对应持仓')
    if (shares > holding.shares + 1e-6) throw new Error('卖出份额超过当前持仓')

    const today = todayStr()
    if (date === today) {
      const accurateData = await fetchFundAccurateData(code).catch(() => null)
      if (accurateData && accurateData.navDate === today && accurateData.nav > 0) {
        applySellToHolding(code, shares)
        await refreshEstimates()
        return { pending: false }
      }

      const pendingSellShares = pendingTrades.value
        .filter(t => t.code === code && t.type === 'sell' && normalizeDate(t.date) === today)
        .reduce((sum, t) => sum + (t.shares || 0), 0)
      if (shares + pendingSellShares > holding.shares + 1e-6) {
        throw new Error('卖出份额超过当前持仓（含待确认卖出）')
      }

      createPendingTrade({
        code,
        name: holding.name,
        type: 'sell',
        date,
        time,
        shares
      })
      return { pending: true }
    }

    const nav = await getNavByDate(code, date)
    if (!nav) throw new Error('未找到该日期可用净值')
    applySellToHolding(code, shares)
    await refreshEstimates()
    return { pending: false }
  }

  /**
   * 更新持仓天数
   * [WHY] 每次刷新时更新持仓天数
   */
  function updateHoldingDays() {
    const today = new Date()
    holdings.value.forEach((h) => {
      if (h.buyDate) {
        const buyDate = new Date(h.buyDate)
        const diffTime = today.getTime() - buyDate.getTime()
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
        h.holdingDays = diffDays
      }
    })
  }

  return {
    // State
    holdings,
    isRefreshing,
    pendingTrades,
    // Getters
    summary,
    holdingCodes,
    // Actions
    initHoldings,
    refreshEstimates,
    addOrUpdateHolding,
    addBuyTrade,
    addSellTrade,
    removeHolding,
    hasHolding,
    getHoldingByCode,
    updateHoldingDays
  }
})
