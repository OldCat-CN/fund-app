<script setup lang="ts">
// [WHY] 截图导入组件 - 通过 OCR 识别截图中的持仓信息
// [WHAT] 支持选择图片，识别基金持仓并批量导入
// [WHAT] 支持通过名称搜索匹配基金代码，支持已持有基金的加仓
// [DEPS] 依赖 ocr.ts 进行文字识别

import { ref, computed, watch } from 'vue'
import { showToast, showLoadingToast, closeToast } from 'vant'
import { recognizeHoldingSnapshot, preloadOcrEngine, type RecognizedHolding, type ProfitLabelType } from '@/utils/ocr'
import { searchFund } from '@/api/fund'
import { fetchFundAccurateData, fetchNetValueHistoryFast } from '@/api/fundFast'
import { useHoldingStore } from '@/stores/holding'
import type { HoldingRecord, FundInfo } from '@/types/fund'

const props = defineProps<{
  show: boolean
  embedded?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'imported', count: number): void
}>()

const holdingStore = useHoldingStore()

// [WHAT] 组件状态
const step = ref<'upload' | 'recognizing' | 'preview' | 'importing'>('upload')
const selectedImage = ref<string>('')
const ocrProgress = ref(0)
const ocrStatus = ref('')
const recognizedHoldings = ref<RecognizedHolding[]>([])
const snapshotProfitLabel = ref<ProfitLabelType>('unknown')

// [WHAT] 增强后的持仓信息（包含从 API 获取的名称和净值）
interface EnhancedHolding extends RecognizedHolding {
  fundInfo?: FundInfo
  /** 导入时使用的净值 */
  importNetValue?: number
  /** 导入净值日期 */
  importNavDate?: string
  /** 导入成本金额（由市值-持仓收益反推） */
  importCostAmount?: number
  loading?: boolean
  selected?: boolean
  /** 是否是加仓（已持有的基金） */
  isAddPosition?: boolean
  /** 搜索结果（用于手动匹配） */
  searchResults?: FundInfo[]
  /** 是否正在搜索 */
  searching?: boolean
  /** 是否显示搜索面板 */
  showSearch?: boolean
  /** 手动搜索关键字 */
  searchKeyword?: string
}
const enhancedHoldings = ref<EnhancedHolding[]>([])
const preloadingEngine = ref(false)
const ocrEngineReady = ref(false)
const searchTimers = new Map<number, ReturnType<typeof setTimeout>>()
const profitLabelText = computed(() => {
  if (snapshotProfitLabel.value === 'today') return '今日收益'
  if (snapshotProfitLabel.value === 'yesterday') return '昨日收益'
  return '未识别'
})

// [WHAT] 计算选中数量
const selectedCount = computed(() => {
  return enhancedHoldings.value.filter(h => h.selected && h.code).length
})

// [WHAT] 计算加仓数量
const addPositionCount = computed(() => {
  return enhancedHoldings.value.filter(h => h.selected && h.code && h.isAddPosition).length
})
const allSelectableCount = computed(() => enhancedHoldings.value.filter(h => h.code && h.amount > 0).length)

watch(
  () => props.show,
  () => {
    if (preloadingEngine.value || ocrEngineReady.value) return
    preloadingEngine.value = true
    preloadOcrEngine()
      .then(() => {
        ocrEngineReady.value = true
      })
      .catch(() => undefined)
      .finally(() => {
        preloadingEngine.value = false
      })
  },
  { immediate: true }
)

// [WHAT] 文件选择处理
async function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  
  // [WHAT] 验证文件类型
  if (!file.type.startsWith('image/')) {
    showToast('请选择图片文件')
    return
  }
  
  // [WHAT] 转换为 Base64 预览
  const reader = new FileReader()
  reader.onload = async (e) => {
    selectedImage.value = e.target?.result as string
    await startRecognition(file)
  }
  reader.readAsDataURL(file)
}

