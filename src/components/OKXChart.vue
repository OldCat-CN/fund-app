<script setup lang="ts">
// [WHY] 专业交易所风格图表组件
// [WHAT] 深色主题、实时K线图、成交量柱状图、时间周期选择
// [HOW] Canvas绘制，requestAnimationFrame实现流畅实时动画

import { ref, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'
import { fetchSimpleKLineData, clearFundCache, type SimpleKLineData } from '@/api/fundFast'
import { useThemeStore } from '@/stores/theme'
import { isTradingTime } from '@/api/tiantianApi'

const props = defineProps<{
  fundCode: string
  realtimeValue: number
  realtimeChange: number
  lastClose: number
  establishDate?: string
}>()

const themeStore = useThemeStore()

// [WHY] 根据主题获取颜色
function getThemeColors() {
  const isDark = themeStore.actualTheme === 'dark'
  return {
    bgPrimary: isDark ? '#0b0e11' : '#ffffff',
    bgSecondary: isDark ? '#1e2329' : '#f5f5f5',
    textPrimary: isDark ? '#eaecef' : '#1a1a1a',
    textSecondary: isDark ? '#848e9c' : '#666666',
    borderColor: isDark ? '#2b3139' : '#e0e0e0',
    gridColor: isDark ? '#1e2329' : '#f0f0f0',
    upColor: '#f6465d',
    downColor: '#0ecb81',
  }
}

// ========== 状态 ==========
const chartData = ref<SimpleKLineData[]>([])
const isLoading = ref(false)
const activePeriod = ref<PeriodKey>('1w')
const canvasRef = ref<HTMLCanvasElement | null>(null)
const chartMode = ref<'net' | 'change'>('change')
const hoveredIndex = ref<number | null>(null)

// [WHAT] 分时数据
interface IntradayPoint {
  time: string
  value: number
  volume: number // 模拟成交量
}
const intradayData = ref<IntradayPoint[]>([])
const baseValue = ref(0)

type PeriodKey = '1d' | '1w' | '1m' | '3m' | '6m' | '1y' | '3y' | '5y' | 'all'
interface PeriodOption {
  key: PeriodKey
  label: string
  minDays: number
}

// [WHAT] 时间周期配置（适配基金每日净值数据）
const allPeriodOptions: PeriodOption[] = [
  { key: '1w', label: '近1周', minDays: 7 },
  { key: '1m', label: '近1月', minDays: 30 },
  { key: '3m', label: '近3月', minDays: 90 },
  { key: '6m', label: '近6月', minDays: 180 },
  { key: '1y', label: '近1年', minDays: 365 },
  { key: '3y', label: '近3年', minDays: 365 * 3 },
  { key: '5y', label: '近5年', minDays: 365 * 5 },
  { key: 'all', label: '成立来', minDays: 0 },
]

function getTargetDateFromPeriod(endDate: Date, key: PeriodKey): Date {
  const target = new Date(endDate)
  if (key === 'all') {
    return target
  }
  if (key === '1w') {
    target.setDate(target.getDate() - 7)
  } else if (key === '1m') {
    target.setMonth(target.getMonth() - 1)
  } else if (key === '3m') {
    target.setMonth(target.getMonth() - 3)
  } else if (key === '6m') {
    target.setMonth(target.getMonth() - 6)
  } else if (key === '1y') {
    target.setFullYear(target.getFullYear() - 1)
  } else if (key === '3y') {
    target.setFullYear(target.getFullYear() - 3)
  } else if (key === '5y') {
    target.setFullYear(target.getFullYear() - 5)
  }
  return target
}

// [WHAT] 判断是否是当日分时模式
const isIntradayMode = computed(() => activePeriod.value === '1d')

// [WHAT] 只有当日模式且有实时数据时才显示分时图样式
// [WHY] 当日模式显示昨日数据 + 今日估值
const showIntradayChart = computed(() => isIntradayMode.value)

const showChangeMode = computed(() => chartMode.value === 'change')

const availablePeriods = computed<PeriodOption[]>(() => {
  if (chartData.value.length === 0) {
    return allPeriodOptions.filter(i => i.key === '1w' || i.key === 'all')
  }
  const sortedData = [...chartData.value].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
  const earliestByData = new Date(sortedData[0]!.time)
  const endDate = new Date(sortedData[sortedData.length - 1]!.time)
  const estDateRaw = props.establishDate ? new Date(props.establishDate) : null
  const startDate = estDateRaw && !Number.isNaN(estDateRaw.getTime()) ? estDateRaw : earliestByData
  const spanDays = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
  return allPeriodOptions.filter(item => item.minDays === 0 || spanDays >= item.minDays)
})

// [WHAT] 过滤数据
const filteredData = computed(() => {
  const currentPeriod = activePeriod.value // [WHY] 显式依赖，确保响应式
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  
  // [WHAT] 当日分时数据源不可用，统一按日线周期绘制
  if (showIntradayChart.value) {
    if (intradayData.value.length > 0) {
      const first = intradayData.value[0]!.value
      return intradayData.value.map((p, i) => {
        const base = first || p.value || 1
        const change = ((p.value - base) / base) * 100
        return {
          time: p.time,
          value: p.value,
          change: Number(change.toFixed(2)),
          volume: p.volume || (80 + i)
        }
      })
    }

    const fallbackValue = props.realtimeValue || props.lastClose || 1
    return [{
      time: `${today} 15:00:00`,
      value: fallbackValue,
      change: 0,
      volume: 60
    }]
  }
  
  // [WHY] 其他情况统一使用确认净值数据绘制
  const period = availablePeriods.value.find(p => p.key === currentPeriod)

  const sortedData = [...chartData.value]
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
    .map((item, i) => ({ 
      ...item, 
      volume: 50 + Math.abs(item.change) * 30 + (i % 5) * 10
    }))

  if (sortedData.length === 0) return []

  // [WHAT] 与核心指标一致：终点取最新确认净值日，起点按周期回溯并取前一交易日
  const endRecord = sortedData[sortedData.length - 1]!
  const endDate = new Date(endRecord.time)
  const periodKey = (period?.key || '1w') as PeriodKey
  let data = sortedData

  if (periodKey !== 'all') {
    const targetDate = getTargetDateFromPeriod(endDate, periodKey)
    const targetMs = targetDate.getTime()

    let startIndex = 0
    for (let i = sortedData.length - 1; i >= 0; i--) {
      const t = new Date(sortedData[i]!.time).getTime()
      if (!Number.isNaN(t) && t <= targetMs) {
        startIndex = i
        break
      }
    }
    data = sortedData.slice(startIndex)
  }

  // [WHAT] 在确认净值区间末尾补一个今天的估值预测点，起点保持不变
  if (props.realtimeValue > 0 && data.length > 0) {
    const last = data[data.length - 1]!
    if (last.time === today) {
      data = [...data.slice(0, -1), {
        ...last,
        value: props.realtimeValue,
        change: props.realtimeChange
      }]
    } else {
      data = [...data, {
        time: today,
        value: props.realtimeValue,
        change: props.realtimeChange,
        volume: 50 + Math.abs(props.realtimeChange) * 30
      }]
    }
  }

  return data
})

// [WHAT] 当前涨跌
const currentChange = computed(() => {
  if (isIntradayMode.value && baseValue.value > 0 && props.realtimeValue > 0) {
    return ((props.realtimeValue - baseValue.value) / baseValue.value) * 100
  }
  return props.realtimeChange || 0
})

// [WHAT] 统计数据
const stats = computed(() => {
  const data = filteredData.value
  if (data.length === 0) return { open: 0, high: 0, low: 0, close: 0 }
  const values = data.map(d => d.value)
  return {
    open: data[0]?.value || 0,
    high: Math.max(...values),
    low: Math.min(...values),
    close: data[data.length - 1]?.value || 0
  }
})

// ========== 分时数据 ==========
function addIntradayPoint(value: number) {
  if (!value || value <= 0) return
  
  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const clockStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
  const timeStr = `${dateStr} ${clockStr}`
  
  if (baseValue.value === 0) {
    baseValue.value = props.lastClose || value
  }
  
  // 模拟成交量（基于价格变化）
  const lastValue = intradayData.value.length > 0 ? intradayData.value[intradayData.value.length - 1]!.value : value
  const priceChange = Math.abs(value - lastValue)
  const volume = 100 + priceChange * 10000 + Math.random() * 50
  
  const maxPoints = 500
  if (intradayData.value.length >= maxPoints) {
    intradayData.value = intradayData.value.slice(-maxPoints + 1)
  }
  
  intradayData.value.push({ time: timeStr, value, volume })
}

function resetIntradayData() {
  intradayData.value = []
  baseValue.value = props.lastClose || 0
}

// ========== 数据加载 ==========
async function loadData() {
  if (!props.fundCode) return
  
  isLoading.value = true
  try {
    clearFundCache(props.fundCode)
    
    const kline = await fetchSimpleKLineData(props.fundCode, 5000)
    
    chartData.value = kline
    
    
    await nextTick()
    drawChart()
  } catch (err) {
    console.error('加载图表数据失败:', err)
  } finally {
    isLoading.value = false
  }
}

function getChartPadding() {
  // [WHY] 右侧预留空间，避免最右点标签被裁剪
  return { top: 15, right: 72, bottom: 25, left: 58 }
}

function updateHoverByClientX(clientX: number) {
  const canvas = canvasRef.value
  const data = filteredData.value
  if (!canvas || data.length === 0) return

  const rect = canvas.getBoundingClientRect()
  const padding = getChartPadding()
  const chartWidth = rect.width - padding.left - padding.right
  if (chartWidth <= 0) return

  const relativeX = clientX - rect.left
  const clampedX = Math.max(padding.left, Math.min(rect.width - padding.right, relativeX))
  const ratio = (clampedX - padding.left) / chartWidth
  const idx = Math.round(ratio * Math.max(data.length - 1, 1))
  hoveredIndex.value = Math.max(0, Math.min(data.length - 1, idx))
}

function handleMouseMove(event: MouseEvent) {
  updateHoverByClientX(event.clientX)
}

function handleTouchMove(event: TouchEvent) {
  const touch = event.touches[0]
  if (!touch) return
  updateHoverByClientX(touch.clientX)
}

function clearHover() {
  hoveredIndex.value = null
}

function formatHoverTimeLabel(time: string): string {
  if (!time) return '--'
  if (isIntradayMode.value && time.includes(' ')) {
    return (time.split(' ')[1] || '--').slice(0, 8)
  }
  const datePart = time.split(' ')[0] || time
  const parts = datePart.split('-')
  if (parts.length >= 3) return `${parts[0]}-${parts[1]}-${parts[2]}`
  return datePart
}

function toggleChartMode() {
  chartMode.value = chartMode.value === 'net' ? 'change' : 'net'
  nextTick(drawChart)
}


// ========== Canvas绘图（专业风格） ==========
function drawChart() {
  const canvas = canvasRef.value
  if (!canvas) {
    setTimeout(drawChart, 50)
    return
  }
  
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  
  const data = filteredData.value
  if (data.length === 0) return
  
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  
  if (rect.width === 0 || rect.height === 0) {
    setTimeout(drawChart, 50)
    return
  }
  
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)
  
  const width = rect.width
  const height = rect.height
  
  // [WHAT] 布局：分时图占满高度，K线图有成交量区
  let mainHeight: number
  let volumeHeight: number
  let volumeTop: number
  
  // [WHY] 曲线图布局：图表占满高度，不显示成交量
  mainHeight = height - 25 // 留出底部X轴空间
  volumeHeight = 0
  volumeTop = height
  
  const padding = getChartPadding()
  const chartWidth = width - padding.left - padding.right
  
  // [WHY] 获取当前主题颜色
  const colors = getThemeColors()
  
  // 清除画布
  ctx.fillStyle = colors.bgPrimary
  ctx.fillRect(0, 0, width, height)
  
  const baseForChange = data[0]?.value || props.lastClose || 1
  const displayValues = data.map(d => {
    if (!showChangeMode.value) return d.value
    if (!baseForChange) return 0
    return ((d.value - baseForChange) / baseForChange) * 100
  })

  // 计算价格范围
  let minValue = Math.min(...displayValues)
  let maxValue = Math.max(...displayValues)
  
  // [WHY] 价格范围增加边距，让曲线不贴边
  const margin = (maxValue - minValue) * 0.1 || 0.01
  minValue -= margin
  maxValue += margin
  
  const valueRange = maxValue - minValue || 1
  
  // 成交量范围
  const volumes = data.map(d => (d as any).volume || 0)
  const maxVolume = Math.max(...volumes, 1)
  
  // ========== 绘制网格线 ==========
  ctx.strokeStyle = colors.gridColor
  ctx.lineWidth = 1
  
  // 水平网格线（主图区）
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (mainHeight - padding.top) * i / 4
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(width - padding.right, y)
    ctx.stroke()
  }
  
  // ========== 绘制Y轴刻度（左侧） ==========
  ctx.fillStyle = colors.textSecondary
  ctx.font = '10px Arial'
  ctx.textAlign = 'right'
  
  for (let i = 0; i <= 4; i++) {
    const value = maxValue - valueRange * i / 4
    const y = padding.top + (mainHeight - padding.top) * i / 4
    const label = showChangeMode.value
      ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
      : value.toFixed(4)
    ctx.fillText(label, padding.left - 6, y + 3)
  }
  
  // ========== 绘制价格线/K线 ==========
  const isUp = currentChange.value >= 0
  // [WHY] 国内股市/基金习惯：红涨绿跌
  const upColor = colors.upColor
  const downColor = colors.downColor
  const lineColor = isUp ? upColor : downColor
  
  // [WHY] 计算整体涨跌
  const chartBottom = mainHeight
  const firstValue = displayValues[0] ?? 0
  const lastValue = displayValues[displayValues.length - 1] ?? 0
  const isOverallUp = lastValue >= firstValue
  
  // [WHAT] 获取今日日期
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  
  // ========== 当日模式特殊处理 ==========
  // [WHY] 非交易时间显示完整曲线，交易时间无数据时显示"等待开盘"
  const isTrading = isTradingTime()
  const hasRealtimeData = props.realtimeValue > 0
  const showWaitingState = isIntradayMode.value && isTrading && !hasRealtimeData
  
  if (isIntradayMode.value && data.length > 0 && showWaitingState) {
    // [WHAT] 交易时间但无实时数据：显示历史曲线 + 等待开盘
    ctx.beginPath()
    ctx.setLineDash([4, 4])
    data.forEach((point, i) => {
      const displayValue = displayValues[i] ?? 0
      const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * i
      const y = padding.top + (mainHeight - padding.top) * (1 - (displayValue - minValue) / valueRange)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = colors.textSecondary
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.setLineDash([])
    
    // [WHAT] 绘制历史数据点
    data.forEach((point, i) => {
      const displayValue = displayValues[i] ?? 0
      const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * i
      const y = padding.top + (mainHeight - padding.top) * (1 - (displayValue - minValue) / valueRange)
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fillStyle = colors.textSecondary
      ctx.fill()
    })
    
    // [WHAT] 在最后一个点右侧显示"等待开盘"
    const lastPoint = data[data.length - 1]!
    const lastX = padding.left + chartWidth
    const lastDisplayValue = displayValues[data.length - 1] ?? 0
    const lastY = padding.top + (mainHeight - padding.top) * (1 - (lastDisplayValue - minValue) / valueRange)
    
    // 绘制虚线延伸到右侧
    ctx.beginPath()
    ctx.setLineDash([4, 4])
    const prevX = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * (data.length - 1)
    const prevY = lastY
    ctx.moveTo(prevX, prevY)
    ctx.lineTo(lastX, lastY)
    ctx.strokeStyle = colors.textSecondary
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
    
    // 显示"等待开盘"文字
    ctx.fillStyle = colors.textSecondary
    ctx.font = '12px Arial'
    ctx.textAlign = 'center'
    ctx.fillText('等待开盘', lastX - 40, lastY - 10)
    
    // 绘制闪烁的等待点
    const pulseSize = 3 + Math.sin(Date.now() / 300) * 1.5
    ctx.beginPath()
    ctx.arc(lastX, lastY, pulseSize, 0, Math.PI * 2)
    ctx.fillStyle = colors.textSecondary
    ctx.globalAlpha = 0.5 + Math.sin(Date.now() / 300) * 0.3
    ctx.fill()
    ctx.globalAlpha = 1
  } else {
    // ========== 其他模式：标准曲线图 ==========
    
    // [WHAT] 绘制填充区域
    ctx.beginPath()
    ctx.moveTo(padding.left, chartBottom)
    
    const fillPoints: { x: number, y: number }[] = data.map((point, i) => ({
      x: padding.left + (chartWidth / Math.max(data.length - 1, 1)) * i,
      y: padding.top + (mainHeight - padding.top) * (1 - ((displayValues[i] ?? 0) - minValue) / valueRange)
    }))
    
    if (fillPoints.length > 0) {
      ctx.lineTo(fillPoints[0]!.x, fillPoints[0]!.y)
      
      // [WHY] 点数少于3时使用直线，点数足够时使用贝塞尔曲线
      if (fillPoints.length < 3) {
        for (let i = 1; i < fillPoints.length; i++) {
          ctx.lineTo(fillPoints[i]!.x, fillPoints[i]!.y)
        }
      } else {
        // [HOW] Catmull-Rom样条曲线
        for (let i = 0; i < fillPoints.length - 1; i++) {
          const p0 = fillPoints[Math.max(i - 1, 0)]!
          const p1 = fillPoints[i]!
          const p2 = fillPoints[i + 1]!
          const p3 = fillPoints[Math.min(i + 2, fillPoints.length - 1)]!
          
          const tension = 6
          const cp1x = p1.x + (p2.x - p0.x) / tension
          const cp1y = p1.y + (p2.y - p0.y) / tension
          const cp2x = p2.x - (p3.x - p1.x) / tension
          const cp2y = p2.y - (p3.y - p1.y) / tension
          
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
        }
      }
    }
    
    // 闭合路径
    const lastX = padding.left + chartWidth
    ctx.lineTo(lastX, chartBottom)
    ctx.closePath()
    
    // 填充渐变
    const fillGradient = ctx.createLinearGradient(0, padding.top, 0, chartBottom)
    if (isOverallUp) {
      fillGradient.addColorStop(0, 'rgba(246, 70, 93, 0.25)')
      fillGradient.addColorStop(0.5, 'rgba(246, 70, 93, 0.1)')
      fillGradient.addColorStop(1, 'rgba(246, 70, 93, 0)')
    } else {
      fillGradient.addColorStop(0, 'rgba(14, 203, 129, 0.25)')
      fillGradient.addColorStop(0.5, 'rgba(14, 203, 129, 0.1)')
      fillGradient.addColorStop(1, 'rgba(14, 203, 129, 0)')
    }
    ctx.fillStyle = fillGradient
    ctx.fill()
    
    // [WHAT] 绘制平滑走势曲线
    ctx.beginPath()
    const points: { x: number, y: number }[] = data.map((point, i) => ({
      x: padding.left + (chartWidth / Math.max(data.length - 1, 1)) * i,
      y: padding.top + (mainHeight - padding.top) * (1 - ((displayValues[i] ?? 0) - minValue) / valueRange)
    }))
    
    if (points.length > 0) {
      ctx.moveTo(points[0]!.x, points[0]!.y)
      
      // [WHY] 点数少于3时使用直线，点数足够时使用贝塞尔曲线
      if (points.length < 3) {
        // 直线连接
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i]!.x, points[i]!.y)
        }
      } else {
        // [HOW] 使用Catmull-Rom样条曲线，自动生成平滑控制点
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[Math.max(i - 1, 0)]!
          const p1 = points[i]!
          const p2 = points[i + 1]!
          const p3 = points[Math.min(i + 2, points.length - 1)]!
          
          // [WHAT] Catmull-Rom to Bezier转换，生成平滑曲线
          const tension = 6 // 张力系数
          const cp1x = p1.x + (p2.x - p0.x) / tension
          const cp1y = p1.y + (p2.y - p0.y) / tension
          const cp2x = p2.x - (p3.x - p1.x) / tension
          const cp2y = p2.y - (p3.y - p1.y) / tension
          
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
        }
      }
    }
    ctx.strokeStyle = isOverallUp ? upColor : downColor
    ctx.lineWidth = 2
    ctx.stroke()
    
    // 绘制最新点动画 + 精确数值标注
    if (data.length > 0) {
      const lastPoint = data[data.length - 1]!
      const lastPointX = padding.left + chartWidth
      const lastDisplayValue = displayValues[displayValues.length - 1] ?? 0
      const lastPointY = padding.top + (mainHeight - padding.top) * (1 - (lastDisplayValue - minValue) / valueRange)
      
      // [WHAT] 绘制脉冲动画点
      const pulseSize = 3 + Math.sin(Date.now() / 200) * 1.5
      ctx.beginPath()
      ctx.arc(lastPointX, lastPointY, pulseSize, 0, Math.PI * 2)
      ctx.fillStyle = isOverallUp ? upColor : downColor
      ctx.fill()
      
      ctx.beginPath()
      ctx.arc(lastPointX, lastPointY, pulseSize + 3, 0, Math.PI * 2)
      ctx.strokeStyle = isOverallUp ? upColor : downColor
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.4
      ctx.stroke()
      ctx.globalAlpha = 1
      
      // [WHAT] 在最新点旁边显示精确数值（带背景框避免与Y轴刻度重叠）
      const priceText = showChangeMode.value
        ? `${lastDisplayValue >= 0 ? '+' : ''}${lastDisplayValue.toFixed(2)}%`
        : lastPoint.value.toFixed(4)
      ctx.font = 'bold 11px Arial'
      
      // [WHY] 根据点位置决定标签显示在上方还是下方，并加背景框
      const labelY = lastPointY < mainHeight / 2 ? lastPointY + 18 : lastPointY - 8
      const labelX = lastPointX + 5
      
      // [WHAT] 测量文本宽度，绘制背景框
      const textMetrics = ctx.measureText(priceText)
      const textWidth = textMetrics.width
      const textHeight = 14
      const bgPadding = 3
      
      // [WHY] 绘制背景框，避免与右侧Y轴刻度重叠
      ctx.fillStyle = isOverallUp ? 'rgba(246, 70, 93, 0.9)' : 'rgba(14, 203, 129, 0.9)'
      ctx.beginPath()
      ctx.roundRect(
        labelX - bgPadding, 
        labelY - textHeight + 2, 
        textWidth + bgPadding * 2, 
        textHeight + bgPadding,
        3
      )
      ctx.fill()
      
      // [WHAT] 绘制白色文字
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'left'
      ctx.fillText(priceText, labelX, labelY)
    }
  }

  // ========== 触摸/鼠标十字线 ==========
  if (hoveredIndex.value !== null && data[hoveredIndex.value]) {
    const idx = hoveredIndex.value
    const point = data[idx]!
    const displayValue = displayValues[idx] ?? 0
    const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * idx
    const y = padding.top + (mainHeight - padding.top) * (1 - (displayValue - minValue) / valueRange)

    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = colors.textSecondary
    ctx.lineWidth = 1

    ctx.beginPath()
    ctx.moveTo(x, padding.top)
    ctx.lineTo(x, mainHeight)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(width - padding.right, y)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.beginPath()
    ctx.arc(x, y, 3.5, 0, Math.PI * 2)
    ctx.fillStyle = currentChange.value >= 0 ? upColor : downColor
    ctx.fill()

    const valueText = showChangeMode.value
      ? `${displayValue >= 0 ? '+' : ''}${displayValue.toFixed(2)}%`
      : point.value.toFixed(4)
    const timeText = formatHoverTimeLabel(point.time)
    const tooltipText = `${timeText}  ${valueText}`

    ctx.font = '11px Arial'
    const textWidth = ctx.measureText(tooltipText).width
    const boxWidth = textWidth + 12
    const boxHeight = 20
    const boxX = Math.min(Math.max(8, x - boxWidth / 2), width - boxWidth - 8)
    const boxY = 6

    ctx.fillStyle = themeStore.actualTheme === 'dark'
      ? 'rgba(22, 27, 34, 0.92)'
      : 'rgba(31, 35, 40, 0.86)'
    ctx.beginPath()
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'left'
    ctx.fillText(tooltipText, boxX + 6, boxY + 13.5)
    ctx.restore()
  }
  
  // ========== 绘制X轴时间标签 ==========
  ctx.fillStyle = colors.textSecondary
  ctx.font = '10px Arial'
  ctx.textAlign = 'center'
  
  // [WHY] 移动端减少标签数量避免重叠，根据屏幕宽度动态调整
  const maxLabels = width < 350 ? 3 : (width < 450 ? 4 : 5)
  const labelCount = Math.min(maxLabels, data.length)
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.floor((data.length - 1) * i / Math.max(labelCount - 1, 1))
    const point = data[idx]
    if (!point) continue
    const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * idx
    
    // [WHAT] 显示时间标签
    // [WHY] 当日分时模式只显示时间（如 09:30），避免与日期重叠
    let label: string
    if (isIntradayMode.value && point.time.includes(' ')) {
      // 分时模式：只显示时间部分
      label = point.time.split(' ')[1] || point.time.slice(-5)
    } else {
      // K线模式：显示完整日期 YYYY-MM-DD
      const parts = point.time.split('-')
      label = parts.length >= 3
        ? `${parts[0]}-${parts[1]}-${parts[2].split(' ')[0]}`
        : point.time.slice(0, 10)
    }
    ctx.fillText(label, x, height - 5)
  }
  
  // [WHAT] 当日模式：显示数据日期提示
  if (isIntradayMode.value && data.length > 0) {
    // 获取数据的实际日期
    const firstPoint = data[0]!
    const dateStr = firstPoint.time.split(' ')[0] || firstPoint.time
    const dateParts = dateStr.split('-')
    const displayDate = dateParts.length >= 3
      ? `${dateParts[0]}-${dateParts[1]}-${dateParts[2]}`
      : dateStr
    
    // [WHY] 如果数据日期不是今天，显示提示
    if (!dateStr.includes(todayStr)) {
      ctx.font = '11px Arial'
      ctx.textAlign = 'left'
      ctx.fillStyle = colors.textSecondary
      ctx.fillText(`最新交易日: ${displayDate}`, padding.left, padding.top - 3)
    }
  }
}

