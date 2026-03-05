<script setup lang="ts">
// [WHY] 分析页 - 展示资产配置和收益分析
// [WHAT] 显示持仓分布饼图、收益统计、交易汇总、自研统计算法

import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useHoldingStore } from '@/stores/holding'
import { useTradeStore } from '@/stores/trade'
import { useThemeStore } from '@/stores/theme'
import { formatMoney, formatPercent, getChangeStatus } from '@/utils/format'
import { showToast } from 'vant'
import { fetchNetValueHistoryFast } from '@/api/fundFast'
import {
  calculateReturnAnalysis,
  calculateFundScore,
  calculateCorrelation,
  analyzeAllocation,
  type ReturnAnalysis,
  type FundScore,
  type CorrelationAnalysis,
  type AllocationAdvice,
  type NetValuePoint
} from '@/utils/statistics'

const router = useRouter()
const holdingStore = useHoldingStore()
const tradeStore = useTradeStore()
const themeStore = useThemeStore()

// [WHAT] 下拉刷新状态
const isRefreshing = ref(false)

// [WHAT] 统计分析数据
const portfolioAnalysis = ref<ReturnAnalysis | null>(null)
const portfolioScore = ref<FundScore | null>(null)
const correlationData = ref<CorrelationAnalysis | null>(null)
const allocationAdvice = ref<AllocationAdvice | null>(null)
const isAnalyzing = ref(false)

// [WHAT] 初始化数据
onMounted(async () => {
  holdingStore.initHoldings()
  // [FIX] #40 确保交易统计数据同步
  tradeStore.refreshTrades()
  // 延迟加载统计分析
  setTimeout(() => runStatisticsAnalysis(), 1000)
})

// [WHAT] 下拉刷新
async function onRefresh() {
  isRefreshing.value = true
  try {
    await holdingStore.refreshEstimates()
    // [FIX] #40 刷新时同步交易数据
    tradeStore.refreshTrades()
    await runStatisticsAnalysis()
    showToast('刷新成功')
  } finally {
    isRefreshing.value = false
  }
}

// [WHAT] 运行统计分析
async function runStatisticsAnalysis() {
  if (holdingStore.holdings.length === 0) return
  
  isAnalyzing.value = true
  try {
    // [WHAT] 获取持仓基金历史净值
    const fundsData: { code: string; name: string; data: NetValuePoint[] }[] = []
    
    for (const h of holdingStore.holdings.slice(0, 10)) {
      try {
        const history = await fetchNetValueHistoryFast(h.code, 120)
        if (history.length > 0) {
          fundsData.push({
            code: h.code,
            name: h.name,
            data: history.map(item => ({
              date: item.date,
              value: item.netValue,
              change: item.changeRate
            }))
          })
        }
      } catch { /* 忽略单个基金错误 */ }
    }
    
    // [WHAT] 计算组合收益分析（加权平均）
    // [FIX] #56 使用加权平均计算组合收益而非单只基金
    if (fundsData.length > 0) {
      // 计算各基金权重
      const totalValue = holdingStore.summary.totalValue || 1
      const weights: number[] = []
      
      for (const fd of fundsData) {
        const holding = holdingStore.holdings.find(h => h.code === fd.code)
        const value = (holding?.marketValue && holding.marketValue > 0) ? holding.marketValue : (holding?.amount || 0)
        weights.push(value / totalValue)
      }
      
      // 计算每只基金的收益指标
      const analyses = fundsData.map(fd => calculateReturnAnalysis(fd.data)).filter(a => a !== null)
      
      if (analyses.length > 0) {
        // 加权平均收益指标
        let totalWeight = 0
        let weightedAnnualized = 0
        let weightedVolatility = 0
        let weightedDrawdown = 0
        let weightedSharpe = 0
        
        analyses.forEach((analysis, i) => {
          const w = weights[i] || 1 / analyses.length
          totalWeight += w
          weightedAnnualized += analysis.annualizedReturn * w
          weightedVolatility += analysis.volatility * w
          weightedDrawdown += analysis.maxDrawdown * w
          weightedSharpe += analysis.sharpeRatio * w
        })
        
        // 归一化
        if (totalWeight > 0) {
          // [FIX] 只使用 ReturnAnalysis 类型中存在的属性
          const firstAnalysis = analyses[0]
          portfolioAnalysis.value = {
            totalReturn: firstAnalysis.totalReturn,
            annualizedReturn: weightedAnnualized / totalWeight,
            dailyReturn: firstAnalysis.dailyReturn,
            volatility: weightedVolatility / totalWeight,
            maxDrawdown: weightedDrawdown / totalWeight,
            maxDrawdownStart: firstAnalysis.maxDrawdownStart,
            maxDrawdownEnd: firstAnalysis.maxDrawdownEnd,
            sharpeRatio: weightedSharpe / totalWeight,
            sortinoRatio: firstAnalysis.sortinoRatio,
            calmarRatio: firstAnalysis.calmarRatio,
            tradingDays: firstAnalysis.tradingDays,
            startDate: firstAnalysis.startDate,
            endDate: firstAnalysis.endDate
          }
          portfolioScore.value = calculateFundScore(portfolioAnalysis.value)
        }
      }
    }
    
    // [WHAT] 计算相关性
    if (fundsData.length >= 2) {
      correlationData.value = calculateCorrelation(fundsData)
    }
    
    // [WHAT] 资产配置建议
    // [FIX] #57 从基金数据中获取正确的类型信息
    const holdingsForAllocation = holdingStore.holdings.map(h => ({
      code: h.code,
      name: h.name,
      amount: h.marketValue || h.amount,
      // 优先使用已存储的基金类型，否则根据名称推断
      type: h.fundType || inferFundType(h.name)
    }))
    allocationAdvice.value = analyzeAllocation(holdingsForAllocation)
    
  } finally {
    isAnalyzing.value = false
  }
}