// [WHAT] 开始 OCR 识别
async function startRecognition(file: File) {
  step.value = 'recognizing'
  ocrProgress.value = 0
  ocrStatus.value = '准备识别...'
  
  try {
    const ocrSource = await prepareOcrImageSource(file)

    if (preloadingEngine.value) {
      ocrStatus.value = '识别引擎预加载中...'
    }

    const snapshot = await recognizeHoldingSnapshot(ocrSource, (progress, status) => {
      ocrProgress.value = Math.round(progress * 100)
      ocrStatus.value = status
    })
    const holdings = snapshot.holdings
    snapshotProfitLabel.value = snapshot.profitLabel
    recognizedHoldings.value = holdings
    
    if (holdings.length === 0) {
      showToast('未识别到持仓信息，请确保截图清晰')
      step.value = 'upload'
      return
    }
    
    // [WHAT] 增强持仓信息（获取基金名称和净值）
    await enhanceHoldings(holdings)
    step.value = 'preview'
    
  } catch (error) {
    console.error('OCR识别失败:', error)
    showToast('识别失败，请重试')
    step.value = 'upload'
  }
}

async function prepareOcrImageSource(file: File): Promise<File | string> {
  try {
    const maxEdge = 2600
    const bitmap = await createImageBitmap(file)
    const width = bitmap.width
    const height = bitmap.height
    const longest = Math.max(width, height)
    if (longest <= maxEdge) {
      bitmap.close()
      return file
    }

    const scale = maxEdge / longest
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return file
    }

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)
    bitmap.close()
    return canvas.toDataURL('image/png')
  } catch {
    return file
  }
}

// [WHAT] 增强持仓信息
async function enhanceHoldings(holdings: RecognizedHolding[]) {
  enhancedHoldings.value = holdings.map(h => ({
    ...h,
    loading: true,
    // [NEW] 允许选中已持有的基金（用于加仓）
    selected: h.amount > 0 && (h.code ? true : false),
    isAddPosition: h.code ? holdingStore.hasHolding(h.code) : false,
    needsCodeMatch: h.needsCodeMatch || !h.code
  }))
  
  // [WHAT] 并行获取基金信息
  const promises = holdings.map(async (h, index) => {
    // [NEW] 如果没有代码但有名称，尝试通过名称搜索匹配
    if (!h.code && h.name) {
      await searchAndMatchByName(index, h.name)
      return
    }
    
    if (!h.code) {
      enhancedHoldings.value[index].loading = false
      return
    }
    
    try {
      // [WHAT] 获取基金信息
      const results = await searchFund(h.code, 1)
      if (results.length > 0) {
        enhancedHoldings.value[index].fundInfo = results[0]
        if (!h.name) {
          enhancedHoldings.value[index].name = results[0].name
        }
      }
      
      await fillImportData(index)
      
      // [NEW] 检查是否已持有
      enhancedHoldings.value[index].isAddPosition = holdingStore.hasHolding(h.code)
    } catch (error) {
      console.error(`获取基金 ${h.code} 信息失败:`, error)
    } finally {
      enhancedHoldings.value[index].loading = false
    }
  })
  
  await Promise.all(promises)
}

// [NEW] 通过名称搜索并自动匹配基金代码
async function searchAndMatchByName(index: number, name: string) {
  try {
    enhancedHoldings.value[index].searching = true
    
    // [WHAT] 搜索基金
    const keyword = name.trim()
    const results = await searchFund(keyword, 10)
    enhancedHoldings.value[index].searchResults = results
    enhancedHoldings.value[index].searchKeyword = keyword
    
    // [WHAT] 尝试自动匹配（名称高度相似）
    if (results.length > 0) {
      const codeInName = keyword.match(/\d{6}/)?.[0]
      const codeMatch = codeInName ? results.find(r => r.code === codeInName) : undefined
      // 优先精确匹配
      const exactMatch = results.find(r => r.name === keyword)
      // 其次检查名称包含关系
      const containsMatch = results.find(r => 
        r.name.includes(keyword) || keyword.includes(r.name.replace(/[A-Z]$/i, ''))
      )
      
      const bestMatch = codeMatch || exactMatch || containsMatch
      
      if (bestMatch) {
        // [WHAT] 自动选中最佳匹配
        await selectSearchResult(index, bestMatch)
      } else {
        // [WHAT] 无法自动匹配，显示搜索面板让用户手动选择
        enhancedHoldings.value[index].showSearch = true
        enhancedHoldings.value[index].loading = false
      }
    } else {
      enhancedHoldings.value[index].loading = false
    }
  } catch (error) {
    console.error(`搜索基金 ${name} 失败:`, error)
    enhancedHoldings.value[index].loading = false
  } finally {
    enhancedHoldings.value[index].searching = false
  }
}

