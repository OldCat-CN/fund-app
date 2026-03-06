<script setup lang="ts">
// [WHY] 持仓管理页 - 管理用户的基金持仓和收益
// [WHAT] 显示持仓列表、汇总统计，支持添加/编辑/删除持仓
// [WHAT] 支持 A类/C类基金费用计算

import { ref, onMounted, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useHoldingStore } from '@/stores/holding'
import { searchFund, detectShareClass } from '@/api/fund'
import { fetchFundAccurateData } from '@/api/fundFast'
import { hasMarketOpenedToday, isTradingDay } from '@/api/tiantianApi'
import { showConfirmDialog, showToast } from 'vant'
import { formatMoney, formatPercent, getChangeStatus } from '@/utils/format'
import type { FundInfo, HoldingRecord, FundShareClass } from '@/types/fund'

const router = useRouter()
const route = useRoute()
const holdingStore = useHoldingStore()
const SHOW_DETAIL_KEY = 'holding_show_detail'

// ========== 表单相关 ==========
const showAddDialog = ref(false)
const isEditing = ref(false)

const formData = ref({
  code: '',
  name: '',
  amount: '', // 持仓金额
  profit: '' // 持有收益
})

// ========== A/C类费用相关 ==========
const shareClass = ref<FundShareClass>('A')
// 基金搜索相关
const searchKeyword = ref('')
const searchResults = ref<FundInfo[]>([])
const isSearching = ref(false)
const selectedFund = ref<FundInfo | null>(null)
const currentNetValue = ref(0) // 当前基金净值

// ========== 调整成本相关 ==========
const showCostDialog = ref(false)
const costFormData = ref({
  code: '',
  name: '',
  amount: '', // 新的成本金额
  shares: ''  // 份额（可选修改）
})

// ========== 买入/卖出 ==========
const showTradeDialog = ref(false)
const tradeType = ref<'buy' | 'sell'>('buy')
const tradeFormData = ref({
  code: '',
  name: '',
  amount: '',
  shares: '',
  date: '',
  period: 'before_15' as 'before_15' | 'after_15'
})
const tradeSearchKeyword = ref('')
const tradeSearchResults = ref<FundInfo[]>([])
const tradeIsSearching = ref(false)
let tradeSearchTimer: ReturnType<typeof setTimeout> | null = null
const todayDate = new Date().toISOString().split('T')[0] || ''

// ========== 交易记录弹窗 ==========
const showTradeHistoryDialog = ref(false)
const historyFundCode = ref('')
const historyFundName = ref('')
const showDetail = ref(true)
type TradeHistoryTab = 'all' | 'buy' | 'sell' | 'auto_invest' | 'switch' | 'dividend' | 'modify'
const activeTradeHistoryTab = ref<TradeHistoryTab>('all')
type HoldingSortMode = 'none' | 'rate_desc' | 'rate_asc' | 'amount_desc' | 'amount_asc'
type HoldingSortKey = 'today' | 'profit'
const activeHoldingSortKey = ref<HoldingSortKey | ''>('')
const holdingSortMode = ref<HoldingSortMode>('none')

// [WHAT] 页面挂载时初始化数据
onMounted(() => {
  try {
    const raw = localStorage.getItem(SHOW_DETAIL_KEY)
    showDetail.value = raw !== '0'
  } catch {
    showDetail.value = true
  }
  holdingStore.initHoldings()
  // [WHAT] 支持从详情页携带参数直接打开交易入口
  handleRouteActions()
})

// [WHAT] 汇总统计样式
const summaryProfitClass = computed(() => {
  return getChangeStatus(holdingStore.summary.totalProfit)
})

const summaryTodayClass = computed(() => {
  return getChangeStatus(holdingStore.summary.todayProfit)
})

const pendingTradeCount = computed(() => holdingStore.pendingTrades.length)
const showPendingTradesDialog = ref(false)
const activePendingTradeCode = ref('')
const activePendingTradeName = ref('')
const pendingCountByCode = computed(() => {
  const map = new Map<string, number>()
  holdingStore.pendingTrades.forEach((trade) => {
    map.set(trade.code, (map.get(trade.code) || 0) + 1)
  })
  return map
})
const pendingOnlyItems = computed(() => {
  const holdingCodes = new Set(holdingStore.holdings.map(h => h.code))
  const grouped = new Map<string, {
    code: string
    name: string
    count: number
    latestCreatedAt: number
    pendingBuyAmount: number
  }>()
  holdingStore.pendingTrades.forEach((trade) => {
    if (holdingCodes.has(trade.code)) return
    const existing = grouped.get(trade.code)
    const buyAmount = trade.type === 'buy' ? (trade.amount || 0) : 0
    if (existing) {
      existing.count += 1
      if (trade.createdAt > existing.latestCreatedAt) existing.latestCreatedAt = trade.createdAt
      existing.pendingBuyAmount += buyAmount
    } else {
      grouped.set(trade.code, {
        code: trade.code,
        name: trade.name || trade.code,
        count: 1,
        latestCreatedAt: trade.createdAt,
        pendingBuyAmount: buyAmount
      })
    }
  })
  return Array.from(grouped.values()).sort((a, b) => b.latestCreatedAt - a.latestCreatedAt)
})
const hasHoldingListItems = computed(() => holdingStore.holdings.length > 0 || pendingOnlyItems.value.length > 0)
const sortedHoldings = computed(() => {
  const list = [...holdingStore.holdings]
  if (!activeHoldingSortKey.value || holdingSortMode.value === 'none') return list

  const key = activeHoldingSortKey.value
  const mode = holdingSortMode.value
  const rateKey = key === 'today' ? 'todayChange' : 'profitRate'
  const amountKey = key === 'today' ? 'todayProfit' : 'profit'
  const factor = mode.endsWith('_asc') ? 1 : -1
  const useRate = mode.startsWith('rate')

  return list.sort((a, b) => {
    const aVal = useRate
      ? parseFloat((a[rateKey] as string | number | undefined) as string) || 0
      : (a[amountKey] as number | undefined) || 0
    const bVal = useRate
      ? parseFloat((b[rateKey] as string | number | undefined) as string) || 0
      : (b[amountKey] as number | undefined) || 0
    return (aVal - bVal) * factor
  })
})
const pendingOnlyDayChangeMap = ref<Record<string, number>>({})
const pendingTradeItems = computed(() => {
  const list = activePendingTradeCode.value
    ? holdingStore.pendingTrades.filter(t => t.code === activePendingTradeCode.value)
    : holdingStore.pendingTrades
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
})
const pendingDialogTitle = computed(() => {
  return activePendingTradeCode.value
    ? `${activePendingTradeName.value || activePendingTradeCode.value} 待确认交易`
    : '待确认交易'
})
const tradeHistorySummary = computed(() => {
  if (!historyFundCode.value) {
    return { items: [], realizedProfit: 0, floatingProfit: 0, totalProfit: 0 }
  }
  return holdingStore.getTradePnLSummaryByFund(historyFundCode.value)
})

// [WHAT] 下拉刷新
async function onRefresh() {
  await holdingStore.refreshEstimates()
  holdingStore.updateHoldingDays()
  showToast('刷新成功')
}

// [WHAT] 打开添加持仓弹窗
function openAddDialog() {
  isEditing.value = false
  resetForm()
  showAddDialog.value = true
}

function buildHoldingSnapshot(holding?: { amount?: number; shares?: number }) {
  return {
    amount: holding?.amount || 0,
    shares: holding?.shares || 0
  }
}

// [WHAT] 打开编辑持仓弹窗
function handleEdit(code: string) {
  const holding = holdingStore.getHoldingByCode(code)
  if (!holding) return
  
  isEditing.value = true
  formData.value = {
    code: holding.code,
    name: holding.name,
    amount: holding.amount.toString(),
    profit: (holding.profit || 0).toFixed(2)
  }
  shareClass.value = holding.shareClass
  currentNetValue.value = holding.buyNetValue
  selectedFund.value = { code: holding.code, name: holding.name, type: '', pinyin: '' }
  showAddDialog.value = true
}