// [WHAT] 获取评分等级颜色
function getScoreLevelColor(level: string): string {
  const colors: Record<string, string> = {
    'S': '#ff6b6b',
    'A': '#ffa726',
    'B': '#66bb6a',
    'C': '#42a5f5',
    'D': '#78909c'
  }
  return colors[level] || '#999'
}

// [FIX] #57 根据基金名称推断类型
function inferFundType(name: string): string {
  if (!name) return '混合型'
  if (name.includes('股票') || name.includes('成长') || name.includes('价值')) return '股票型'
  if (name.includes('指数') || name.includes('ETF') || name.includes('500') || name.includes('300')) return '指数型'
  if (name.includes('债券') || name.includes('纯债') || name.includes('信用')) return '债券型'
  if (name.includes('货币') || name.includes('现金') || name.includes('宝')) return '货币型'
  if (name.includes('QDII') || name.includes('美元') || name.includes('港股') || name.includes('纳斯达克')) return 'QDII'
  if (name.includes('FOF') || name.includes('养老目标')) return 'FOF'
  return '混合型'
}

// ========== 资产配置分析 ==========

// [WHAT] 计算各基金占比
// [FIX] #55 修复资产配置统计逻辑
const assetAllocation = computed(() => {
  // 计算有效市值总和（包含没有实时估值的持仓）
  let total = 0
  holdingStore.holdings.forEach(h => {
    if (h.marketValue && h.marketValue > 0) {
      total += h.marketValue
    } else {
      // 没有市值时使用买入金额
      total += h.amount
    }
  })
  
  if (total <= 0) return []
  
  return holdingStore.holdings
    .map(h => {
      // [FIX] #55 如果没有市值，使用买入金额
      const value = (h.marketValue && h.marketValue > 0) ? h.marketValue : h.amount
      return {
        code: h.code,
        name: h.name,
        value,
        ratio: (value / total) * 100
      }
    })
    .sort((a, b) => b.value - a.value)
})

// [WHAT] 饼图颜色
const pieColors = ['#1989fa', '#07c160', '#ff976a', '#ee0a24', '#7232dd', '#1cbbb4', '#f2826a', '#9191ff']