// [NEW] 用户手动选择搜索结果
async function selectSearchResult(index: number, fund: FundInfo) {
  const holding = enhancedHoldings.value[index]
  
  // [WHAT] 更新代码和基金信息
  holding.code = fund.code
  holding.fundInfo = fund
  holding.name = fund.name
  holding.showSearch = false
  holding.searchKeyword = ''
  holding.needsCodeMatch = false
  holding.selected = true
  
  // [WHAT] 检查是否已持有
  holding.isAddPosition = holdingStore.hasHolding(fund.code)
  
  await fillImportData(index)
  
  holding.loading = false
}

function getTodayDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeCostAmount(marketAmount: number, holdingProfit?: number): number {
  if (typeof holdingProfit !== 'number' || isNaN(holdingProfit)) return marketAmount
  const cost = marketAmount - holdingProfit
  if (!isFinite(cost) || cost <= 0) return marketAmount
  return cost
}

async function resolveImportNav(code: string): Promise<{ nav: number; navDate: string } | null> {
  const today = getTodayDate()
  try {
    const accurate = await fetchFundAccurateData(code)
    const now = new Date()
    const isBeforeClose = now.getHours() < 15
    const useYesterdayByTime = isBeforeClose
    const useYesterdayByLabel = snapshotProfitLabel.value === 'yesterday'
    const useTodayByLabel = snapshotProfitLabel.value === 'today'
    const hasTodayNav = accurate.nav > 0 && accurate.navDate === today

    const shouldUseYesterday =
      useYesterdayByLabel ||
      (!useTodayByLabel && (useYesterdayByTime || !hasTodayNav))

    if (shouldUseYesterday) {
      const history = await fetchNetValueHistoryFast(code, 120)
      const yesterdayNav = history.find(item => item.netValue > 0 && item.date < today)
      if (yesterdayNav) {
        return { nav: yesterdayNav.netValue, navDate: yesterdayNav.date }
      }
      if (accurate.nav > 0 && accurate.navDate && accurate.navDate < today) {
        return { nav: accurate.nav, navDate: accurate.navDate }
      }
      return null
    }

    if (hasTodayNav) {
      return { nav: accurate.nav, navDate: accurate.navDate }
    }
    if (accurate.currentValue > 0) {
      const navDate = accurate.dataSource === 'nav' && accurate.navDate ? accurate.navDate : today
      return { nav: accurate.currentValue, navDate }
    }
    if (accurate.nav > 0 && accurate.navDate) {
      return { nav: accurate.nav, navDate: accurate.navDate }
    }
    return null
  } catch (error) {
    console.error(`获取基金 ${code} 导入净值失败:`, error)
    return null
  }
}

async function fillImportData(index: number) {
  const holding = enhancedHoldings.value[index]
  if (!holding || !holding.code || holding.amount <= 0) return

  const resolved = await resolveImportNav(holding.code)
  if (resolved?.nav && resolved.nav > 0) {
    holding.importNetValue = resolved.nav
    holding.importNavDate = resolved.navDate
  }
  holding.importCostAmount = normalizeCostAmount(holding.amount, holding.holdingProfit)
}

// [NEW] 手动搜索基金
async function manualSearch(index: number, keyword: string) {
  const trimmed = keyword.trim()
  
  const holding = enhancedHoldings.value[index]
  holding.searchKeyword = keyword
  if (searchTimers.has(index)) {
    clearTimeout(searchTimers.get(index)!)
    searchTimers.delete(index)
  }
  if (!trimmed) {
    holding.searchResults = []
    holding.searching = false
    return
  }
  holding.searching = true
  searchTimers.set(index, setTimeout(async () => {
    try {
      const results = await searchFund(trimmed, 10)
      holding.searchResults = results
      holding.showSearch = true
    } catch (error) {
      console.error('搜索失败:', error)
      showToast('搜索失败')
    } finally {
      holding.searching = false
      searchTimers.delete(index)
    }
  }, 250))
}

// [NEW] 切换搜索面板显示
function toggleSearchPanel(index: number) {
  const holding = enhancedHoldings.value[index]
  holding.showSearch = !holding.showSearch
  
  // 如果打开面板且没有搜索结果，自动搜索
  if (holding.showSearch && (!holding.searchResults || holding.searchResults.length === 0)) {
    const initKeyword = holding.searchKeyword || holding.code || holding.name
    if (initKeyword) {
      manualSearch(index, initKeyword)
    }
  }
}