// [WHAT] 删除持仓
async function handleDelete(code: string) {
  try {
    await showConfirmDialog({
      title: '确认删除',
      message: '确定要删除该持仓记录吗？'
    })
    holdingStore.removeHolding(code)
    showToast('已删除')
  } catch {
    // 用户取消
  }
}

// [WHAT] 重置表单
function resetForm() {
  formData.value = { code: '', name: '', amount: '', profit: '' }
  searchKeyword.value = ''
  searchResults.value = []
  selectedFund.value = null
  currentNetValue.value = 0
  shareClass.value = 'A'
}

// [WHAT] 搜索基金
let searchTimer: ReturnType<typeof setTimeout> | null = null

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  
  if (!searchKeyword.value.trim()) {
    searchResults.value = []
    return
  }
  
  searchTimer = setTimeout(async () => {
    isSearching.value = true
    try {
      searchResults.value = await searchFund(searchKeyword.value, 10)
    } finally {
      isSearching.value = false
    }
  }, 300)
}

// [WHAT] 选择基金
async function selectFund(fund: FundInfo) {
  selectedFund.value = fund
  formData.value.code = fund.code
  formData.value.name = fund.name
  searchKeyword.value = ''
  searchResults.value = []
  
  // [WHAT] 检测份额类型（A类/C类）
  shareClass.value = detectShareClass(fund.code, fund.name)
  currentNetValue.value = 0
  void refreshSettledNav(fund.code)
}

// [WHAT] 计算持有份额
const calculatedShares = computed(() => {
  const amount = parseFloat(formData.value.amount) || 0
  if (amount <= 0 || currentNetValue.value <= 0) return 0
  return amount / currentNetValue.value
})

async function refreshSettledNav(code: string): Promise<number> {
  if (!code) return 0
  try {
    const accurate = await fetchFundAccurateData(code)
    const settledNav = accurate.nav > 0 ? accurate.nav : 0
    if (settledNav > 0 && formData.value.code === code) {
      currentNetValue.value = settledNav
    }
    return settledNav
  } catch {
    return 0
  }
}

// [WHAT] 提交表单
async function submitForm() {
  if (!formData.value.code) {
    showToast('请选择基金')
    return
  }
  if (!formData.value.amount || parseFloat(formData.value.amount) <= 0) {
    showToast('请输入有效的持仓金额')
    return
  }
  const holdingProfit = parseFloat(formData.value.profit) || 0
  const holdingAmount = parseFloat(formData.value.amount)
  const holdingCost = holdingAmount - holdingProfit
  if (holdingCost <= 0) {
    showToast('持有金额需大于持有收益')
    return
  }
  let nav = currentNetValue.value
  if (nav <= 0) {
    nav = await refreshSettledNav(formData.value.code)
  }
  const holdingShares = nav > 0 ? (holdingAmount / nav) : 0
  if (holdingShares <= 0) {
    showToast('暂未获取到已结算净值，请稍后重试')
    return
  }

  const keepBuyDate = isEditing.value
    ? (holdingStore.getHoldingByCode(formData.value.code)?.buyDate || todayDate)
    : todayDate
  const keepHoldingDays = isEditing.value
    ? (holdingStore.getHoldingByCode(formData.value.code)?.holdingDays || 0)
    : 0
  
  const record: HoldingRecord = {
    code: formData.value.code,
    name: formData.value.name,
    shareClass: shareClass.value,
    amount: holdingCost,
    buyNetValue: nav,
    shares: holdingShares,
    buyDate: keepBuyDate,
    holdingDays: keepHoldingDays,
    createdAt: Date.now(),
    lastFeeDate: undefined
  }

  const previousHolding = holdingStore.getHoldingByCode(formData.value.code)
  const beforeSnapshot = buildHoldingSnapshot(previousHolding)
  const afterSnapshot = buildHoldingSnapshot({ amount: record.amount, shares: record.shares })

  await holdingStore.addOrUpdateHolding(record, {
    ensureInitialTradeRecord: false
  })
  holdingStore.addModifyTradeRecord({
    code: record.code,
    name: record.name,
    before: beforeSnapshot,
    after: afterSnapshot,
    date: todayDate
  })
  showToast(isEditing.value ? '修改成功' : '添加成功')
  showAddDialog.value = false
  resetForm()
}

// ========== 调整成本功能 ==========

// [WHAT] 打开调整成本弹窗
function openCostDialog(code: string) {
  const holding = holdingStore.getHoldingByCode(code)
  if (!holding) return
  
  costFormData.value = {
    code: holding.code,
    name: holding.name,
    amount: holding.amount.toString(),
    shares: holding.shares.toFixed(2)
  }
  showCostDialog.value = true
}

// [WHAT] 提交调整成本
async function submitCostAdjust() {
  const amount = parseFloat(costFormData.value.amount)
  const shares = parseFloat(costFormData.value.shares)
  
  if (!amount || amount <= 0) {
    showToast('请输入有效的成本金额')
    return
  }
  if (!shares || shares <= 0) {
    showToast('请输入有效的份额')
    return
  }
  
  const holding = holdingStore.getHoldingByCode(costFormData.value.code)
  if (!holding) return
  const beforeSnapshot = buildHoldingSnapshot(holding)
  
  // [WHAT] 构建更新后的持仓记录，保留原有的其他字段
  const record: HoldingRecord = {
    code: holding.code,
    name: holding.name,
    shareClass: holding.shareClass,
    amount: amount,
    // [WHY] 根据新的成本和份额计算买入净值
    buyNetValue: amount / shares,
    shares: shares,
    buyDate: holding.buyDate,
    holdingDays: holding.holdingDays,
    createdAt: holding.createdAt,
    // 保留费用相关字段
    buyFeeRate: holding.buyFeeRate,
    buyFeeDeducted: holding.buyFeeDeducted,
    buyFeeAmount: holding.buyFeeAmount,
    serviceFeeRate: holding.serviceFeeRate,
    serviceFeeDeducted: holding.serviceFeeDeducted,
    lastFeeDate: holding.lastFeeDate
  }
  
  await holdingStore.addOrUpdateHolding(record)
  holdingStore.addModifyTradeRecord({
    code: record.code,
    name: record.name,
    before: beforeSnapshot,
    after: buildHoldingSnapshot({ amount: record.amount, shares: record.shares }),
    date: todayDate
  })
  showToast('成本调整成功')
  showCostDialog.value = false
}

// [WHAT] 跳转到首页
function goHome() {
  router.push('/')
}

// [WHAT] 跳转到基金详情
function goToDetail(code: string) {
  router.push(`/detail/${code}`)
}

// [WHAT] 打开买入/卖出弹窗
function openTradeDialog(type: 'buy' | 'sell', code: string) {
  const holding = holdingStore.getHoldingByCode(code)
  if (!holding && type === 'sell') return

  tradeType.value = type
  tradeFormData.value = {
    code: holding?.code || code,
    name: holding?.name || selectedFund.value?.name || formData.value.name || '',
    amount: '',
    shares: '',
    date: new Date().toISOString().split('T')[0] || '',
    period: 'before_15'
  }
  tradeSearchKeyword.value = ''
  tradeSearchResults.value = []
  showTradeDialog.value = true
}

function onTradeSearchInput() {
  if (tradeSearchTimer) clearTimeout(tradeSearchTimer)
  if (!tradeSearchKeyword.value.trim()) {
    tradeSearchResults.value = []
    return
  }
  tradeSearchTimer = setTimeout(async () => {
    tradeIsSearching.value = true
    try {
      tradeSearchResults.value = await searchFund(tradeSearchKeyword.value, 10)
    } finally {
      tradeIsSearching.value = false
    }
  }, 300)
}

function selectTradeFund(fund: FundInfo) {
  tradeFormData.value.code = fund.code
  tradeFormData.value.name = fund.name
  tradeSearchKeyword.value = ''
  tradeSearchResults.value = []
}

function resetTradeFundSelection() {
  tradeFormData.value.code = ''
  tradeFormData.value.name = ''
  tradeSearchKeyword.value = ''
  tradeSearchResults.value = []
}

function openTradeHistoryDialog(code: string) {
  const holding = holdingStore.getHoldingByCode(code)
  if (!holding) return
  historyFundCode.value = code
  historyFundName.value = holding.name
  activeTradeHistoryTab.value = 'all'
  showTradeHistoryDialog.value = true
}