// ========== 事件处理 ==========
function selectPeriod(key: PeriodKey) {
  // [WHY] 先停止动画，避免旧数据干扰
  stopAnimation()
  hoveredIndex.value = null
  
  // [WHY] 当日模式重置分时数据并添加当前点
  if (key === '1d') {
    resetIntradayData()
    // 确保添加至少一个数据点
    const val = props.realtimeValue || props.lastClose || 1
    if (val > 0) {
      addIntradayPoint(val)
    }
  }
  
  // [WHY] 更新周期
  activePeriod.value = key
  
  // [WHY] 使用 nextTick 确保 Vue 响应式更新完成后再绘图
  nextTick(() => {
    drawChart()
    startAnimation()
  })
}

// ========== 动画 ==========
let animationFrame: number | null = null

function startAnimation() {
  if (animationFrame) return
  
  let lastTime = 0
  function animate(time: number) {
    // [WHY] 所有模式都持续动画，实现K线实时走动
    if (time - lastTime > 33) { // 约30fps
      lastTime = time
      drawChart()
    }
    animationFrame = requestAnimationFrame(animate)
  }
  
  animationFrame = requestAnimationFrame(animate)
}

function stopAnimation() {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
    animationFrame = null
  }
}

// ========== 生命周期 ==========
watch(() => props.fundCode, () => {
  resetIntradayData()
  loadData()
}, { immediate: true })