// [WHAT] 切换选中状态
function toggleSelect(index: number) {
  const holding = enhancedHoldings.value[index]
  if (!holding.code) {
    // [NEW] 没有代码时，打开搜索面板
    toggleSearchPanel(index)
    return
  }
  holding.selected = !holding.selected
}

// [WHAT] 全选/取消全选
function toggleSelectAll() {
  // [NEW] 包括已持有的基金（加仓）
  const validHoldings = enhancedHoldings.value.filter(
    h => h.code && h.amount > 0
  )
  const allSelected = validHoldings.every(h => h.selected)
  
  validHoldings.forEach(h => {
    h.selected = !allSelected
  })
}

// [WHAT] 修改金额
function updateAmount(index: number, value: string) {
  const amount = parseFloat(value)
  if (!isNaN(amount) && amount >= 0) {
    enhancedHoldings.value[index].amount = amount
    fillImportData(index)
  }
}

// [WHAT] 确认导入
async function confirmImport() {
  const toImport = enhancedHoldings.value.filter(h => h.selected && h.code && h.amount > 0)
  
  if (toImport.length === 0) {
    showToast('请选择要导入的持仓')
    return
  }
  
  step.value = 'importing'
  showLoadingToast({ message: '导入中...', forbidClick: true })
  
  try {
    let imported = 0
    let addedPosition = 0
    
    for (const h of toImport) {
      const marketAmount = h.amount
      const netValue = h.importNetValue || 1
      const shares = netValue > 0 ? marketAmount / netValue : 0
      const costAmount = normalizeCostAmount(marketAmount, h.holdingProfit)
      const buyNetValue = shares > 0 ? costAmount / shares : netValue
      if (shares <= 0 || buyNetValue <= 0) {
        continue
      }
      
      // [NEW] 检查是否是加仓
      if (h.isAddPosition) {
        // [WHAT] 加仓：获取现有持仓，累加金额和份额
        const existingHolding = holdingStore.getHoldingByCode(h.code)
        if (existingHolding) {
          // [WHAT] 计算新的平均买入净值
          const totalAmount = existingHolding.amount + costAmount
          const totalShares = existingHolding.shares + shares
          const avgNetValue = totalAmount / totalShares
          
          const record: HoldingRecord = {
            code: h.code,
            name: existingHolding.name,
            shareClass: existingHolding.shareClass,
            amount: totalAmount,
            buyNetValue: avgNetValue,
            shares: totalShares,
            buyDate: existingHolding.buyDate, // 保留原买入日期
            holdingDays: existingHolding.holdingDays,
            createdAt: existingHolding.createdAt
          }
          
          await holdingStore.addOrUpdateHolding(record)
          addedPosition++
          continue
        }
      }
      
      // [WHAT] 新建持仓
      const record: HoldingRecord = {
        code: h.code,
        name: h.name || h.fundInfo?.name || h.code,
        shareClass: detectShareClass(h.code, h.name),
        amount: costAmount,
        buyNetValue: buyNetValue,
        shares: shares,
        buyDate: h.importNavDate || getTodayDate(),
        holdingDays: 0,
        createdAt: Date.now()
      }
      
      await holdingStore.addOrUpdateHolding(record)
      imported++
    }
    
    closeToast()
    // [NEW] 显示导入和加仓数量
    if (addedPosition > 0 && imported > 0) {
      showToast(`新增 ${imported} 只，加仓 ${addedPosition} 只`)
    } else if (addedPosition > 0) {
      showToast(`成功加仓 ${addedPosition} 只基金`)
    } else {
      showToast(`成功导入 ${imported} 只基金`)
    }
    emit('imported', imported + addedPosition)
    closeDialog()
    
  } catch (error) {
    closeToast()
    console.error('导入失败:', error)
    showToast('导入失败，请重试')
    step.value = 'preview'
  }
}

// [WHAT] 检测基金份额类型
function detectShareClass(code: string, name: string): 'A' | 'C' {
  if (name?.includes('C') || code?.endsWith('C')) return 'C'
  return 'A'
}

// [WHAT] 关闭弹窗
function closeDialog() {
  emit('update:show', false)
  // [WHAT] 重置状态
  setTimeout(() => {
    step.value = 'upload'
    selectedImage.value = ''
    ocrProgress.value = 0
    ocrStatus.value = ''
    snapshotProfitLabel.value = 'unknown'
    recognizedHoldings.value = []
    enhancedHoldings.value = []
    searchTimers.forEach((timer) => clearTimeout(timer))
    searchTimers.clear()
  }, 300)
}