function handleRouteActions() {
  const code = typeof route.query.code === 'string' ? route.query.code : ''
  const trade = typeof route.query.trade === 'string' ? route.query.trade : ''
  const showHistory = route.query.showHistory === '1'
  if (!code) return

  if (!holdingStore.getHoldingByCode(code)) {
    showToast('该基金不在持仓中')
    router.replace({ path: '/holding' })
    return
  }

  if (trade === 'buy' || trade === 'sell') {
    openTradeDialog(trade, code)
  } else if (showHistory) {
    openTradeHistoryDialog(code)
  }

  router.replace({ path: '/holding' })
}

// [WHAT] 提交买入/卖出
async function submitTrade() {
  if (!tradeFormData.value.code) {
    showToast('请选择基金')
    return
  }
  if (!tradeFormData.value.date) {
    showToast('请选择交易日期')
    return
  }
  if (tradeFormData.value.date > todayDate) {
    showToast('不支持今天之后的交易日期')
    return
  }
  if (!tradeFormData.value.period) {
    showToast('请选择交易时段')
    return
  }

  try {
    if (tradeType.value === 'buy') {
      const amount = parseFloat(tradeFormData.value.amount)
      if (!amount || amount <= 0) {
        showToast('请输入有效买入金额')
        return
      }
      const result = await holdingStore.addBuyTrade({
        code: tradeFormData.value.code,
        name: tradeFormData.value.name,
        amount,
        date: tradeFormData.value.date,
        period: tradeFormData.value.period
      })

      if (result.pending) {
        showToast('已记录买入，待基金公司确认对应净值后生效')
      } else {
        showToast('买入已生效')
      }
    } else {
      const shares = parseFloat(tradeFormData.value.shares)
      if (!shares || shares <= 0) {
        showToast('请输入有效卖出份额')
        return
      }

      const result = await holdingStore.addSellTrade({
        code: tradeFormData.value.code,
        shares,
        date: tradeFormData.value.date,
        period: tradeFormData.value.period
      })

      if (result.pending) {
        showToast('已记录卖出，待基金公司确认对应净值后生效')
      } else {
        showToast('卖出已生效')
      }
    }

    showTradeDialog.value = false
  } catch (error) {
    showToast(error instanceof Error ? error.message : '提交失败')
  }
}

function openQuickBuyFromAddDialog() {
  const code = formData.value.code || selectedFund.value?.code || ''
  showAddDialog.value = false
  openTradeDialog('buy', code)
}

const filteredTradeHistoryItems = computed(() => {
  const items = tradeHistorySummary.value.items
  const filtered = activeTradeHistoryTab.value === 'all'
    ? items
    : items.filter(item => item.type === activeTradeHistoryTab.value)
  return [...filtered].sort((a, b) => b.createdAt - a.createdAt)
})

function formatTradeType(type: string): string {
  const typeMap: Record<string, string> = {
    buy: '买入',
    sell: '卖出',
    auto_invest: '定投',
    switch: '转换',
    dividend: '分红',
    modify: '修改'
  }
  return typeMap[type] || '交易'
}

function formatTradeAmount(type: string, amount: number): string {
  if (type === 'modify') return '--'
  if (type === 'sell' || type === 'dividend') {
    return `+${displayMoney(amount)}`
  }
  if (type === 'buy' || type === 'auto_invest' || type === 'switch') {
    return `-${displayMoney(amount)}`
  }
  return displayMoney(amount)
}

function formatTradeMeta(item: {
  type: string
  date: string
  period: 'before_15' | 'after_15'
  createdAt: number
}): string {
  const writeTime = new Date(item.createdAt).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  if (item.type === 'modify') {
    return `修改时间：${writeTime}`
  }
  return `${item.date} · ${formatTradePeriod(item.period)}`
}

// ========== 日期选择器 ==========
const showDatePicker = ref(false)
const datePickerMode = ref<'trade'>('trade')

function toDateValues(dateStr: string): string[] {
  const normalized = dateStr || todayDate
  const [year, month, day] = normalized.split('-')
  if (!year || !month || !day) return todayDate.split('-')
  return [year, month, day]
}

const datePickerValues = computed(() => {
  return toDateValues(tradeFormData.value.date)
})

const datePickerTitle = computed(() => {
  return '选择交易日期'
})

function onDateConfirm({ selectedValues }: { selectedValues: string[] }) {
  // [WHY] Vant 4 日期选择器返回 ['2024', '01', '30'] 格式
  if (selectedValues.length >= 3) {
    const date = selectedValues.join('-')
    tradeFormData.value.date = date
  }
  showDatePicker.value = false
}

function openTradeDatePicker() {
  datePickerMode.value = 'trade'
  showDatePicker.value = true
}

function formatTradePeriod(period: 'before_15' | 'after_15'): string {
  return period === 'after_15' ? '15:00后' : '15:00前'
}

function getHoldingItemBgClass(todayProfit?: number): string {
  if (typeof todayProfit !== 'number' || Number.isNaN(todayProfit)) return ''
  if (todayProfit === 0) return 'holding-bg-flat'
  return todayProfit > 0 ? 'holding-bg-up' : 'holding-bg-down'
}

function formatShortDate(date?: string): string {
  if (!date || date.length < 10) return '-'
  return date.slice(5, 10)
}

function isTodayProfitUnavailable(holding: {
  valueSource?: 'nav' | 'estimate' | 'fallback'
  navDate?: string
}): boolean {
  if (!(isTradingDay() && hasMarketOpenedToday())) return false
  const hasTodayNav = holding.valueSource === 'nav' && holding.navDate === todayDate
  const hasEstimate = holding.valueSource === 'estimate'
  return !hasTodayNav && !hasEstimate
}

function getHoldingUpdateLabel(holding: {
  valueSource?: 'nav' | 'estimate' | 'fallback'
  navDate?: string
}): string {
  if (holding.valueSource === 'estimate' || holding.valueSource === 'fallback') return '预测值'
  if (holding.valueSource === 'nav') {
    if (isTradingDay() && hasMarketOpenedToday() && holding.navDate !== todayDate) return '预测值'
    return '已更新'
  }
  return '预测值'
}

function getTodayProfitText(holding: {
  todayProfit?: number
  valueSource?: 'nav' | 'estimate' | 'fallback'
  navDate?: string
}): string {
  if (isTodayProfitUnavailable(holding)) return '-'
  if (holding.todayProfit === undefined) return '--'
  return `${holding.todayProfit >= 0 ? '+' : ''}${formatMoney(holding.todayProfit)}`
}

function getTodayChangeText(holding: {
  todayChange?: string
  valueSource?: 'nav' | 'estimate' | 'fallback'
  navDate?: string
}): string {
  if (isTodayProfitUnavailable(holding)) return '-'
  return formatPercent(holding.todayChange || 0)
}

function getTodayProfitClassValue(holding: {
  todayProfit?: number
  valueSource?: 'nav' | 'estimate' | 'fallback'
  navDate?: string
}): number {
  if (isTodayProfitUnavailable(holding)) return 0
  return holding.todayProfit || 0
}

const latestHoldingNavDate = computed(() => {
  const dated = holdingStore.holdings
    .map(h => h.navDate || '')
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => (a > b ? -1 : 1))
  return dated[0] || ''
})

const todayColumnDateLabel = computed(() => {
  const hasEstimate = holdingStore.holdings.some(h => h.valueSource === 'estimate')
  const hasTodayNav = holdingStore.holdings.some(h => h.valueSource === 'nav' && h.navDate === todayDate)
  if (hasEstimate || hasTodayNav) return formatShortDate(todayDate)
  if (isTradingDay() && hasMarketOpenedToday()) return '-'
  return formatShortDate(latestHoldingNavDate.value)
})

const holdingColumnDateLabel = computed(() => {
  const hasEstimate = holdingStore.holdings.some(h => h.valueSource === 'estimate')
  if (hasEstimate && isTradingDay() && hasMarketOpenedToday()) return formatShortDate(todayDate)
  return formatShortDate(latestHoldingNavDate.value)
})