watch(() => props.realtimeValue, (newVal) => {
  if (newVal && newVal > 0) {
    // [WHY] 分时模式累积数据点，K线模式由computed自动更新
    if (isIntradayMode.value) {
      addIntradayPoint(newVal)
    }
    // 动画循环会自动重绘，无需手动调用
  }
})

watch(() => props.lastClose, (newVal) => {
  if (newVal && newVal > 0 && baseValue.value === 0) {
    baseValue.value = newVal
  }
})

// [WHY] 监控周期变化，强制重绘
watch(activePeriod, () => {
  nextTick(drawChart)
})

watch(availablePeriods, (items) => {
  if (!items.length) return
  if (!items.find(item => item.key === activePeriod.value)) {
    activePeriod.value = items[0]!.key
  }
}, { immediate: true })

watch(chartMode, () => {
  nextTick(drawChart)
})

// [WHY] 监控主题变化，重绘图表
watch(() => themeStore.actualTheme, () => {
  nextTick(drawChart)
})

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (canvasRef.value) {
    resizeObserver = new ResizeObserver(() => drawChart())
    resizeObserver.observe(canvasRef.value.parentElement!)
  }
  
  if (props.realtimeValue > 0) {
    addIntradayPoint(props.realtimeValue)
  }
  
  // [WHY] 所有模式都启用动画，实现实时走动
  setTimeout(startAnimation, 500)
})