// [WHAT] 重新选择图片
function reselectImage() {
  step.value = 'upload'
  selectedImage.value = ''
}

// [WHAT] 获取置信度颜色
function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.8) return '#67c23a'
  if (confidence >= 0.5) return '#e6a23c'
  return '#f56c6c'
}

// [WHAT] 格式化金额
function formatAmount(amount: number): string {
  return amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function handleWrapperShowUpdate(value: boolean) {
  emit('update:show', value)
}
</script>

<template>
  <component
    :is="props.embedded ? 'div' : 'van-popup'"
    :show="props.embedded ? true : props.show"
    :position="props.embedded ? undefined : 'center'"
    :round="!props.embedded"
    :overlay="props.embedded ? false : undefined"
    :style="props.embedded ? undefined : { width: '92%', maxWidth: '560px', maxHeight: '86vh' }"
    :class="{ 'import-embedded-shell': !!props.embedded }"
    @update:show="handleWrapperShowUpdate"
  >
    <div class="import-dialog" :class="{ embedded: !!props.embedded }">
      <!-- 标题栏 -->
      <div class="dialog-header">
        <span>截图导入持仓</span>
        <van-icon name="cross" @click="closeDialog" />
      </div>

      <!-- 上传步骤 -->
      <div v-if="step === 'upload'" class="upload-step">
        <div class="upload-tip">
          <van-icon name="photo-o" size="48" color="var(--color-primary)" />
          <p class="tip-title">选择持仓截图</p>
          <p class="tip-desc">支持支付宝、天天基金、蛋卷基金、京东金融等平台的持仓截图</p>
        </div>
        
        <div class="upload-actions">
          <label class="upload-btn">
            <van-icon name="photo" />
            <span>相册</span>
            <input type="file" accept="image/*" @change="handleFileChange" />
          </label>
        </div>
        
        <div class="usage-tips">
          <p class="tips-title">使用提示</p>
          <ul>
            <li>支持支付宝、天天基金、京东金融等平台截图</li>
            <li>没有代码的截图可通过名称自动匹配</li>
            <li>已持有的基金可直接加仓</li>
            <li>识别后可手动修改金额</li>
          </ul>
        </div>
      </div>

      <!-- 识别中 -->
      <div v-if="step === 'recognizing'" class="recognizing-step">
        <div class="progress-section">
          <van-progress :percentage="ocrProgress" stroke-width="8" />
          <p class="progress-text">{{ ocrStatus }}</p>
        </div>
        <div class="preview-image">
          <div class="preview-image-inner">
            <img :src="selectedImage" alt="截图预览" />
          </div>
        </div>
      </div>

      <!-- 预览确认 -->
      <div v-if="step === 'preview'" class="preview-step">
        <div class="preview-header">
          <span>识别到 {{ enhancedHoldings.length }} 条记录</span>
          <van-button class="action-btn ghost-btn" size="small" plain @click="toggleSelectAll">
            {{ selectedCount === allSelectableCount ? '取消全选' : '全选' }}
          </van-button>
        </div>
        
        <div class="holdings-list">
          <div 
            v-for="(holding, index) in enhancedHoldings" 
            :key="index"
            class="holding-item-wrapper"
          >
            <div 
              class="holding-item"
              :class="{ 
                selected: holding.selected, 
                'needs-match': holding.needsCodeMatch && !holding.code,
                'is-add-position': holding.isAddPosition 
              }"
              @click="toggleSelect(index)"
            >
              <div class="item-checkbox">
                <van-checkbox 
                  :model-value="holding.selected" 
                  :disabled="!holding.code"
                  @click.stop
                  @update:model-value="holding.selected = $event"
                />
              </div>
              <div class="item-content">
                <div class="item-name">
                  <span class="fund-name">{{ holding.name || holding.fundInfo?.name || '未知基金' }}</span>
                  <span v-if="holding.code" class="fund-code">{{ holding.code }}</span>
                  <van-loading v-if="holding.loading || holding.searching" size="12" />
                </div>
                <div class="item-info">
                  <!-- [NEW] 加仓标签 -->
                  <span v-if="holding.isAddPosition" class="tag-add-position">加仓</span>
                  <span v-if="holding.code" class="tag-match-success">匹配成功</span>
                  <span v-else class="tag-needs-match">匹配失败</span>
                  <button class="edit-match-btn" type="button" @click.stop="toggleSearchPanel(index)">
                    <van-icon name="edit" />
                  </button>
                  <span class="confidence" :style="{ color: getConfidenceColor(holding.confidence) }">
                    置信度 {{ Math.round(holding.confidence * 100) }}%
                  </span>
                </div>
                <div class="item-meta">
                  <span v-if="typeof holding.holdingProfit === 'number'">持仓收益 {{ formatAmount(holding.holdingProfit) }} 元</span>
                  <span v-if="typeof holding.holdingProfitRate === 'number'"> / 收益率 {{ holding.holdingProfitRate.toFixed(2) }}%</span>
                  <span v-if="holding.importNetValue"> / 导入净值 {{ holding.importNetValue.toFixed(4) }}（{{ holding.importNavDate || '-' }}）</span>
                </div>
              </div>
              <div class="item-amount">
                <input 
                  type="number" 
                  :value="holding.amount"
                  class="amount-input"
                  @click.stop
                  @input="updateAmount(index, ($event.target as HTMLInputElement).value)"
                />
                <span class="amount-unit">元</span>
              </div>
            </div>
            
            <!-- [NEW] 搜索面板 -->
            <div v-if="holding.showSearch" class="search-panel" @click.stop>
              <div class="search-input-wrapper">
                <input 
                  type="text"
                  class="search-input"
                  :value="holding.searchKeyword ?? holding.name"
                  placeholder="输入基金名称或代码搜索"
                  @input="manualSearch(index, ($event.target as HTMLInputElement).value)"
                />
                <van-icon name="cross" class="close-search" @click="holding.showSearch = false" />
              </div>
              <div class="search-results">
                <div v-if="holding.searching" class="search-loading">
                  <van-loading size="20" />
                  <span>搜索中...</span>
                </div>
                <div v-else-if="!holding.searchResults?.length" class="search-empty">
                  未找到匹配的基金
                </div>
                <div 
                  v-else
                  v-for="result in holding.searchResults" 
                  :key="result.code"
                  class="search-result-item"
                  @click="selectSearchResult(index, result)"
                >
                  <span class="result-name">{{ result.name }}</span>
                  <span class="result-code">{{ result.code }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <div class="preview-footer">
          <van-button class="action-btn ghost-btn" plain @click="reselectImage">重新选择</van-button>
          <van-button class="action-btn primary-btn" type="primary" :disabled="selectedCount === 0" @click="confirmImport">
            {{ addPositionCount > 0 ? `导入 ${selectedCount - addPositionCount} / 加仓 ${addPositionCount}` : `导入 ${selectedCount} 只基金` }}
          </van-button>
        </div>
      </div>

      <!-- 导入中 -->
      <div v-if="step === 'importing'" class="importing-step">
        <van-loading size="48" />
        <p>正在导入...</p>
      </div>
    </div>
  </component>
</template>

<style scoped>
.import-embedded-shell {
  height: 100%;
}

.import-dialog {
  height: min(86vh, 760px);
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-radius: 16px;
  overflow: hidden;
}

.import-dialog.embedded {
  height: 100%;
  min-height: 0;
  border-radius: 0;
  border: none;
  box-shadow: none;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid var(--border-color);
}

/* 上传步骤 */
.upload-step {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 24px 16px;
}

.upload-tip {
  text-align: center;
  padding: 32px 0;
}

.tip-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 16px 0 8px;
}