function toggleDetail() {
  showDetail.value = !showDetail.value
  localStorage.setItem(SHOW_DETAIL_KEY, showDetail.value ? '1' : '0')
}

function displayMoney(value: number | string | undefined): string {
  if (!showDetail.value) return '*****'
  return formatMoney(value || 0)
}

function formatPendingTradeType(type: string): string {
  if (type === 'buy') return '买入'
  if (type === 'sell') return '卖出'
  return '交易'
}

function formatPendingTradeDetail(item: {
  type: string
  amount?: number
  shares?: number
  period?: 'before_15' | 'after_15'
  date: string
}): string {
  const side = item.type === 'buy'
    ? `金额 ¥${(item.amount || 0).toFixed(2)}`
    : `份额 ${(item.shares || 0).toFixed(2)}`
  return `${item.date} · ${formatTradePeriod(item.period || 'before_15')} · ${side}`
}

async function cancelPendingTrade(id: string) {
  try {
    await showConfirmDialog({
      title: '取消待确认交易',
      message: '确认取消这笔待确认交易吗？'
    })
    const removed = holdingStore.removePendingTrade(id)
    if (removed) {
      showToast('已取消待确认交易')
    }
  } catch {
    // 用户取消
  }
}

function getPendingTradeCountByCode(code: string): number {
  return pendingCountByCode.value.get(code) || 0
}

function openPendingTradesDialog(code = '', name = '') {
  activePendingTradeCode.value = code
  activePendingTradeName.value = name
  showPendingTradesDialog.value = true
}

function toggleHoldingSort(key: HoldingSortKey) {
  const sortFlow: HoldingSortMode[] = ['none', 'rate_desc', 'rate_asc', 'amount_desc', 'amount_asc']
  if (activeHoldingSortKey.value !== key) {
    activeHoldingSortKey.value = key
    holdingSortMode.value = 'rate_desc'
    return
  }
  const currentIndex = sortFlow.indexOf(holdingSortMode.value)
  const nextIndex = (currentIndex + 1) % sortFlow.length
  holdingSortMode.value = sortFlow[nextIndex] || 'none'
  if (holdingSortMode.value === 'none') {
    activeHoldingSortKey.value = ''
  }
}

function getSortIconClass(key: HoldingSortKey): string {
  if (activeHoldingSortKey.value !== key || holdingSortMode.value === 'none') return 'sort-none'
  if (holdingSortMode.value.endsWith('desc')) return 'sort-desc'
  return 'sort-asc'
}

watch(
  pendingOnlyItems,
  async (items) => {
    const codes = items.map(item => item.code)
    if (!codes.length) {
      pendingOnlyDayChangeMap.value = {}
      return
    }
    const nextMap: Record<string, number> = {}
    await Promise.all(
      codes.map(async (code) => {
        const data = await fetchFundAccurateData(code).catch(() => null)
        if (data && typeof data.dayChange === 'number' && !Number.isNaN(data.dayChange)) {
          nextMap[code] = data.dayChange
        }
      })
    )
    pendingOnlyDayChangeMap.value = nextMap
  },
  { immediate: true }
)

function getPendingOnlyDayChangeText(code: string): string {
  const value = pendingOnlyDayChangeMap.value[code]
  if (typeof value !== 'number' || Number.isNaN(value)) return '-'
  return formatPercent(value)
}

function getPendingOnlyDayChangeValue(code: string): number {
  const value = pendingOnlyDayChangeMap.value[code]
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return value
}

function getPendingOnlyBgClass(code: string): string {
  const value = getPendingOnlyDayChangeValue(code)
  if (value === 0) return 'holding-bg-flat'
  return value > 0 ? 'holding-bg-up' : 'holding-bg-down'
}

function handleSellClick(code: string, name = '') {
  const holding = holdingStore.getHoldingByCode(code)
  if (!holding) {
    showToast(`${name || '该基金'}暂无持仓，不能卖出`)
    return
  }
  openTradeDialog('sell', code)
}

function openSyncHolding() {
  showToast('同步持仓功能开发中')
}

function openImportPage() {
  router.push('/holding/import')
}
</script>

