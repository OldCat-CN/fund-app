<script setup lang="ts">
// [WHY] 持仓管理页 - 管理用户的基金持仓和收益
// [WHAT] 显示持仓列表、汇总统计，支持添加/编辑/删除持仓
// [WHAT] 支持 A类/C类基金费用计算

import { ref, onMounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useHoldingStore } from '@/stores/holding'
import { searchFund, detectShareClass } from '@/api/fund'
import { fetchFundAccurateData } from '@/api/fundFast'
import { showConfirmDialog, showToast } from 'vant'
import { formatMoney, formatPercent, getChangeStatus } from '@/utils/format'
import type { FundInfo, HoldingRecord, FundShareClass } from '@/types/fund'
import ScreenshotImport from '@/components/ScreenshotImport.vue'

const router = useRouter()
const route = useRoute()
const holdingStore = useHoldingStore()
const SHOW_DETAIL_KEY = 'holding_show_detail'

// ========== 表单相关 ==========
const showAddDialog = ref(false)
const isEditing = ref(false)

// ========== 截图导入相关 ==========
const showImportDialog = ref(false)
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
const todayDate = new Date().toISOString().split('T')[0] || ''

// ========== 交易记录弹窗 ==========
const showTradeHistoryDialog = ref(false)
const historyFundCode = ref('')
const historyFundName = ref('')
const showDetail = ref(true)
type TradeHistoryTab = 'all' | 'buy' | 'sell' | 'auto_invest' | 'switch' | 'dividend' | 'modify'
const activeTradeHistoryTab = ref<TradeHistoryTab>('all')

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
  
  await holdingStore.addOrUpdateHolding(record, {
    ensureInitialTradeRecord: !isEditing.value,
    initialTradePeriod: 'before_15',
    initialTradeType: 'modify'
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
  showTradeDialog.value = true
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
      const existingHolding = holdingStore.getHoldingByCode(tradeFormData.value.code)
      if (!existingHolding) {
        const accurate = await fetchFundAccurateData(tradeFormData.value.code).catch(() => null)
        const nav = accurate?.nav || currentNetValue.value || 1
        const shares = amount / nav

        await holdingStore.addOrUpdateHolding({
          code: tradeFormData.value.code,
          name: tradeFormData.value.name || accurate?.name || tradeFormData.value.code,
          shareClass: detectShareClass(tradeFormData.value.code, tradeFormData.value.name || ''),
          amount,
          buyNetValue: nav,
          shares,
          buyDate: tradeFormData.value.date,
          holdingDays: 0,
          createdAt: Date.now()
        }, {
          ensureInitialTradeRecord: true,
          initialTradePeriod: tradeFormData.value.period,
          initialTradeType: 'buy'
        })
        showToast('买入已记录')
      } else {
        const result = await holdingStore.addBuyTrade({
          code: tradeFormData.value.code,
          amount,
          date: tradeFormData.value.date,
          period: tradeFormData.value.period
        })

        if (result.pending) {
          showToast('已记录买入，待基金公司确认当日净值后生效')
        } else {
          showToast('买入已生效')
        }
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
        showToast('已记录卖出，待基金公司确认当日净值后生效')
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
  if (activeTradeHistoryTab.value === 'all') return items
  return items.filter(item => item.type === activeTradeHistoryTab.value)
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
  if (type === 'sell' || type === 'dividend') {
    return `+${displayMoney(amount)}`
  }
  if (type === 'buy' || type === 'auto_invest' || type === 'switch') {
    return `-${displayMoney(amount)}`
  }
  return displayMoney(amount)
}

// [WHAT] 截图导入完成回调
function onImported(count: number) {
  // [WHAT] 导入完成后刷新持仓列表
  holdingStore.refreshEstimates()
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

function toggleDetail() {
  showDetail.value = !showDetail.value
  localStorage.setItem(SHOW_DETAIL_KEY, showDetail.value ? '1' : '0')
}

function displayMoney(value: number | string | undefined): string {
  if (!showDetail.value) return '*****'
  return formatMoney(value || 0)
}
</script>

<template>
  <div class="holding-page">
    <!-- 顶部导航栏 -->
    <van-nav-bar title="我的持仓" safe-area-inset-top>
      <template #right>
        <div class="nav-actions">
          <van-icon :name="showDetail ? 'eye-o' : 'closed-eye'" size="20" @click="toggleDetail" />
          <van-icon name="photo-o" size="20" @click="showImportDialog = true" />
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
      <div v-if="pendingTradeCount > 0" class="pending-tip">
        待确认交易 {{ pendingTradeCount }} 笔（基金公司公布当日净值后自动生效）
      </div>
    </div>

    <!-- 持仓列表表头 -->
    <div v-if="holdingStore.holdings.length > 0" class="list-header">
      <span class="col-name">基金名称</span>
      <span class="col-today">当日收益</span>
      <span class="col-profit">持有收益</span>
    </div>

    <!-- 持仓列表 -->
    <van-pull-refresh
      v-model="holdingStore.isRefreshing"
      @refresh="onRefresh"
      class="holding-list-container"
    >
      <template v-if="holdingStore.holdings.length > 0">
        <van-swipe-cell v-for="holding in holdingStore.holdings" :key="holding.code">
          <div class="holding-item" :class="getHoldingItemBgClass(holding.todayProfit)" @click="goToDetail(holding.code)">
            <div class="col-name">
              <div class="fund-name">{{ holding.name || '加载中...' }}</div>
              <div class="fund-code">{{ holding.code }}</div>
              <div class="fund-meta">
                <!-- [FIX] #49, #46 根据实际状态显示更新标识 -->
                <span v-if="holding.loading" class="tag loading">加载中</span>
                <span v-else-if="holding.currentValue && holding.currentValue > 0" class="tag updated">已更新</span>
                <span v-else class="tag pending">待更新</span>
                <span class="amount">¥{{ displayMoney(holding.marketValue || holding.amount) }}</span>
              </div>
              <div class="trade-actions" @click.stop>
                <van-button class="trade-btn buy" size="mini" type="danger" plain @click="openTradeDialog('buy', holding.code)">买入</van-button>
                <van-button class="trade-btn sell" size="mini" type="success" plain @click="openTradeDialog('sell', holding.code)">卖出</van-button>
                <van-button class="trade-btn delete" size="mini" type="danger" plain @click="handleDelete(holding.code)">删除</van-button>
                <van-button class="trade-btn history" size="mini" type="primary" plain @click="openTradeHistoryDialog(holding.code)">交易记录</van-button>
              </div>
            </div>
            <div class="col-today" :class="getChangeStatus(holding.todayProfit || 0)">
              <div class="profit-amount">
                {{ showDetail ? (holding.todayProfit !== undefined ? (holding.todayProfit >= 0 ? '+' : '') + formatMoney(holding.todayProfit) : '--') : '*****' }}
              </div>
              <div class="profit-rate">
                {{ formatPercent(holding.todayChange || 0) }}
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

        <div class="add-holding-wrap">
          <van-button round type="primary" block @click="openAddDialog">
            新增持有
          </van-button>
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
          <van-field :model-value="`${tradeFormData.name} (${tradeFormData.code})`" label="基金" readonly />

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
                <div class="history-meta">{{ item.date }} · {{ formatTradePeriod(item.period) }}</div>
                <div class="history-detail">
                  {{ item.shares.toFixed(2) }}份 @ {{ item.nav.toFixed(4) }}
                </div>
              </div>
              <div class="history-item-right">
                <div class="history-amount">{{ formatTradeAmount(item.type, item.amount) }}</div>
                <div class="history-profit" :class="getChangeStatus(item.profit)">
                  {{ showDetail ? (item.profit >= 0 ? '+' : '') + formatMoney(item.profit) : '*****' }}
                </div>
                <div class="history-rate" :class="getChangeStatus(item.profit)">
                  {{ formatPercent(item.profitRate) }}
                </div>
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
                <van-button size="small" @click="selectedFund = null; currentNetValue = 0">重选</van-button>
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

    <!-- 截图导入弹窗 -->
    <ScreenshotImport 
      v-model:show="showImportDialog"
      @imported="onImported"
    />
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
}

/* 列表表头 */
.list-header {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  padding: 12px 16px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.list-header > span {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.list-header .col-name {
  justify-content: flex-start;
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

.add-holding-wrap {
  padding: 14px 16px 4px;
  background: var(--bg-secondary);
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

/* 深色模式与未显式设置 light 时，持仓行背景保持纯背景 */
:global([data-theme="dark"] .holding-page .holding-item.holding-bg-up),
:global([data-theme="dark"] .holding-page .holding-item.holding-bg-down),
:global([data-theme="dark"] .holding-page .holding-item.holding-bg-flat),
:global(:root:not([data-theme="light"]) .holding-page .holding-item.holding-bg-up),
:global(:root:not([data-theme="light"]) .holding-page .holding-item.holding-bg-down),
:global(:root:not([data-theme="light"]) .holding-page .holding-item.holding-bg-flat) {
  background: var(--bg-secondary) !important;
}

:global([data-theme="dark"] .holding-page .history-tabs) :deep(.van-tab) {
  color: var(--text-muted);
}

:global([data-theme="dark"] .holding-page .history-tabs) :deep(.van-tab--active) {
  color: var(--text-highlight);
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
:global([data-theme="dark"] .holding-page .add-dialog) :deep(.van-field__label),
:global([data-theme="dark"] .holding-page .cost-dialog) :deep(.van-field__label) {
  color: #f0f6fc !important;
}

:global([data-theme="dark"] .holding-page .add-dialog) :deep(.van-field__control),
:global([data-theme="dark"] .holding-page .cost-dialog) :deep(.van-field__control) {
  color: #f0f6fc !important;
  -webkit-text-fill-color: #f0f6fc !important;
}

:global([data-theme="dark"] .holding-page .add-dialog) :deep(.van-field__control::placeholder),
:global([data-theme="dark"] .holding-page .cost-dialog) :deep(.van-field__control::placeholder) {
  color: #8b949e !important;
  -webkit-text-fill-color: #8b949e !important;
}
</style>