onUnmounted(() => {
  stopAnimation()
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="pro-chart">
    <!-- 时间周期选择器 -->
    <div class="period-selector">
      <div class="period-scroll">
        <div
          v-for="p in availablePeriods"
          :key="p.key"
          class="period-btn"
          :class="{ active: activePeriod === p.key }"
          @click.stop="selectPeriod(p.key)"
        >
          {{ p.label }}
        </div>
      </div>
      <div class="period-tools">
        <span class="tool-label">实时</span>
        <span class="live-dot"></span>
        <button
          class="mode-toggle"
          :class="{ active: showChangeMode }"
          @click.stop="toggleChartMode"
        >
          <span class="mode-toggle-label">{{ showChangeMode ? '涨跌幅' : '净值' }}</span>
          <span class="mode-toggle-thumb"></span>
        </button>
      </div>
    </div>

    <!-- OHLC信息栏 -->
    <div class="ohlc-bar">
      <span class="ohlc-item">
        <span class="ohlc-label">开</span>
        <span class="ohlc-value">{{ stats.open.toFixed(4) }}</span>
      </span>
      <span class="ohlc-item">
        <span class="ohlc-label">高</span>
        <span class="ohlc-value up">{{ stats.high.toFixed(4) }}</span>
      </span>
      <span class="ohlc-item">
        <span class="ohlc-label">低</span>
        <span class="ohlc-value down">{{ stats.low.toFixed(4) }}</span>
      </span>
      <span class="ohlc-item">
        <span class="ohlc-label">收</span>
        <span class="ohlc-value" :class="currentChange >= 0 ? 'up' : 'down'">
          {{ realtimeValue > 0 ? realtimeValue.toFixed(4) : stats.close.toFixed(4) }}
        </span>
      </span>
      <span class="ohlc-item">
        <span class="ohlc-label">涨跌</span>
        <span class="ohlc-value" :class="currentChange >= 0 ? 'up' : 'down'">
          {{ currentChange >= 0 ? '+' : '' }}{{ currentChange.toFixed(2) }}%
        </span>
      </span>
    </div>

    <!-- 图表区域 -->
    <div class="chart-container">
      <div v-if="isLoading" class="chart-loading">
        <van-loading size="24px" color="#0ecb81">加载中...</van-loading>
      </div>
      <canvas
        v-else
        ref="canvasRef"
        class="chart-canvas"
        @mousemove="handleMouseMove"
        @mouseleave="clearHover"
        @touchstart.prevent="handleTouchMove"
        @touchmove.prevent="handleTouchMove"
        @touchend="clearHover"
      ></canvas>
    </div>

  </div>
</template>

<style scoped>
/* ========== 移动端适配 + 主题支持 ========== */
/* [WHY] 使用CSS变量实现黑白主题切换 */

.pro-chart {
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  overscroll-behavior: contain;
  transition: background-color 0.3s;
}

/* 时间周期选择器 */
.period-selector {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  gap: 8px;
  border-bottom: 1px solid var(--border-color);
}

.period-scroll {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  -webkit-overflow-scrolling: touch;
}

.period-scroll::-webkit-scrollbar {
  display: none;
}

.period-btn {
  flex: 0 0 auto;
  min-height: 36px;
  min-width: 56px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: transparent;
  border-radius: 6px;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.15s ease;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.period-btn:active {
  transform: scale(0.95);
  opacity: 0.8;
}

.period-btn.active {
  color: var(--color-primary);
  background: var(--color-primary-bg);
  font-weight: 500;
}

.period-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.tool-label {
  font-size: 12px;
  color: var(--color-down);
  padding: 5px 10px;
  background: var(--color-down-bg);
  border-radius: 4px;
}

.live-dot {
  width: 8px;
  height: 8px;
  background: var(--color-down);
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}

.mode-toggle {
  height: 26px;
  min-width: 92px;
  border: 1px solid var(--border-color);
  border-radius: 13px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px;
  cursor: pointer;
}

.mode-toggle-label {
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}

.mode-toggle-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-secondary);
  transition: all 0.2s ease;
}

.mode-toggle.active {
  border-color: var(--color-primary);
  background: var(--color-primary-bg);
}

.mode-toggle.active .mode-toggle-thumb {
  background: var(--color-primary);
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.3); }
}

