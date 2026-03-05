// [WHY] 基金数据状态管理，集中管理自选列表和实时估值
// [WHAT] 使用 Pinia 管理响应式状态，实现数据和 UI 的自动同步
// [DEPS] 依赖 storage 工具持久化数据，依赖 fund API 获取实时数据

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { WatchlistItem, FundEstimate } from '@/types/fund'
import { fetchFundEstimateFast, fetchFundAccurateData, fetchFundBasicInfo } from '@/api/fundFast'
import { getFundNameFromList } from '@/api/fund'
import {
  getWatchlist,
  saveWatchlist,
  addToWatchlist as addToStorage,
  removeFromWatchlist as removeFromStorage,
  isInWatchlist
} from '@/utils/storage'

export const useFundStore = defineStore('fund', () => {
  // ========== State ==========
  
  /** 自选基金列表（包含实时估值） */
  const watchlist = ref<WatchlistItem[]>([])
  
  /** 是否正在刷新 */
  const isRefreshing = ref(false)
  
  /** 上次刷新时间 */
  const lastRefreshTime = ref<string>('')

  // ========== Getters ==========
  
  /** 自选基金代码列表 */
  const watchlistCodes = computed(() => watchlist.value.map((item) => item.code))

  // ========== Actions ==========

  /**
   * 初始化自选列表
   * [WHY] APP 启动时从本地存储恢复数据
   */
  function initWatchlist() {
    const codes = getWatchlist()
    const existing = new Map(watchlist.value.map(item => [item.code, item]))
    watchlist.value = codes.map((code) => {
      const prev = existing.get(code)
      if (prev) return { ...prev }
      return {
        code,
        name: '',
        loading: true
      }
    })
    // [WHAT] 初始化后立即刷新估值
    if (codes.length > 0) {
      refreshEstimates()
    }
  }

  /**
   * 刷新所有自选基金的估值
   * [WHY] 下拉刷新或定时刷新时调用
   * [WHAT] 使用多源数据获取，提高成功率
   */
  async function refreshEstimates() {
    if (watchlist.value.length === 0) {
      isRefreshing.value = false
      return
    }
    
    isRefreshing.value = true
    const codes = watchlist.value.map((item) => item.code)
    
    try {
      // [WHAT] 并发请求所有基金估值
      await Promise.all(
        codes.map(async (code) => {
          const item = watchlist.value.find((f) => f.code === code)
          if (!item) return
          
          let success = false
          
          // [FIX] 优先使用东方财富接口（更稳定），天天基金接口经常超时
          // [WHAT] 尝试方法1：东方财富基本信息接口
          try {
            const basicInfo = await fetchFundBasicInfo(code)
            if (basicInfo && basicInfo.name) {
              updateFundData(code, {
                fundcode: code,
                name: basicInfo.name,
                gsz: String(basicInfo.netValue || 0),
                gszzl: String(basicInfo.changeRate || 0),
                gztime: basicInfo.updateTime || '',
                dwjz: String(basicInfo.netValue || 0)
              })
              success = true
            }
          } catch {
            // 继续尝试备用接口
          }
          
          // [WHAT] 尝试方法2：天天基金快速接口（可能会超时）
          if (!success) {
            try {
              const fastData = await fetchFundEstimateFast(code)
              if (fastData && fastData.name) {
                updateFundData(code, fastData)
                success = true
              }
            } catch {
              // 继续尝试备用接口
            }
          }
          
          // [WHAT] 尝试方法3：多源精准数据
          if (!success) {
            try {
              const accurateData = await fetchFundAccurateData(code)
              if (accurateData && accurateData.name) {
                updateFundData(code, {
                  fundcode: accurateData.code,
                  name: accurateData.name,
                  gsz: String(accurateData.currentValue || 0),
                  gszzl: String(accurateData.dayChange || 0),
                  gztime: accurateData.updateTime || '',
                  dwjz: String(accurateData.nav || 0)
                })
                success = true
              }
            } catch {
              // 所有在线接口都失败
            }
          }
          
          // [FIX] 如果所有接口都失败，从本地列表获取名称
          if (!success) {
            item.loading = false
            if (!item.name) {
              const localName = await getFundNameFromList(code)
              item.name = localName || '暂无数据'
            }
          }
        })
      )
      
      // [FIX] 确保所有基金都标记为加载完成
      watchlist.value.forEach(item => {
        item.loading = false
        if (!item.name) {
          item.name = '暂无数据'
        }
      })
      
      lastRefreshTime.value = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
      })
    } finally {
      isRefreshing.value = false
    }
  }

  /**
   * 刷新单只基金估值
   */
  async function refreshSingleFund(code: string) {
    try {
      const data = await fetchFundEstimateFast(code)
      updateFundData(code, data)
    } catch {
      // 静默失败
    }
  }

  /**
   * 更新单只基金数据
   * [WHAT] 将 API 返回的数据更新到 watchlist 中
   */
  function updateFundData(code: string, data: FundEstimate) {
    const index = watchlist.value.findIndex((item) => item.code === code)
    if (index > -1) {
      const prev = watchlist.value[index]!
      watchlist.value[index] = {
        code: prev.code || data.fundcode || code,
        name: data.name || prev.name || '',
        estimateValue: data.gsz,
        estimateChange: data.gszzl,
        estimateTime: data.gztime,
        lastValue: data.dwjz,
        loading: false
      }
    }
  }

  /**
   * 添加基金到自选
   * [EDGE] 已存在则不重复添加
   */
  async function addFund(code: string, name: string) {
    if (isInWatchlist(code)) return false
    
    // [WHAT] 先添加到列表（显示加载状态），再获取估值
    addToStorage(code)
    watchlist.value.unshift({
      code,
      name,
      loading: true
    })
    
    // 立即获取该基金的估值
    await refreshSingleFund(code)
    return true
  }

  /**
   * 从自选中移除基金
   */
  function removeFund(code: string) {
    removeFromStorage(code)
    const index = watchlist.value.findIndex((item) => item.code === code)
    if (index > -1) {
      watchlist.value.splice(index, 1)
    }
  }

  /**
   * 检查基金是否在自选中
   */
  function isFundInWatchlist(code: string): boolean {
    return watchlistCodes.value.includes(code)
  }

  return {
    // State
    watchlist,
    isRefreshing,
    lastRefreshTime,
    // Getters
    watchlistCodes,
    // Actions
    initWatchlist,
    refreshEstimates,
    refreshSingleFund,
    addFund,
    removeFund,
    isFundInWatchlist
  }
})