// [WHAT] 计算饼图扇形路径
function getPieSlice(startAngle: number, endAngle: number, index: number) {
  const cx = 100
  const cy = 100
  const r = 80
  
  const startRad = (startAngle - 90) * Math.PI / 180
  const endRad = (endAngle - 90) * Math.PI / 180
  
  const x1 = cx + r * Math.cos(startRad)
  const y1 = cy + r * Math.sin(startRad)
  const x2 = cx + r * Math.cos(endRad)
  const y2 = cy + r * Math.sin(endRad)
  
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  
  return {
    path: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`,
    color: pieColors[index % pieColors.length] || '#999'
  }
}

// [WHAT] 生成饼图数据
const pieSlices = computed(() => {
  const slices: { path: string; color: string; name: string; ratio: number }[] = []
  let currentAngle = 0
  
  assetAllocation.value.forEach((item, index) => {
    const angle = (item.ratio / 100) * 360
    const slice = getPieSlice(currentAngle, currentAngle + angle, index)
    slices.push({
      ...slice,
      name: item.name,
      ratio: item.ratio
    })
    currentAngle += angle
  })
  
  return slices
})

// ========== 收益分析 ==========

// [WHAT] 收益率状态
const profitStatus = computed(() => getChangeStatus(holdingStore.summary.totalProfit))
const todayStatus = computed(() => getChangeStatus(holdingStore.summary.todayProfit))

// ========== 交易统计 ==========

const tradeStats = computed(() => tradeStore.statistics)

// [WHAT] 跳转到交易记录
function goToTrades() {
  router.push('/trades')
}
</script>

<template>
  <div class="analysis-page">
    <!-- 顶部导航 -->
    <van-nav-bar title="数据分析" :safe-area-inset-top="true">
      <template #right>
        <van-icon name="replay" size="18" @click="onRefresh" />
      </template>
    </van-nav-bar>

    <van-pull-refresh v-model="isRefreshing" @refresh="onRefresh" class="analysis-content">
    <!-- 总资产卡片 -->
    <div class="summary-card">
      <div class="summary-header">
        <span class="label">总资产</span>
        <span class="value">{{ formatMoney(holdingStore.summary.totalValue, '¥') }}</span>
      </div>
      <div class="summary-grid">
        <div class="summary-item">
          <span class="item-label">持仓盈亏</span>
          <span class="item-value" :class="profitStatus">
            {{ holdingStore.summary.totalProfit >= 0 ? '+' : '' }}{{ formatMoney(holdingStore.summary.totalProfit) }}
          </span>
        </div>
        <div class="summary-item">
          <span class="item-label">收益率</span>
          <span class="item-value" :class="profitStatus">
            {{ formatPercent(holdingStore.summary.totalProfitRate) }}
          </span>
        </div>
        <div class="summary-item">
          <span class="item-label">今日收益</span>
          <span class="item-value" :class="todayStatus">
            {{ holdingStore.summary.todayProfit >= 0 ? '+' : '' }}{{ formatMoney(holdingStore.summary.todayProfit) }}
          </span>
        </div>
        <div class="summary-item">
          <span class="item-label">持仓成本</span>
          <span class="item-value">{{ formatMoney(holdingStore.summary.totalCost) }}</span>
        </div>
      </div>
    </div>

    <!-- 资产配置 -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">资产配置</span>
      </div>
      
      <div v-if="assetAllocation.length > 0" class="allocation-content">
        <!-- 饼图 -->
        <div class="pie-chart">
          <svg viewBox="0 0 200 200">
            <path
              v-for="(slice, index) in pieSlices"
              :key="index"
              :d="slice.path"
              :fill="slice.color"
            />
            <!-- 中心空白圆 - 适配主题 -->
            <circle cx="100" cy="100" r="50" :fill="themeStore.actualTheme === 'dark' ? 'var(--bg-secondary)' : 'white'" />
            <!-- 中心文字 - 适配主题 -->
            <text x="100" y="95" text-anchor="middle" :fill="themeStore.actualTheme === 'dark' ? 'var(--text-secondary)' : '#666'" font-size="12">持仓</text>
            <text x="100" y="115" text-anchor="middle" :fill="themeStore.actualTheme === 'dark' ? 'var(--text-primary)' : '#333'" font-size="14" font-weight="bold">
              {{ assetAllocation.length }}只
            </text>
          </svg>
        </div>
        
        <!-- 配置列表 -->
        <div class="allocation-list">
          <div 
            v-for="(item, index) in assetAllocation" 
            :key="item.code"
            class="allocation-item"
          >
            <div class="item-color" :style="{ background: pieColors[index % pieColors.length] }"></div>
            <div class="item-info">
              <span class="item-name">{{ item.name }}</span>
              <span class="item-ratio">{{ item.ratio.toFixed(1) }}%</span>
            </div>
            <div class="item-value">{{ formatMoney(item.value, '¥') }}</div>
          </div>
        </div>
      </div>
      
      <van-empty v-else description="暂无持仓数据" />
    </div>

    <!-- 风险评估 -->
    <div class="section" v-if="portfolioScore">
      <div class="section-header">
        <span class="section-title">持仓评分</span>
        <van-loading v-if="isAnalyzing" size="14" />
      </div>
      
      <div class="score-card">
        <div class="score-main">
          <div class="score-circle" :style="{ borderColor: getScoreLevelColor(portfolioScore.level) }">
            <span class="score-value">{{ portfolioScore.totalScore }}</span>
            <span class="score-level" :style="{ color: getScoreLevelColor(portfolioScore.level) }">
              {{ portfolioScore.level }}级
            </span>
          </div>
          <div class="score-recommendation">{{ portfolioScore.recommendation }}</div>
        </div>
        
        <div class="score-details">
          <div class="score-item">
            <span class="score-label">收益</span>
            <van-progress :percentage="portfolioScore.returnScore" :show-pivot="false" stroke-width="6" color="#07c160" />
          </div>
          <div class="score-item">
            <span class="score-label">风险</span>
            <van-progress :percentage="portfolioScore.riskScore" :show-pivot="false" stroke-width="6" color="#1989fa" />
          </div>
          <div class="score-item">
            <span class="score-label">稳定</span>
            <van-progress :percentage="portfolioScore.stabilityScore" :show-pivot="false" stroke-width="6" color="#ff976a" />
          </div>
        </div>
      </div>
    </div>

    <!-- 收益指标 -->
    <div class="section" v-if="portfolioAnalysis">
      <div class="section-header">
        <span class="section-title">收益指标</span>
      </div>
      
      <div class="metrics-grid">
        <div class="metric-item">
          <span class="metric-value" :class="portfolioAnalysis.annualizedReturn >= 0 ? 'up' : 'down'">
            {{ portfolioAnalysis.annualizedReturn.toFixed(2) }}%
          </span>
          <span class="metric-label">年化收益</span>
        </div>
        <div class="metric-item">
          <span class="metric-value">{{ portfolioAnalysis.volatility.toFixed(2) }}%</span>
          <span class="metric-label">年化波动</span>
        </div>
        <div class="metric-item">
          <span class="metric-value down">-{{ portfolioAnalysis.maxDrawdown.toFixed(2) }}%</span>
          <span class="metric-label">最大回撤</span>
        </div>
        <div class="metric-item">
          <span class="metric-value">{{ portfolioAnalysis.sharpeRatio.toFixed(2) }}</span>
          <span class="metric-label">夏普比率</span>
        </div>
      </div>
    </div>

    <!-- 相关性分析 -->
    <div class="section" v-if="correlationData">
      <div class="section-header">
        <span class="section-title">持仓相关性</span>
      </div>
      
      <div class="correlation-card">
        <div class="diversification-score">
          <span class="score-num">{{ correlationData.diversification }}</span>
          <span class="score-text">分散度</span>
        </div>
        <div class="correlation-suggestion">{{ correlationData.suggestion }}</div>
        
        <div v-if="correlationData.highCorrelationPairs.length > 0" class="high-correlation-list">
          <div class="warning-title">
            <van-icon name="warning-o" color="#ff976a" />
            <span>高相关性提醒</span>
          </div>
          <div v-for="pair in correlationData.highCorrelationPairs" :key="`${pair.fund1.code}-${pair.fund2.code}`" class="correlation-pair">
            <span class="pair-funds">{{ pair.fund1.name.slice(0, 6) }}... ↔ {{ pair.fund2.name.slice(0, 6) }}...</span>
            <span class="pair-value">{{ (pair.correlation * 100).toFixed(0) }}%</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 配置建议 -->
    <div class="section" v-if="allocationAdvice">
      <div class="section-header">
        <span class="section-title">配置建议</span>
      </div>
      
      <div class="advice-card">
        <div class="risk-level">
          <span class="risk-label">风险等级</span>
          <span class="risk-value" :class="allocationAdvice.riskLevel">
            {{ allocationAdvice.riskLevel === 'high' ? '高风险' : allocationAdvice.riskLevel === 'medium' ? '中风险' : '低风险' }}
          </span>
        </div>
        
        <div class="advice-list">
          <div v-for="(suggestion, idx) in allocationAdvice.suggestions" :key="idx" class="advice-item">
            <van-icon name="bulb-o" color="#1989fa" />
            <span>{{ suggestion }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 交易统计 -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">交易统计</span>
        <span class="section-action" @click="goToTrades">查看记录 ></span>
      </div>
      
      <div class="trade-stats">
        <div class="trade-stat-item">
          <div class="stat-icon buy">买</div>
          <div class="stat-info">
            <span class="stat-label">累计买入</span>
            <span class="stat-value">{{ formatMoney(tradeStats.totalBuy) }}</span>
          </div>
        </div>
        <div class="trade-stat-item">
          <div class="stat-icon sell">卖</div>
          <div class="stat-info">
            <span class="stat-label">累计卖出</span>
            <span class="stat-value">{{ formatMoney(tradeStats.totalSell) }}</span>
          </div>
        </div>
        <div class="trade-stat-item">
          <div class="stat-icon dividend">分</div>
          <div class="stat-info">
            <span class="stat-label">累计分红</span>
            <span class="stat-value">{{ formatMoney(tradeStats.totalDividend) }}</span>
          </div>
        </div>
        <div class="trade-stat-item">
          <div class="stat-icon fee">费</div>
          <div class="stat-info">
            <span class="stat-label">累计手续费</span>
            <span class="stat-value">{{ formatMoney(tradeStats.totalFee) }}</span>
          </div>
        </div>
      </div>
      
      <div class="net-invest">
        <span>净投入</span>
        <span class="net-value">{{ formatMoney(tradeStats.netInvest, '¥') }}</span>
      </div>
    </div>

    <!-- 快捷入口（从自选页迁移） -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">快捷入口</span>
      </div>
      
      <div class="tools-grid">
        <div class="tool-item" @click="router.push('/search')">
          <van-icon name="search" size="24" />
          <span>搜索</span>
        </div>
        <div class="tool-item" @click="router.push('/compare')">
          <van-icon name="balance-o" size="24" />
          <span>对比</span>
        </div>
        <div class="tool-item" @click="router.push('/calculator')">
          <van-icon name="gold-coin-o" size="24" />
          <span>定投</span>
        </div>
        <div class="tool-item" @click="router.push('/manager-rank')">
          <van-icon name="friends-o" size="24" />
          <span>经理</span>
        </div>
        <div class="tool-item" @click="router.push('/backtest')">
          <van-icon name="chart-trending-o" size="24" />
          <span>回测</span>
        </div>
        <div class="tool-item" @click="router.push('/report')">
          <van-icon name="description-o" size="24" />
          <span>报告</span>
        </div>
        <div class="tool-item" @click="router.push('/calendar')">
          <van-icon name="calendar-o" size="24" />
          <span>日历</span>
        </div>
        <div class="tool-item" @click="router.push('/alerts')">
          <van-icon name="bell" size="24" />
          <span>提醒</span>
        </div>
      </div>
    </div>

    <!-- 投资提示 -->
    <div class="tips-section">
      <van-notice-bar 
        left-icon="volume-o"
        text="投资有风险，数据仅供参考。基金过往业绩不代表未来表现。"
      />
    </div>
    </van-pull-refresh>
  </div>
</template>

<style scoped>
.analysis-page {
  /* [WHY] 使用 100% 高度适配 flex 布局 */
  height: 100%;
  background: var(--bg-primary);
  transition: background-color 0.3s;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.analysis-content {
  /* [WHY] 使用 flex: 1 自动撑满剩余空间 */
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  /* [WHY] Android WebView 需要明确的触摸行为 */
  touch-action: pan-y;
  /* [WHY] 底部留白确保内容不被遮挡 */
  padding-bottom: 20px;
}

/* 总资产卡片 */
.summary-card {
  background: var(--bg-secondary);
  margin: 12px;
  padding: 20px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
}

.summary-header {
  text-align: center;
  margin-bottom: 20px;
}

.summary-header .label {
  display: block;
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.summary-header .value {
  font-size: 32px;
  font-weight: 600;
  color: var(--text-primary);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.summary-item {
  text-align: center;
}

.item-label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.item-value {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

/* [WHY] 标准涨跌颜色 */
.item-value.up { color: #f56c6c; }  /* 红涨 */
.item-value.down { color: #67c23a; }  /* 绿跌 */

/* 区块样式 */
.section {
  background: var(--bg-secondary);
  margin: 12px;
  border-radius: 12px;
  overflow: hidden;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.section-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

.section-action {
  font-size: 13px;
  color: var(--color-primary);
}

/* 资产配置 */
.allocation-content {
  padding: 16px;
}

.pie-chart {
  width: 160px;
  height: 160px;
  margin: 0 auto 20px;
}

.pie-chart svg {
  width: 100%;
  height: 100%;
}

.allocation-list {
  flex: 1;
  min-width: 0;
}

.allocation-item {
  display: flex;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-color);
}

.allocation-item:last-child {
  border-bottom: none;
}

.item-color {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  margin-right: 12px;
}

.item-info {
  flex: 1;
  display: flex;
  justify-content: space-between;
  margin-right: 16px;
}

.item-name {
  font-size: 14px;
  color: var(--text-primary);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-ratio {
  font-size: 13px;
  color: var(--text-secondary);
}

.allocation-item .item-value {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}

/* 交易统计 */
.trade-stats {
  padding: 16px;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.trade-stat-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.stat-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: #fff;
}

.stat-icon.buy { background: var(--color-up); }
.stat-icon.sell { background: var(--color-down); }
.stat-icon.dividend { background: #ff9800; }
.stat-icon.fee { background: var(--text-muted); }

.stat-info {
  display: flex;
  flex-direction: column;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.stat-value {
  font-size: 15px;
  color: var(--text-primary);
  font-weight: 500;
}

.net-invest {
  display: flex;
  justify-content: space-between;
  padding: 16px;
  background: var(--bg-tertiary);
  font-size: 14px;
  color: var(--text-primary);
}

.net-value {
  font-weight: 600;
  color: var(--color-primary);
}

/* 提示 */
.tips-section {
  margin: 12px;
}

/* 工具网格 */
.tools-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  padding: 16px;
}

.tool-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 8px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  transition: opacity 0.2s;
}

.tool-item:active {
  opacity: 0.7;
}

.tool-item .van-icon {
  color: var(--color-primary);
}

/* 评分卡片 */
.score-card {
  padding: 16px;
}

.score-main {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.score-circle {
  width: 70px;
  height: 70px;
  border-radius: 50%;
  border: 3px solid #07c160;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.score-value {
  font-size: 22px;
  font-weight: bold;
  color: var(--text-primary);
}

.score-level {
  font-size: 12px;
  font-weight: 600;
}

.score-recommendation {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.score-details {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.score-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.score-item .score-label {
  width: 36px;
  font-size: 12px;
  color: var(--text-secondary);
}

.score-item :deep(.van-progress) {
  flex: 1;
}

/* 收益指标 */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  padding: 16px;
}

.metric-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.metric-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.metric-value.up {
  color: var(--color-up);
}

.metric-value.down {
  color: var(--color-down);
}

.metric-label {
  font-size: 11px;
  color: var(--text-secondary);
}

/* 相关性分析 */
.correlation-card {
  padding: 16px;
}

.diversification-score {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;
}

.diversification-score .score-num {
  font-size: 28px;
  font-weight: bold;
  color: var(--color-primary);
}

.diversification-score .score-text {
  font-size: 13px;
  color: var(--text-secondary);
}

.correlation-suggestion {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.high-correlation-list {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 12px;
}

.warning-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: #ff976a;
  margin-bottom: 10px;
}

.correlation-pair {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  font-size: 12px;
}

.pair-funds {
  color: var(--text-secondary);
}

.pair-value {
  color: #ff976a;
  font-weight: 500;
}

/* 配置建议 */
.advice-card {
  padding: 16px;
}

.risk-level {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.risk-label {
  font-size: 13px;
  color: var(--text-secondary);
}

.risk-value {
  font-size: 13px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
}

.risk-value.high {
  background: rgba(238, 10, 36, 0.1);
  color: #ee0a24;
}

.risk-value.medium {
  background: rgba(255, 151, 106, 0.1);
  color: #ff976a;
}

.risk-value.low {
  background: rgba(7, 193, 96, 0.1);
  color: #07c160;
}

.advice-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.advice-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.4;
}

.advice-item .van-icon {
  flex-shrink: 0;
  margin-top: 2px;
}
</style>