<template>
  <div class="holding-page">
    <!-- 顶部导航栏 -->
    <van-nav-bar title="我的持仓" safe-area-inset-top>
      <template #right>
        <div class="nav-actions">
          <van-icon :name="showDetail ? 'eye-o' : 'closed-eye'" size="20" @click="toggleDetail" />
          <van-icon name="photo-o" size="20" @click="openImportPage" />
          <van-icon name="add-o" size="20" @click="openAddDialog" />
        </div>
      </template>
    </van-nav-bar>

    <!-- 汇总统计卡片 -->
    <div v-if="holdingStore.holdings.length > 0" class="summary-card">
      <div class="summary-row">
        <div class="summary-item">
          <div class="summary-label">账户资产</div>
          <div class="summary-value">{{ displayMoney(holdingStore.summary.totalValue) }}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">当日收益</div>
          <div class="summary-value" :class="summaryTodayClass">
            {{ showDetail ? (holdingStore.summary.todayProfit >= 0 ? '+' : '') + formatMoney(holdingStore.summary.todayProfit) : '*****' }}
          </div>
        </div>
      </div>
      <div class="summary-row">
        <div class="summary-item">
          <div class="summary-label">持仓盈亏</div>
          <div class="summary-value" :class="summaryProfitClass">
            {{ showDetail ? (holdingStore.summary.totalProfit >= 0 ? '+' : '') + formatMoney(holdingStore.summary.totalProfit) : '*****' }}
          </div>
        </div>
        <div class="summary-item">
          <div class="summary-label">收益率</div>
          <div class="summary-value" :class="summaryProfitClass">
            {{ formatPercent(holdingStore.summary.totalProfitRate) }}
          </div>
        </div>
      </div>
      <div v-if="pendingTradeCount > 0" class="pending-tip" @click="openPendingTradesDialog()">
        待确认交易 {{ pendingTradeCount }} 笔（基金公司公布当日净值后自动生效）
      </div>
    </div>

    <!-- 持仓列表表头 -->
    <div v-if="hasHoldingListItems" class="list-header">
      <span class="col-name">基金名称</span>
      <span class="col-today sortable-header" @click="toggleHoldingSort('today')">
        <span class="header-main">
          <span>当日收益/率</span>
          <van-icon name="sort" class="sort-icon" :class="getSortIconClass('today')" />
        </span>
        <span class="header-date">{{ todayColumnDateLabel }}</span>
      </span>
      <span class="col-profit sortable-header" @click="toggleHoldingSort('profit')">
        <span class="header-main">
          <span>持有收益/率</span>
          <van-icon name="sort" class="sort-icon" :class="getSortIconClass('profit')" />
        </span>
        <span class="header-date">{{ holdingColumnDateLabel }}</span>
      </span>
    </div>

    <!-- 持仓列表 -->
    <van-pull-refresh
      v-model="holdingStore.isRefreshing"
      @refresh="onRefresh"
      class="holding-list-container"
    >
      <template v-if="hasHoldingListItems">
        <van-swipe-cell v-for="holding in sortedHoldings" :key="holding.code">
          <div class="holding-item" :class="getHoldingItemBgClass(holding.todayProfit)" @click="goToDetail(holding.code)">
            <div class="col-name">
              <div class="fund-name">{{ holding.name || '加载中...' }}</div>
              <div class="fund-code">{{ holding.code }}</div>
              <div class="fund-meta">
                <!-- [FIX] #49, #46 根据实际状态显示更新标识 -->
                <span v-if="holding.loading" class="tag loading">加载中</span>
                <span v-else-if="holding.currentValue && holding.currentValue > 0" class="tag updated">{{ getHoldingUpdateLabel(holding) }}</span>
                <span v-else class="tag pending">待更新</span>
                <span class="amount">¥{{ displayMoney(holding.marketValue || holding.amount) }}</span>
              </div>
              <div
                v-if="getPendingTradeCountByCode(holding.code) > 0"
                class="pending-inline-tip"
                @click.stop="openPendingTradesDialog(holding.code, holding.name)"
              >
                待确认交易{{ getPendingTradeCountByCode(holding.code) }}笔
              </div>
              <div class="trade-actions" @click.stop>
                <van-button class="trade-btn buy" size="mini" type="danger" plain @click="openTradeDialog('buy', holding.code)">买入</van-button>
                <van-button class="trade-btn sell" size="mini" type="success" plain @click="openTradeDialog('sell', holding.code)">卖出</van-button>
                <van-button class="trade-btn delete" size="mini" type="danger" plain @click="handleDelete(holding.code)">删除</van-button>
                <van-button class="trade-btn history" size="mini" type="primary" plain @click="openTradeHistoryDialog(holding.code)">交易记录</van-button>
              </div>
            </div>
            <div class="col-today" :class="getChangeStatus(getTodayProfitClassValue(holding))">
              <div class="profit-amount">
                {{ showDetail ? getTodayProfitText(holding) : '*****' }}
              </div>
              <div class="profit-rate">
                {{ getTodayChangeText(holding) }}
              </div>
            </div>
            <div class="col-profit" :class="getChangeStatus(holding.profit || 0)">
              <div class="profit-amount">
                {{ showDetail ? (holding.profit !== undefined ? (holding.profit >= 0 ? '+' : '') + formatMoney(holding.profit) : '--') : '*****' }}
              </div>
              <div class="profit-rate">
                {{ holding.profitRate !== undefined ? formatPercent(holding.profitRate) : '--' }}
              </div>
            </div>
          </div>

          <template #right>
            <van-button
              square
              type="danger"
              text="删除"
              class="swipe-delete-btn"
              @click="handleDelete(holding.code)"
            />
          </template>
        </van-swipe-cell>

        <div
          v-for="pendingItem in pendingOnlyItems"
          :key="`pending_only_${pendingItem.code}`"
          class="holding-item pending-only-item"
          :class="getPendingOnlyBgClass(pendingItem.code)"
        >
          <div class="col-name">
            <div class="fund-name">{{ pendingItem.name }}</div>
            <div class="fund-code">{{ pendingItem.code }}</div>
            <div class="fund-meta">
              <span class="tag pending">待确认</span>
              <span class="amount">¥{{ displayMoney(pendingItem.pendingBuyAmount) }}</span>
            </div>
            <div
              class="pending-inline-tip"
              @click.stop="openPendingTradesDialog(pendingItem.code, pendingItem.name)"
            >
              待确认交易{{ pendingItem.count }}笔
            </div>
            <div class="trade-actions" @click.stop>
              <van-button class="trade-btn buy" size="mini" type="danger" plain @click="openTradeDialog('buy', pendingItem.code)">买入</van-button>
              <van-button class="trade-btn sell" size="mini" type="success" plain @click="handleSellClick(pendingItem.code, pendingItem.name)">卖出</van-button>
              <van-button class="trade-btn delete" size="mini" type="danger" plain @click="handleDelete(pendingItem.code)">删除</van-button>
              <van-button class="trade-btn history" size="mini" type="primary" plain @click="openPendingTradesDialog(pendingItem.code, pendingItem.name)">交易记录</van-button>
            </div>
          </div>
          <div class="col-today" :class="getChangeStatus(getPendingOnlyDayChangeValue(pendingItem.code))">
            <div class="profit-amount">-</div>
            <div class="profit-rate">{{ getPendingOnlyDayChangeText(pendingItem.code) }}</div>
          </div>
          <div class="col-profit flat">
            <div class="profit-amount">-</div>
            <div class="profit-rate">-</div>
          </div>
        </div>

        <div class="add-holding-wrap">
          <van-button class="holding-action-btn add" round type="primary" @click="openAddDialog">新增持有</van-button>
          <van-button class="holding-action-btn import" round plain type="primary" @click="openImportPage">导入持仓</van-button>
          <van-button class="holding-action-btn sync" round plain type="primary" @click="openSyncHolding">同步持仓</van-button>
        </div>
      </template>

      <!-- 空状态 -->
      <van-empty v-else description="暂无持仓记录">
        <van-button round type="primary" @click="openAddDialog">
          添加持仓
        </van-button>
      </van-empty>
      
      <!-- 底部占位，避免被导航栏遮挡 -->
      <div class="bottom-spacer"></div>
    </van-pull-refresh>

    <!-- 买入/卖出弹窗 -->
    <van-popup
      v-model:show="showTradeDialog"
      position="center"
      round
      :style="{ width: '92%', maxWidth: '520px', maxHeight: '82vh' }"
    >
      <div class="add-dialog">
        <div class="dialog-header">
          <span>{{ tradeType === 'buy' ? '买入' : '卖出' }} {{ tradeFormData.name }}</span>
          <van-icon name="cross" @click="showTradeDialog = false" />
        </div>
        <div class="dialog-content">
          <template v-if="tradeType === 'buy'">
            <van-field
              v-if="!tradeFormData.code"
              v-model="tradeSearchKeyword"
              label="选择基金"
              placeholder="输入基金代码或名称搜索"
              @input="onTradeSearchInput"
            />
            <div v-if="tradeSearchResults.length > 0" class="search-results">
              <van-cell
                v-for="fund in tradeSearchResults"
                :key="fund.code"
                :title="fund.name"
                :label="fund.code"
                clickable
                @click="selectTradeFund(fund)"
              />
            </div>
            <div v-else-if="tradeIsSearching" class="search-loading">搜索中...</div>
            <van-field
              v-if="tradeFormData.code"
              :model-value="`${tradeFormData.name} (${tradeFormData.code})`"
              label="基金"
              readonly
            >
              <template #button>
                <van-button class="reselect-btn" size="small" @click="resetTradeFundSelection">重选</van-button>
              </template>
            </van-field>
          </template>
          <van-field v-else :model-value="`${tradeFormData.name} (${tradeFormData.code})`" label="基金" readonly />

          <van-field
            v-if="tradeType === 'buy'"
            v-model="tradeFormData.amount"
            type="number"
            label="买入金额"
            placeholder="请输入金额（元）"
          />
          <van-field
            v-else
            v-model="tradeFormData.shares"
            type="number"
            label="卖出份额"
            placeholder="请输入份额"
          />

          <van-field
            v-model="tradeFormData.date"
            label="交易日期"
            placeholder="请选择交易日期"
            readonly
            is-link
            @click="openTradeDatePicker"
          />
          <van-field label="交易时段">
            <template #input>
              <van-radio-group v-model="tradeFormData.period" direction="horizontal">
                <van-radio name="before_15">15:00前</van-radio>
                <van-radio name="after_15">15:00后</van-radio>
              </van-radio-group>
            </template>
          </van-field>

          <div class="fee-tip">
            <van-icon name="info-o" />
            <span>当日交易将在基金公司确认净值后自动更新，历史日期按对应净值直接更新。</span>
          </div>
        </div>
        <div class="dialog-footer">
          <van-button block type="primary" @click="submitTrade">
            确认{{ tradeType === 'buy' ? '买入' : '卖出' }}
          </van-button>
        </div>
      </div>
    </van-popup>

    <!-- 交易记录弹窗 -->
    <van-popup
      v-model:show="showTradeHistoryDialog"
      position="center"
      round
      :style="{ width: '92%', maxWidth: '520px', maxHeight: '86vh' }"
    >
      <div class="trade-history-dialog">
        <div class="dialog-header">
          <span>{{ historyFundName }} 交易记录</span>
          <van-icon name="cross" @click="showTradeHistoryDialog = false" />
        </div>
        <div class="dialog-content">
          <div class="history-summary">
            <div class="history-summary-item">
              <div class="summary-label">已实现盈亏</div>
              <div class="summary-value" :class="getChangeStatus(tradeHistorySummary.realizedProfit)">
                {{ showDetail ? (tradeHistorySummary.realizedProfit >= 0 ? '+' : '') + formatMoney(tradeHistorySummary.realizedProfit) : '*****' }}
              </div>
            </div>
            <div class="history-summary-item">
              <div class="summary-label">浮动盈亏</div>
              <div class="summary-value" :class="getChangeStatus(tradeHistorySummary.floatingProfit)">
                {{ showDetail ? (tradeHistorySummary.floatingProfit >= 0 ? '+' : '') + formatMoney(tradeHistorySummary.floatingProfit) : '*****' }}
              </div>
            </div>
            <div class="history-summary-item">
              <div class="summary-label">整体盈利</div>
              <div class="summary-value" :class="getChangeStatus(tradeHistorySummary.totalProfit)">
                {{ showDetail ? (tradeHistorySummary.totalProfit >= 0 ? '+' : '') + formatMoney(tradeHistorySummary.totalProfit) : '*****' }}
              </div>
            </div>
          </div>

          <van-tabs v-model:active="activeTradeHistoryTab" class="history-tabs" swipeable>
            <van-tab title="全部" name="all" />
            <van-tab title="买入" name="buy" />
            <van-tab title="卖出" name="sell" />
            <van-tab title="定投" name="auto_invest" />
            <van-tab title="转换" name="switch" />
            <van-tab title="分红" name="dividend" />
            <van-tab title="修改" name="modify" />
          </van-tabs>

          <div v-if="filteredTradeHistoryItems.length > 0" class="history-list">
            <div v-for="item in filteredTradeHistoryItems" :key="item.id" class="history-item">
              <div class="history-item-left">
                <div class="history-type" :class="item.type">{{ formatTradeType(item.type) }}</div>
                <div class="history-meta">{{ formatTradeMeta(item) }}</div>
                <template v-if="item.type === 'modify' && item.modifySnapshot && item.modifyDiff">
                  <div class="history-detail">
                    份额：{{ item.modifySnapshot.before.shares.toFixed(2) }}份 -> {{ item.modifySnapshot.after.shares.toFixed(2) }}份
                  </div>
                  <div class="history-detail">
                    成本金额：{{ displayMoney(item.modifySnapshot.before.amount) }} -> {{ displayMoney(item.modifySnapshot.after.amount) }}
                  </div>
                </template>
                <div v-else class="history-detail">
                  {{ item.shares.toFixed(2) }}份 @ {{ item.nav.toFixed(4) }}
                </div>
              </div>
              <div class="history-item-right">
                <template v-if="item.type === 'modify'">
                  <div class="history-note">变更记录</div>
                </template>
                <template v-else>
                  <div class="history-amount">{{ formatTradeAmount(item.type, item.amount) }}</div>
                  <div class="history-profit" :class="getChangeStatus(item.profit)">
                    {{ showDetail ? (item.profit >= 0 ? '+' : '') + formatMoney(item.profit) : '*****' }}
                  </div>
                  <div class="history-rate" :class="getChangeStatus(item.profit)">
                    {{ formatPercent(item.profitRate) }}
                  </div>
                </template>
              </div>
            </div>
          </div>
          <van-empty v-else description="暂无买卖记录" />
        </div>
      </div>
    </van-popup>

    <!-- 添加/编辑持仓弹窗 -->
    <van-popup
      v-model:show="showAddDialog"
      position="center"
      round
      :style="{ width: '92%', maxWidth: '520px', maxHeight: '86vh' }"
    >
      <div class="add-dialog">
        <div class="dialog-header">
          <span>{{ isEditing ? '编辑持仓' : '添加持仓' }}</span>
          <van-icon name="cross" @click="showAddDialog = false" />
        </div>

        <div class="dialog-content">
          <!-- 基金选择（非编辑模式） -->
          <template v-if="!isEditing">
            <van-field
              v-if="!selectedFund"
              v-model="searchKeyword"
              label="选择基金"
              placeholder="输入基金代码或名称搜索"
              @input="onSearchInput"
            />
            
            <!-- 搜索结果 -->
            <div v-if="searchResults.length > 0" class="search-results">
              <van-cell
                v-for="fund in searchResults"
                :key="fund.code"
                :title="fund.name"
                :label="fund.code"
                clickable
                @click="selectFund(fund)"
              />
            </div>

            <!-- 已选择的基金 -->
            <van-field
              v-if="selectedFund"
              :model-value="`${selectedFund.name} (${selectedFund.code})`"
              label="已选基金"
              readonly
            >
              <template #button>
                <van-button class="reselect-btn" size="small" @click="selectedFund = null; currentNetValue = 0">重选</van-button>
              </template>
            </van-field>
          </template>

          <!-- 编辑模式显示基金信息 -->
          <van-field
            v-else
            :model-value="`${formData.name} (${formData.code})`"
            label="基金"
            readonly
          />

          <!-- 持仓金额 -->
          <van-field
            v-model="formData.amount"
            type="number"
            label="持仓金额"
            placeholder="请输入持仓金额（元）"
          />

          <van-field
            v-model="formData.profit"
            type="number"
            label="持有收益"
            placeholder="请输入持有收益（可负数）"
          />

          <div v-if="!isEditing" class="quick-buy-hint">
            <span class="hint-text">提示：今天刚买入的基金？</span>
            <button class="hint-buy-btn" type="button" @click="openQuickBuyFromAddDialog">
              <van-icon name="shopping-cart-o" />
              <span>买入</span>
            </button>
          </div>

          <!-- 计算结果展示 -->
          <div v-if="calculatedShares > 0" class="calc-result">
            <div class="calc-item">
              <span class="calc-label">预估份额</span>
              <span class="calc-value">{{ calculatedShares.toFixed(2) }} 份</span>
            </div>
            <div class="calc-item">
              <span class="calc-label">预估成本</span>
              <span class="calc-value">¥{{ (parseFloat(formData.amount || '0') - (parseFloat(formData.profit || '0') || 0)).toFixed(2) }}</span>
            </div>
          </div>
        </div>

        <div class="dialog-footer">
          <van-button block type="primary" @click="submitForm">
            {{ isEditing ? '保存修改' : '确认添加' }}
          </van-button>
        </div>
      </div>
    </van-popup>

    <!-- 交易日期选择器 -->
    <van-popup v-model:show="showDatePicker" position="bottom">
      <van-date-picker
        :title="datePickerTitle"
        :model-value="datePickerValues"
        :max-date="new Date()"
        @confirm="onDateConfirm"
        @cancel="showDatePicker = false"
      />
    </van-popup>

    <!-- 调整成本弹窗 -->
    <van-popup
      v-model:show="showCostDialog"
      position="bottom"
      round
      :style="{ height: '45%' }"
    >
      <div class="cost-dialog">
        <div class="dialog-header">
          <span>调整持仓成本</span>
          <van-icon name="cross" @click="showCostDialog = false" />
        </div>

        <div class="dialog-content">
          <!-- 基金信息 -->
          <van-field
            :model-value="`${costFormData.name} (${costFormData.code})`"
            label="基金"
            readonly
          />

          <!-- 成本金额 -->
          <van-field
            v-model="costFormData.amount"
            type="number"
            label="成本金额"
            placeholder="请输入调整后的成本金额（元）"
          />

          <!-- 持有份额 -->
          <van-field
            v-model="costFormData.shares"
            type="number"
            label="持有份额"
            placeholder="请输入调整后的持有份额"
          />

          <!-- 提示信息 -->
          <div class="cost-tip">
            <van-icon name="info-o" />
            <span>调整成本可用于分红再投、补仓摊薄等场景，修改后收益率将重新计算</span>
          </div>
        </div>

        <div class="dialog-footer">
          <van-button block type="primary" @click="submitCostAdjust">
            确认调整
          </van-button>
        </div>
      </div>
    </van-popup>

    <!-- 待确认交易弹窗 -->
    <van-popup
      v-model:show="showPendingTradesDialog"
      position="center"
      round
      :style="{ width: '92%', maxWidth: '520px', maxHeight: '72vh' }"
    >
      <div class="trade-history-dialog">
        <div class="dialog-header">
          <span>{{ pendingDialogTitle }}</span>
          <van-icon name="cross" @click="showPendingTradesDialog = false" />
        </div>
        <div class="dialog-content">
          <div v-if="pendingTradeItems.length > 0" class="history-list">
            <div v-for="item in pendingTradeItems" :key="item.id" class="history-item">
              <div class="history-item-left">
                <div class="history-type" :class="item.type">{{ formatPendingTradeType(item.type) }}</div>
                <div class="history-detail">{{ item.name }} ({{ item.code }})</div>
                <div class="history-meta">{{ formatPendingTradeDetail(item) }}</div>
              </div>
              <div class="history-item-right">
                <van-button class="pending-cancel-btn" size="small" plain type="danger" @click="cancelPendingTrade(item.id)">取消</van-button>
              </div>
            </div>
          </div>
          <van-empty v-else description="暂无待确认交易" />
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.holding-page {
  /* [WHY] 使用 100% 高度适配 flex 布局 */
  height: 100%;
  background: var(--bg-primary);
  transition: background-color 0.3s;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 导航栏右侧按钮 */
.nav-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

/* 汇总卡片 - 交易终端风格 */
.summary-card {
  background: linear-gradient(145deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  margin: 12px;
  padding: 20px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  position: relative;
  overflow: hidden;
}

.summary-card::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 180px;
  height: 180px;
  background: radial-gradient(circle, rgba(25, 137, 250, 0.12) 0%, transparent 70%);
  opacity: 0.5;
  transform: translate(35%, -35%);
}

.summary-card::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  width: 140px;
  height: 140px;
  background: radial-gradient(circle, rgba(0, 168, 112, 0.12) 0%, transparent 70%);
  opacity: 0.45;
  transform: translate(-30%, 30%);
}