.tip-desc {
  font-size: 14px;
  color: var(--text-secondary);
}

.upload-actions {
  display: flex;
  gap: 16px;
  padding: 16px;
}

.upload-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px;
  background: var(--bg-primary);
  border: 2px dashed var(--border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.upload-btn:active {
  border-color: var(--color-primary);
  background: var(--color-primary-bg);
}

.upload-btn input {
  display: none;
}

.upload-btn span {
  font-size: 14px;
  color: var(--text-primary);
}

.usage-tips {
  margin-top: auto;
  padding: 16px;
  background: var(--bg-primary);
  border-radius: 12px;
}

.tips-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.usage-tips ul {
  margin: 0;
  padding-left: 20px;
}

.usage-tips li {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.8;
}

/* 识别中 */
.recognizing-step {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 16px;
}

.preview-image {
  flex: 1;
  overflow: auto;
  border-radius: 12px;
  background: var(--bg-primary);
  padding: 8px;
}

.preview-image-inner {
  min-height: 100%;
  width: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.preview-image img {
  width: 100%;
  height: auto;
  max-width: 100%;
  object-fit: contain;
  border-radius: 8px;
}

.progress-section {
  padding: 24px 0;
}

.progress-text {
  text-align: center;
  font-size: 14px;
  color: var(--text-secondary);
  margin-top: 12px;
}

/* 预览步骤 */
.preview-step {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.holdings-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px;
}

/* [NEW] 持仓项容器，包含搜索面板 */
.holding-item-wrapper {
  margin-bottom: 8px;
}

.holding-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid transparent;
}

.holding-item.selected {
  background: var(--color-primary-bg);
  border: 1px solid var(--color-primary);
}

/* [NEW] 需要匹配代码的样式 */
.holding-item.needs-match {
  border: 1px dashed var(--color-warning, #faad14);
  background: rgba(250, 173, 20, 0.05);
}

/* [NEW] 加仓样式 */
.holding-item.is-add-position {
  border: 1px solid var(--color-success, #52c41a);
  background: rgba(82, 196, 26, 0.05);
}

.item-checkbox {
  flex-shrink: 0;
}

.item-content {
  flex: 1;
  min-width: 0;
}

.item-name {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fund-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fund-code {
  font-size: 12px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.item-info {
  margin-top: 4px;
}

.item-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.confidence {
  font-size: 12px;
}

.tag-exists {
  font-size: 11px;
  padding: 2px 6px;
  background: var(--color-warning-bg, #fffbe6);
  color: var(--color-warning, #faad14);
  border-radius: 4px;
}

/* [NEW] 加仓标签 */
.tag-add-position {
  font-size: 11px;
  padding: 2px 6px;
  background: rgba(82, 196, 26, 0.1);
  color: var(--color-success, #52c41a);
  border-radius: 4px;
}

/* [NEW] 需要匹配标签 */
.tag-needs-match {
  font-size: 11px;
  padding: 2px 6px;
  background: rgba(250, 173, 20, 0.1);
  color: var(--color-warning, #faad14);
  border-radius: 4px;
  cursor: pointer;
}

.tag-match-success {
  font-size: 11px;
  padding: 2px 6px;
  background: rgba(82, 196, 26, 0.1);
  color: var(--color-success, #52c41a);
  border-radius: 4px;
}

.edit-match-btn {
  border: none;
  background: transparent;
  color: var(--color-primary);
  padding: 0;
  margin-left: 4px;
  margin-right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

/* [NEW] 搜索面板样式 */
.search-panel {
  margin-top: 8px;
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.search-input-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.search-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 14px;
}

.search-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.close-search {
  color: var(--text-secondary);
  font-size: 18px;
  cursor: pointer;
}

.search-results {
  max-height: 200px;
  overflow-y: auto;
}

.search-loading,
.search-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: var(--text-secondary);
  font-size: 13px;
}

.search-result-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s;
}

.search-result-item:hover,
.search-result-item:active {
  background: var(--color-primary-bg);
}

.result-name {
  font-size: 14px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.result-code {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: 8px;
  flex-shrink: 0;
}

.item-amount {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.amount-input {
  width: 80px;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 14px;
  text-align: right;
}

.amount-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.amount-unit {
  font-size: 12px;
  color: var(--text-secondary);
}

.preview-footer {
  display: flex;
  gap: 12px;
  padding: 16px;
  border-top: 1px solid var(--border-color);
}

.preview-footer .van-button {
  flex: 1;
}

.action-btn {
  border-radius: 10px;
  font-weight: 500;
}

:global([data-theme="dark"] .import-dialog .ghost-btn.van-button),
:global(:root:not([data-theme="light"]) .import-dialog .ghost-btn.van-button) {
  background: #161B22 !important;
  color: var(--text-primary) !important;
  border-color: var(--border-color) !important;
}

:global([data-theme="dark"] .import-dialog .primary-btn.van-button),
:global(:root:not([data-theme="light"]) .import-dialog .primary-btn.van-button) {
  background: var(--color-primary) !important;
  border-color: var(--color-primary) !important;
  color: #fff !important;
}

/* 导入中 */
.importing-step {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--text-secondary);
}
</style>