/* OHLC信息栏 */
.ohlc-bar {
  display: flex;
  gap: 12px;
  padding: 10px 12px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  -webkit-overflow-scrolling: touch;
}

.ohlc-bar::-webkit-scrollbar {
  display: none;
}

.ohlc-item {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}

.ohlc-label {
  color: var(--text-secondary);
}

.ohlc-value {
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  color: var(--text-primary);
  font-weight: 500;
}

/* [WHY] 红涨绿跌 */
.ohlc-value.up { color: var(--color-up); }
.ohlc-value.down { color: var(--color-down); }

/* 图表容器 */
.chart-container {
  position: relative;
  /* [WHY] 使用vw单位适配不同屏幕 */
  height: max(200px, 45vw);
  max-height: 320px;
  /* [WHY] 防止图表区域意外滚动 */
  touch-action: pan-x pan-y;
}

.chart-canvas {
  width: 100%;
  height: 100%;
  /* [WHY] 防止Canvas模糊 */
  image-rendering: -webkit-optimize-contrast;
  touch-action: none;
}

.chart-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

/* ========== 响应式适配 ========== */
@media screen and (max-width: 375px) {
  /* 小屏手机（iPhone SE等） */
  .period-btn {
    padding: 6px 10px;
    font-size: 13px;
    min-width: 40px;
  }
  
  .ohlc-bar {
    gap: 8px;
    font-size: 12px;
  }
  
  .chart-container {
    height: 200px;
  }
  
}

@media screen and (min-width: 414px) {
  /* 大屏手机（iPhone Plus/Max等） */
  .period-btn {
    padding: 10px 16px;
    font-size: 15px;
  }
  
  .chart-container {
    height: 280px;
  }
}

/* [WHY] 安全区域适配（刘海屏、底部横条） */
@supports (padding-bottom: env(safe-area-inset-bottom)) {
  .pro-chart {
    padding-bottom: env(safe-area-inset-bottom);
  }
}
</style>