.summary-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
}

.summary-row:last-child {
  margin-bottom: 0;
}

.summary-item {
  flex: 1;
  position: relative;
  z-index: 1;
}

.summary-label {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.summary-value {
  font-size: 20px;
  font-weight: 700;
  font-family: var(--font-number);
  color: var(--text-highlight);
  letter-spacing: -0.5px;
}

.summary-value.up {
  color: var(--color-up) !important;
}

.summary-value.down {
  color: var(--color-down) !important;
}

.pending-tip {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-color);
  font-size: 12px;
  color: var(--text-secondary);
  position: relative;
  z-index: 1;
  cursor: pointer;
}

.pending-inline-tip {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
}

/* 列表表头 */
.list-header {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.list-header > span {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  flex-direction: column;
  gap: 4px;
}

.list-header .col-name {
  justify-content: flex-start;
  flex-direction: row;
}

.list-header .header-date {
  font-size: 10px;
  color: var(--text-muted);
}

.sortable-header {
  cursor: pointer;
}

.header-main {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.sort-icon {
  font-size: 12px;
}

.sort-icon.sort-none {
  color: var(--text-muted);
}

.sort-icon.sort-desc,
.sort-icon.sort-asc {
  color: var(--color-primary);
}

/* 持仓列表 */
.holding-list-container {
  /* [WHY] 使用 flex: 1 自动撑满剩余空间 */
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  /* [WHY] Android WebView 需要明确的触摸行为 */
  touch-action: pan-y;
}

/* [WHY] 底部占位，确保最后一项不被底部导航栏遮挡 */
.bottom-spacer {
  height: calc(70px + env(safe-area-inset-bottom, 0px));
  flex-shrink: 0;
}

.holding-item {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  align-items: center;
  padding: 14px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-light);
  transition: all 0.2s;
  position: relative;
}

.holding-item.holding-bg-up {
  background: linear-gradient(
    100deg,
    rgba(246, 70, 93, 0.18) 0%,
    rgba(246, 70, 93, 0.08) 34%,
    var(--bg-secondary) 72%
  );
}

.holding-item.holding-bg-down {
  background: linear-gradient(
    100deg,
    rgba(14, 203, 129, 0.2) 0%,
    rgba(14, 203, 129, 0.08) 34%,
    var(--bg-secondary) 72%
  );
}

.holding-item.holding-bg-flat {
  background: linear-gradient(
    100deg,
    rgba(139, 148, 158, 0.2) 0%,
    rgba(139, 148, 158, 0.08) 34%,
    var(--bg-secondary) 72%
  );
}

:deep(.swipe-delete-btn) {
  height: 100%;
}

.holding-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: transparent;
  transition: background 0.2s;
}

.holding-item:active {
  background: var(--bg-hover);
}

.holding-item:active::before {
  background: var(--color-primary);
}

.col-name .fund-name {
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-word;
}

.col-name .fund-code {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.col-name .fund-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* [FIX] #49, #46 不同状态的标签样式 */
.col-name .tag {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 2px;
}

.col-name .tag.updated {
  background: var(--color-primary-bg, rgba(25, 137, 250, 0.1));
  color: var(--color-primary, #1989fa);
}

.col-name .tag.pending {
  background: var(--color-warning-bg, rgba(255, 151, 106, 0.1));
  color: var(--color-warning, #ff976a);
}

.col-name .tag.loading {
  background: var(--bg-tertiary, #f7f8fa);
  color: var(--text-secondary, #969799);
}

.col-name .amount {
  font-size: 12px;
  color: var(--text-secondary);
}

.trade-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.trade-actions :deep(.trade-btn) {
  background: var(--bg-tertiary);
  border-color: var(--border-color);
}

.trade-actions :deep(.trade-btn.buy) {
  color: var(--color-up);
  border-color: var(--color-up);
  background: var(--color-up-bg);
}

.trade-actions :deep(.trade-btn.sell) {
  color: var(--color-down);
  border-color: var(--color-down);
  background: var(--color-down-bg);
}

.trade-actions :deep(.trade-btn.delete) {
  color: var(--color-up);
  border-color: var(--color-up);
  background: var(--color-up-bg);
}

.trade-actions :deep(.trade-btn.history) {
  color: var(--color-info);
  border-color: var(--color-info);
  background: var(--color-info-bg);
}

.reselect-btn {
  background: var(--bg-tertiary);
  border-color: var(--border-color);
  color: var(--text-primary);
}

.add-holding-wrap {
  padding: 14px 16px 4px;
  background: var(--bg-secondary);
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.add-holding-wrap :deep(.holding-action-btn) {
  font-size: 13px;
  font-weight: 500;
  border-radius: 999px;
}

.add-holding-wrap :deep(.holding-action-btn.add) {
  box-shadow: 0 4px 10px rgba(25, 137, 250, 0.22);
}

.add-holding-wrap :deep(.holding-action-btn.import),
.add-holding-wrap :deep(.holding-action-btn.sync) {
  background: var(--bg-tertiary);
  border-color: var(--border-color);
  color: var(--text-primary);
}

.col-today, .col-profit {
  text-align: center;
  font-size: 14px;
  border-radius: 10px;
  padding: 8px 6px;
}

.col-today .profit-amount,
.col-profit .profit-amount {
  font-size: 14px;
}

.col-today .profit-rate,
.col-profit .profit-rate {
  font-size: 12px;
  opacity: 0.8;
}

.col-today.up .profit-amount,
.col-today.up .profit-rate,
.col-profit.up .profit-amount,
.col-profit.up .profit-rate {
  color: var(--color-up) !important;
}

.col-today.down .profit-amount,
.col-today.down .profit-rate,
.col-profit.down .profit-amount,
.col-profit.down .profit-rate {
  color: var(--color-down) !important;
}

.up { color: var(--color-up); }
.down { color: var(--color-down); }
.flat { color: var(--text-secondary); }

:global([data-theme="dark"] .holding-page .up) {
  color: var(--color-up-bright);
}

:global([data-theme="dark"] .holding-page .down) {
  color: var(--color-down-bright);
}

:global([data-theme="dark"] .holding-page .summary-value.up) {
  color: var(--color-up-bright) !important;
}

:global([data-theme="dark"] .holding-page .summary-value.down) {
  color: var(--color-down-bright) !important;
}

:global([data-theme="dark"] .holding-page .col-today.up .profit-amount),
:global([data-theme="dark"] .holding-page .col-today.up .profit-rate),
:global([data-theme="dark"] .holding-page .col-profit.up .profit-amount),
:global([data-theme="dark"] .holding-page .col-profit.up .profit-rate) {
  color: var(--color-up-bright) !important;
}

:global([data-theme="dark"] .holding-page .col-today.down .profit-amount),
:global([data-theme="dark"] .holding-page .col-today.down .profit-rate),
:global([data-theme="dark"] .holding-page .col-profit.down .profit-amount),
:global([data-theme="dark"] .holding-page .col-profit.down .profit-rate) {
  color: var(--color-down-bright) !important;
}

:global([data-theme="dark"] .holding-page .history-type.buy) {
  color: var(--color-up-bright) !important;
}

:global([data-theme="dark"] .holding-page .history-type.sell) {
  color: var(--color-down-bright) !important;
}

:global([data-theme="dark"] .holding-page .pending-cancel-btn),
:global(:root:not([data-theme="light"]) .holding-page .pending-cancel-btn) {
  background: #161B22 !important;
  border-color: var(--border-strong) !important;
  color: #FF8787 !important;
}

/* 深色模式与未显式设置 light 时，持仓行背景保持纯背景 */
:global([data-theme="dark"] .holding-page .holding-item.holding-bg-up),
:global([data-theme="dark"] .holding-page .holding-item.holding-bg-down),
:global([data-theme="dark"] .holding-page .holding-item.holding-bg-flat),
:global(:root:not([data-theme="light"]) .holding-page .holding-item.holding-bg-up),
:global(:root:not([data-theme="light"]) .holding-page .holding-item.holding-bg-down),
:global(:root:not([data-theme="light"]) .holding-page .holding-item.holding-bg-flat) {
  background: var(--bg-secondary) !important;
}

:global([data-theme="dark"] .holding-page .history-tabs .van-tab) {
  color: var(--text-muted);
}

:global([data-theme="dark"] .holding-page .history-tabs .van-tab--active) {
  color: var(--text-primary);
}

:global([data-theme="dark"] .holding-page .reselect-btn) {
  background: var(--bg-elevated);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

:global([data-theme="dark"] .holding-page .holding-action-btn.import.van-button),
:global([data-theme="dark"] .holding-page .holding-action-btn.sync.van-button),
:global(:root:not([data-theme="light"]) .holding-page .holding-action-btn.import.van-button),
:global(:root:not([data-theme="light"]) .holding-page .holding-action-btn.sync.van-button) {
  background: #161B22 !important;
  border-color: var(--border-color) !important;
  color: var(--text-primary) !important;
}

/* 深色模式：基金名称与账户资产使用默认灰色 */
:global([data-theme="dark"] .holding-page .col-name .fund-name) {
  color: var(--text-primary) !important;
}

:global([data-theme="dark"] .holding-page .summary-row:first-child .summary-item:first-child .summary-value) {
  color: var(--text-primary) !important;
}

:global([data-theme="dark"] .holding-page .summary-value:not(.up):not(.down)) {
  color: var(--text-primary) !important;
}

.action-btn {
  height: 100%;
}

/* 添加弹窗样式 */
.add-dialog {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.dialog-content {
  flex: 1;
  overflow-y: auto;
}

.search-results {
  max-height: 200px;
  overflow-y: auto;
  border-bottom: 1px solid var(--border-color);
}

.search-loading {
  padding: 10px 16px;
  color: var(--text-secondary);
  font-size: 13px;
}

.calc-result {
  padding: 16px;
  background: var(--bg-tertiary);
  margin: 16px;
  border-radius: 8px;
}

.calc-item {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
}

.calc-label {
  color: var(--text-secondary);
}

.calc-value {
  color: var(--text-primary);
  font-weight: 500;
}

.dialog-footer {
  padding: 16px;
}

/* A/C 类份额标签 */
.share-class-display {
  display: flex;
  align-items: center;
  gap: 8px;
}

.share-class-tag {
  padding: 2px 8px;
  font-size: 12px;
  border-radius: 4px;
  font-weight: 500;
}

.share-class-tag.a {
  background: var(--color-warning-bg);
  color: var(--color-warning);
}

.share-class-tag.c {
  background: var(--color-info-bg);
  color: var(--color-info);
}

.share-class-desc {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 费用选项 */
.fee-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.fee-rate {
  font-size: 13px;
  color: var(--text-secondary);
}

.fee-rate-input {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.fee-input {
  width: 50px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  text-align: center;
}

.fee-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  margin: 0 16px;
  background: var(--color-primary-bg);
  border-radius: 4px;
  font-size: 12px;
  color: var(--color-primary);
}

.trade-history-dialog {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  max-height: 86vh;
  overflow: hidden;
}

.history-summary {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.history-summary-item {
  padding: 10px 8px;
  border-radius: 8px;
  background: var(--bg-tertiary);
  text-align: center;
}

.history-tabs {
  border-bottom: 1px solid var(--border-light);
}

.history-tabs :deep(.van-tabs__nav) {
  background: var(--bg-secondary);
}

.history-tabs :deep(.van-tab) {
  color: var(--text-secondary);
}

.history-tabs :deep(.van-tab--active) {
  color: var(--text-primary);
  font-weight: 600;
}

.history-tabs :deep(.van-tabs__line) {
  background: var(--color-primary);
}

.history-list {
  padding: 8px 0;
  max-height: calc(86vh - 220px);
  overflow-y: auto;
}

.history-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-light);
}

.history-item-left {
  flex: 1;
}

.history-type {
  font-size: 12px;
  font-weight: 600;
}

.history-type.buy {
  color: var(--color-up);
}

.history-type.sell {
  color: var(--color-down);
}

.history-type.auto_invest {
  color: var(--color-info);
}

.history-type.switch {
  color: var(--color-warning);
}

.history-type.dividend {
  color: var(--color-warning);
}

.history-type.modify {
  color: var(--text-secondary);
}

.history-meta,
.history-detail {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 3px;
}

.history-item-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  text-align: right;
}

.history-amount {
  font-size: 13px;
  color: var(--text-primary);
}

.history-profit {
  font-size: 14px;
  font-weight: 600;
  margin-top: 3px;
}

.history-rate {
  font-size: 12px;
  margin-top: 2px;
}

.history-note {
  font-size: 12px;
  color: var(--text-secondary);
}

.pending-cancel-btn {
  background: var(--bg-tertiary);
  border-color: var(--border-color);
}

.quick-buy-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 8px 16px 0;
  padding: 10px 12px;
  background: var(--color-info-bg);
  border: 1px solid rgba(88, 166, 255, 0.28);
  border-radius: 8px;
}

.hint-text {
  font-size: 13px;
  color: var(--text-secondary);
}

.hint-buy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--color-info);
  font-size: 14px;
  font-weight: 600;
}

/* 调整成本弹窗 */
.cost-dialog {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.cost-dialog .dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid var(--border-color);
}

.cost-dialog .dialog-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
}

.cost-dialog .dialog-footer {
  padding: 16px;
  border-top: 1px solid var(--border-color);
}

.cost-tip {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 12px 16px;
  margin: 12px 16px;
  background: var(--color-warning-bg, #fffbe6);
  border-radius: 8px;
  font-size: 13px;
  color: var(--color-warning, #faad14);
  line-height: 1.5;
}

/* [FIX] 弹窗表单字体颜色优化，提高可读性 */
.add-dialog :deep(.van-field__label),
.cost-dialog :deep(.van-field__label) {
  color: var(--text-primary) !important;
  font-weight: 500;
  font-size: 14px;
}

.add-dialog :deep(.van-field__control),
.cost-dialog :deep(.van-field__control) {
  color: var(--text-primary) !important;
  font-size: 14px;
  -webkit-text-fill-color: var(--text-primary) !important;
}

.add-dialog :deep(.van-field__control::placeholder),
.cost-dialog :deep(.van-field__control::placeholder) {
  color: var(--text-secondary) !important;
  font-size: 14px;
  opacity: 1;
}

/* 深色模式专用：确保颜色更亮更清晰 */
:global([data-theme="dark"] .holding-page .add-dialog .van-field__label),
:global([data-theme="dark"] .holding-page .cost-dialog .van-field__label) {
  color: var(--text-primary) !important;
}

:global([data-theme="dark"] .holding-page .add-dialog .van-field__control),
:global([data-theme="dark"] .holding-page .cost-dialog .van-field__control) {
  color: var(--text-primary) !important;
  -webkit-text-fill-color: var(--text-primary) !important;
}

:global([data-theme="dark"] .holding-page .add-dialog .van-field__control::placeholder),
:global([data-theme="dark"] .holding-page .cost-dialog .van-field__control::placeholder) {
  color: #8b949e !important;
  -webkit-text-fill-color: #8b949e !important;
}
</style>
