<script setup lang="ts">
// [WHY] 首页 - 展示自选基金列表、市场概览和快捷入口
// [WHAT] 支持下拉刷新、左滑删除、点击跳转搜索添加、设置提醒

import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useFundStore } from '@/stores/fund'
import { useAlertStore, ALERT_TYPE_CONFIG, type AlertType } from '@/stores/alert'
import { 
  fetchRemoteConfig, 
  getActiveAnnouncements, 
  markAnnouncementShown,
  checkNeedUpdate,
  type Announcement
} from '@/api/remote'
import { APP_VERSION } from '@/config/version'
import { Snackbar, Dialog } from '@varlet/ui'
import FundCard from '@/components/FundCard.vue'

const router = useRouter()
const fundStore = useFundStore()
const alertStore = useAlertStore()

// [WHY] 会话级标记，确保远程配置只在首次启动时加载
// [WHAT] 使用模块级变量而非响应式，避免后台切换重复触发
let hasLoadedRemoteConfig = false

// [WHAT] 公告列表（默认 + 远程）
const defaultNotices = [
  '基金投资有风险，入市需谨慎',
  '交易时间：工作日 9:30-15:00'
]
const notices = ref<string[]>([...defaultNotices])

// [WHAT] 远程公告
const remoteAnnouncements = ref<Announcement[]>([])
const showAnnouncementPopup = ref(false)
const currentAnnouncement = ref<Announcement | null>(null)

// [WHAT] 更新状态
const updateInfo = ref<{
  needUpdate: boolean
  forceUpdate: boolean
  latestVersion: string
  updateUrl: string
} | null>(null)

// [WHAT] 页面挂载时初始化数据
onMounted(async () => {
  fundStore.initWatchlist()
  // 请求通知权限
  await alertStore.requestNotificationPermission()
  // 加载远程配置
  loadRemoteConfig()
})

// [WHAT] 加载远程配置（公告和更新检查）
// [WHY] 只在首次启动时加载，后台切换回来不重复加载
async function loadRemoteConfig() {
  // [WHY] 如果已经加载过，直接返回，避免后台切换重复弹窗
  if (hasLoadedRemoteConfig) return
  hasLoadedRemoteConfig = true
  
  try {
    const config = await fetchRemoteConfig()
    if (!config) return
    
    // 检查更新
    const { needUpdate, forceUpdate } = checkNeedUpdate(APP_VERSION, config)
    if (needUpdate) {
      updateInfo.value = {
        needUpdate,
        forceUpdate,
        latestVersion: config.version,
        updateUrl: config.updateUrl
      }
    }
    
    // 获取有效公告
    remoteAnnouncements.value = getActiveAnnouncements(config)
    
    // 将远程公告添加到滚动公告
    if (remoteAnnouncements.value.length > 0) {
      const remoteNoticeTexts = remoteAnnouncements.value.map(a => `【${a.title}】${a.content.split('\n')[0]}`)
      notices.value = [...remoteNoticeTexts, ...defaultNotices]
      
      // [WHY] 首次启动自动弹出第一个公告
      // [WHAT] 延迟 500ms 等待页面渲染完成后再弹出
      setTimeout(() => {
        if (remoteAnnouncements.value.length > 0) {
          currentAnnouncement.value = remoteAnnouncements.value[0]
          showAnnouncementPopup.value = true
        }
      }, 500)
    }
  } catch (err) {
    console.warn('加载远程配置失败:', err)
  }
}

// [WHAT] 打开公告详情
function openAnnouncement(announcement: Announcement) {
  currentAnnouncement.value = announcement
  showAnnouncementPopup.value = true
}

// [WHAT] 关闭公告并标记已读
function closeAnnouncement() {
  if (currentAnnouncement.value) {
    markAnnouncementShown(currentAnnouncement.value.id)
    // 从列表移除
    remoteAnnouncements.value = remoteAnnouncements.value.filter(
      a => a.id !== currentAnnouncement.value?.id
    )
  }
  showAnnouncementPopup.value = false
  currentAnnouncement.value = null
}

// [WHAT] 跳转更新
function goToUpdate() {
  if (updateInfo.value?.updateUrl) {
    window.open(updateInfo.value.updateUrl, '_blank')
  }
}

// [WHAT] 监听数据变化，检查提醒条件
watch(
  () => fundStore.watchlist,
  (watchlist) => {
    for (const fund of watchlist) {
      if (fund.estimateValue && fund.estimateChange) {
        const value = parseFloat(fund.estimateValue)
        const change = parseFloat(fund.estimateChange)
        if (!isNaN(value) && !isNaN(change)) {
          alertStore.checkAlerts(fund.code, value, change)
        }
      }
    }
  },
  { deep: true }
)

// [WHAT] 下拉刷新处理
async function onRefresh() {
  await fundStore.refreshEstimates()
  Snackbar.success('刷新成功')
}

// [WHAT] 删除自选基金
async function handleDelete(code: string) {
  Dialog({
    title: '确认删除',
    message: '确定要从自选中删除该基金吗？',
    onConfirm: () => {
      fundStore.removeFund(code)
      Snackbar.success('已删除')
    }
  })
}

// [WHAT] 跳转到搜索页
function goToSearch() {
  router.push('/search')
}

// [WHAT] 跳转到基金详情页
function goToDetail(code: string) {
  router.push(`/detail/${code}`)
}

// ========== 提醒设置弹窗 ==========
const showAlertDialog = ref(false)
const alertFund = ref<{ code: string; name: string } | null>(null)
const alertForm = ref({
  type: 'change_up' as AlertType,
  threshold: ''
})

const alertTypes = Object.entries(ALERT_TYPE_CONFIG).map(([key, config]) => ({
  value: key,
  label: config.label
}))

// [WHAT] 长按打开提醒设置
function onFundLongPress(code: string, name: string) {
  alertFund.value = { code, name }
  alertForm.value = { type: 'change_up', threshold: '' }
  showAlertDialog.value = true
}

// [WHAT] 提交提醒设置
function submitAlert() {
  if (!alertFund.value) return
  const threshold = parseFloat(alertForm.value.threshold)
  if (isNaN(threshold) || threshold <= 0) {
    Snackbar.warning('请输入有效的阈值')
    return
  }

  alertStore.addAlert({
    code: alertFund.value.code,
    name: alertFund.value.name,
    type: alertForm.value.type,
    threshold,
    enabled: true
  })
  
  Snackbar.success('提醒已设置')
  showAlertDialog.value = false
}
</script>

<template>
  <div class="home-page">
    <!-- 顶部搜索栏 -->
    <div class="top-header">
      <div class="header-left">
        <span class="app-title">基金宝</span>
      </div>
      <div class="search-bar" @click="goToSearch">
        <van-icon name="search" size="16" />
        <span>搜索基金代码/名称</span>
      </div>
    </div>
    
    <!-- 公告栏 -->
    <div class="notice-bar">
      <van-icon name="volume-o" class="notice-icon" />
      <van-swipe 
        class="notice-swipe" 
        vertical 
        :autoplay="3000" 
        :show-indicators="false"
        :touchable="false"
      >
        <van-swipe-item v-for="(notice, idx) in notices" :key="idx">
          {{ notice }}
        </van-swipe-item>
      </van-swipe>
    </div>
    
    <!-- 强制更新遮罩 -->
    <van-overlay :show="updateInfo?.forceUpdate" z-index="9999" class="force-update-overlay">
      <div class="force-update-content">
        <van-icon name="info-o" size="48" color="#ee0a24" />
        <h3>发现新版本 v{{ updateInfo?.latestVersion }}</h3>
        <p>当前版本过低，请更新后继续使用</p>
        <van-button type="danger" block @click="goToUpdate">
          立即更新
        </van-button>
      </div>
    </van-overlay>
    
    <!-- 更新提示卡片（普通更新） -->
    <div v-if="updateInfo?.needUpdate && !updateInfo?.forceUpdate" class="update-card">
      <div class="update-info">
        <van-icon name="upgrade" size="20" color="#1989fa" />
        <span>发现新版本 v{{ updateInfo.latestVersion }}</span>
      </div>
      <van-button size="small" type="primary" plain @click="goToUpdate">
        立即更新
      </van-button>
      <van-icon name="cross" class="close-btn" @click="updateInfo = null" />
    </div>
    
    <!-- 远程公告卡片 -->
    <div v-if="remoteAnnouncements.length > 0" class="announcement-cards">
      <div 
        v-for="announcement in remoteAnnouncements" 
        :key="announcement.id"
        class="announcement-card"
        :class="announcement.type"
        @click="openAnnouncement(announcement)"
      >
        <van-icon 
          :name="announcement.type === 'update' ? 'upgrade' : announcement.type === 'warning' ? 'warning-o' : 'info-o'" 
          size="18"
        />
        <span class="announcement-title">{{ announcement.title }}</span>
        <van-icon name="arrow" size="14" />
      </div>
    </div>

    <!-- 下拉刷新列表 -->
    <van-pull-refresh 
      v-model="fundStore.isRefreshing" 
      @refresh="onRefresh"
      class="fund-list-container"
    >
      <!-- 自选基金标题 -->
      <div class="section-header" v-if="fundStore.watchlist.length > 0">
        <span class="section-title">自选基金</span>
        <span class="fund-count">{{ fundStore.watchlist.length }}只</span>
      </div>
      
      <!-- 有自选基金时显示列表 -->
      <template v-if="fundStore.watchlist.length > 0">
        <!-- 刷新时间提示 -->
        <div v-if="fundStore.lastRefreshTime" class="refresh-time">
          <span>最后刷新: {{ fundStore.lastRefreshTime }}</span>
          <span v-if="alertStore.enabledAlerts.length > 0" class="alert-badge">
            {{ alertStore.enabledAlerts.length }}个提醒
          </span>
        </div>
        
        <!-- 基金列表 -->
        <FundCard
          v-for="fund in fundStore.watchlist"
          :key="fund.code"
          :fund="fund"
          @delete="handleDelete"
          @click="goToDetail"
          @longpress="onFundLongPress(fund.code, fund.name)"
        />
      </template>

      <!-- 空状态 -->
      <van-empty
        v-else
        image="search"
        description="暂无自选基金"
      >
        <van-button round type="primary" @click="goToSearch">
          添加基金
        </van-button>
      </van-empty>
      
      <!-- 底部占位 -->
      <div class="bottom-spacer"></div>
    </van-pull-refresh>

    <!-- 提醒设置弹窗 -->
    <van-popup v-model:show="showAlertDialog" position="bottom" round>
      <div class="alert-dialog">
        <div class="dialog-header">
          <span>设置提醒</span>
          <van-icon name="cross" @click="showAlertDialog = false" />
        </div>
        <div class="dialog-fund">{{ alertFund?.name }}</div>
        
        <van-field label="提醒类型">
          <template #input>
            <van-radio-group v-model="alertForm.type" direction="horizontal">
              <van-radio v-for="t in alertTypes" :key="t.value" :name="t.value">
                {{ t.label }}
              </van-radio>
            </van-radio-group>
          </template>
        </van-field>
        
        <van-field
          v-model="alertForm.threshold"
          :label="alertForm.type.includes('change') ? '阈值(%)' : '目标净值'"
          type="number"
          :placeholder="alertForm.type.includes('change') ? '例如: 3' : '例如: 1.5000'"
        />
        
        <div class="dialog-footer">
          <van-button block type="primary" @click="submitAlert">确认设置</van-button>
        </div>
      </div>
    </van-popup>
    
    <!-- 公告详情弹窗 -->
    <van-popup
      v-model:show="showAnnouncementPopup"
      round
      position="center"
      :style="{ width: '85%', maxWidth: '400px' }"
    >
      <div class="announcement-detail" v-if="currentAnnouncement">
        <div class="announcement-detail-header" :class="currentAnnouncement.type">
          <van-icon 
            :name="currentAnnouncement.type === 'update' ? 'upgrade' : currentAnnouncement.type === 'warning' ? 'warning-o' : 'info-o'" 
            size="24"
          />
          <h3>{{ currentAnnouncement.title }}</h3>
        </div>
        <div class="announcement-detail-content">
          <p v-for="(line, idx) in currentAnnouncement.content.split('\n')" :key="idx">
            <!-- [WHY] 检测 URL 并使其可点击 -->
            <a 
              v-if="line.startsWith('http')" 
              :href="line" 
              target="_blank" 
              class="announcement-link"
              @click.stop
            >{{ line }}</a>
            <span v-else>{{ line }}</span>
          </p>
        </div>
        <div class="announcement-detail-footer">
          <van-button 
            v-if="currentAnnouncement.type === 'update'" 
            block 
            type="primary" 
            @click="goToUpdate(); closeAnnouncement()"
          >
            立即更新
          </van-button>
          <van-button block plain @click="closeAnnouncement">
            {{ currentAnnouncement.type === 'update' ? '稍后再说' : '知道了' }}
          </van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.home-page {
  /* [WHY] 使用 100% 高度适配 flex 布局 */
  height: 100%;
  background: var(--bg-primary);
  transition: background-color 0.3s;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 顶部搜索栏 - 交易终端风格 */
.top-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  padding-top: calc(12px + env(safe-area-inset-top, 0px));
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  position: sticky;
  top: 0;
  z-index: 100;
  border-bottom: 1px solid var(--border-color);
}

.header-left {
  flex-shrink: 0;
}

.app-title {
  font-size: 20px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--color-primary) 0%, #ffca28 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  letter-spacing: -0.5px;
}

.search-bar {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  background: linear-gradient(135deg, var(--bg-primary) 0%, rgba(25, 137, 250, 0.08) 100%);
  border: 1px solid rgba(25, 137, 250, 0.28);
  border-radius: 12px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 4px 14px rgba(25, 137, 250, 0.08);
}

.search-bar:active {
  background: linear-gradient(135deg, rgba(25, 137, 250, 0.16) 0%, rgba(25, 137, 250, 0.06) 100%);
  border-color: rgba(25, 137, 250, 0.45);
  transform: translateY(1px);
}

/* 公告栏 */
.notice-bar {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  background: var(--bg-secondary);
  font-size: 13px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.notice-icon {
  color: var(--text-secondary);
  margin-right: 8px;
  flex-shrink: 0;
}

.notice-swipe {
  flex: 1;
  height: 20px;
  line-height: 20px;
}

.fund-list-container {
  /* [WHY] 使用 flex: 1 自动撑满剩余空间 */
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  /* [WHY] 下拉刷新需要这个属性 */
  overscroll-behavior-y: contain;
  /* [WHY] Android WebView 需要明确的触摸行为 */
  touch-action: pan-y;
}

/* 大盘指数概览 - 交易终端风格 */
.market-overview {
  padding: 16px;
  background: var(--bg-secondary);
  margin: 12px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  position: relative;
  overflow: hidden;
}

.overview-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.title-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: all 0.3s;
}

.live-dot.trading {
  background: var(--color-down);
  animation: pulse 1.5s ease-in-out infinite;
  box-shadow: 0 0 8px var(--color-down);
}

.live-dot.break {
  background: var(--color-primary);
  animation: pulse 3s ease-in-out infinite;
  box-shadow: 0 0 6px var(--color-primary);
}

.live-dot.closed {
  background: var(--text-muted);
  animation: none;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}

/* 交易状态标签 */
.trading-status {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.status-text {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
}

.trading-status.trading .status-text {
  background: rgba(81, 207, 102, 0.15);
  color: var(--color-down);
}

.trading-status.break .status-text {
  background: rgba(255, 193, 7, 0.15);
  color: var(--color-primary);
}

.trading-status.closed .status-text {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.status-time {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-number);
}

.view-more {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-secondary);
  padding: 6px 10px;
  background: var(--color-secondary-bg);
  border-radius: var(--radius-md);
  transition: all 0.2s;
}

.view-more:active {
  background: var(--bg-active);
}

.index-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.index-item {
  padding: 14px 12px;
  background: var(--bg-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
  transition: all 0.2s;
  position: relative;
  overflow: hidden;
  cursor: pointer;
}

.index-item:active {
  transform: scale(0.98);
}

.index-item.up {
  border-color: rgba(255, 107, 107, 0.25);
  background: linear-gradient(135deg, var(--bg-primary) 0%, rgba(255, 107, 107, 0.05) 100%);
}

.index-item.down {
  border-color: rgba(81, 207, 102, 0.25);
  background: linear-gradient(135deg, var(--bg-primary) 0%, rgba(81, 207, 102, 0.05) 100%);
}

.index-name {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.index-value {
  margin-bottom: 6px;
}

.value-num {
  font-size: 20px;
  font-weight: 700;
  font-family: var(--font-number);
  letter-spacing: -0.5px;
}

.index-change {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-number);
  padding: 3px 8px;
  border-radius: 4px;
}

.index-item.up .value-num {
  color: var(--color-up);
}

.index-item.down .value-num {
  color: var(--color-down);
}

.index-item.up .index-change {
  color: var(--color-up);
  background: rgba(255, 107, 107, 0.12);
}

.index-item.down .index-change {
  color: var(--color-down);
  background: rgba(81, 207, 102, 0.12);
}

/* 底部进度条效果 */
.index-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
}

.index-item.up .index-bar {
  background: linear-gradient(90deg, transparent 0%, var(--color-up) 50%, transparent 100%);
}

.index-item.down .index-bar {
  background: linear-gradient(90deg, transparent 0%, var(--color-down) 50%, transparent 100%);
}

/* 全球指数 */
.global-indices {
  padding: 12px;
  background: var(--bg-secondary);
  margin: 8px 12px;
  border-radius: 12px;
}

.global-indices .section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
}

/* [FIX] #35 优化全球指数排版 */
.global-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-top: 12px;
}

.global-item {
  display: flex;
  flex-direction: column;
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 10px;
  gap: 6px;
}

.global-name {
  font-size: 13px;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.global-values {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.region-tag {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 500;
  flex-shrink: 0;
}

.region-tag.cn { background: #fee2e2; color: #dc2626; }
.region-tag.hk { background: #fef3c7; color: #d97706; }
.region-tag.us { background: #dbeafe; color: #2563eb; }
.region-tag.eu { background: #e0e7ff; color: #4f46e5; }
.region-tag.asia { background: #d1fae5; color: #059669; }

.global-price {
  font-size: 13px;
  font-weight: 600;
  margin: 0 8px;
}

.global-change {
  font-size: 12px;
  font-weight: 500;
  min-width: 55px;
  text-align: right;
}

.global-item.up .global-price,
.global-item.up .global-change {
  color: var(--color-up);
}

.global-item.down .global-price,
.global-item.down .global-change {
  color: var(--color-down);
}

.global-item.no-data {
  opacity: 0.6;
}

.global-values.no-data-text {
  justify-content: center;
}

.global-values.no-data-text span {
  font-size: 12px;
  color: var(--text-secondary);
}

.expand-hint {
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 10px 0 4px;
  cursor: pointer;
}

/* 快捷入口 - 交易终端风格 */
.quick-actions {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  padding: 16px 12px;
  margin: 0 12px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
}

.action-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 4px;
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: all 0.2s;
}

.action-item:active {
  background: var(--bg-active);
  transform: scale(0.95);
}

.action-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--bg-tertiary) 0%, var(--bg-elevated) 100%);
  border-radius: var(--radius-md);
  color: var(--color-primary);
  border: 1px solid var(--border-color);
  transition: all 0.2s;
}

.action-item:active .action-icon {
  border-color: var(--color-primary);
  box-shadow: 0 0 12px rgba(255, 193, 7, 0.2);
}

.action-item span {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

/* 自选基金标题 */
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px 8px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.fund-count {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 财经资讯 - 交易终端风格 */
.news-section {
  margin: 0 12px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.news-section .section-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(90deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
}

.news-section .section-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.news-section .section-title::before {
  content: '';
  display: inline-block;
  width: 3px;
  height: 16px;
  background: var(--color-primary);
  border-radius: 2px;
}

.news-list {
  padding: 0;
}

.news-item {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-light);
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
}

.news-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 0;
  background: var(--color-secondary);
  transition: height 0.2s;
}

.news-item:active::before {
  height: 60%;
}

.news-item:last-child {
  border-bottom: none;
}

.news-item:active {
  background: var(--bg-hover);
}

.news-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.news-title {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.news-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

.news-source {
  color: var(--color-primary);
}

.news-loading {
  padding: 24px;
  display: flex;
  justify-content: center;
}

/* 底部占位 */
.bottom-spacer {
  height: calc(60px + env(safe-area-inset-bottom, 0px));
}

.refresh-time {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 8px 0;
  background: var(--bg-primary);
}

.alert-badge {
  padding: 2px 8px;
  background: var(--color-primary);
  color: #fff;
  border-radius: 10px;
  font-size: 10px;
}

/* 提醒设置弹窗 */
.alert-dialog {
  padding: 16px;
  background: var(--bg-secondary);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 12px;
  color: var(--text-primary);
}

.dialog-fund {
  font-size: 14px;
  color: var(--text-secondary);
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 12px;
}

.dialog-footer {
  padding-top: 16px;
}

/* 资讯详情弹窗 */
.news-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.news-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.news-detail-content {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
}

.news-detail-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.5;
  margin: 0 0 12px;
}

.news-detail-meta {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.news-detail-summary {
  font-size: 15px;
  line-height: 1.8;
  color: var(--text-primary);
}

.news-detail-footer {
  padding: 16px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}

/* ========== 更新提示 ========== */
.force-update-overlay {
  display: flex;
  align-items: center;
  justify-content: center;
}

.force-update-content {
  background: var(--bg-card);
  padding: 32px 24px;
  border-radius: 16px;
  text-align: center;
  width: 80%;
  max-width: 320px;
}

.force-update-content h3 {
  margin: 16px 0 8px;
  font-size: 18px;
  color: var(--text-primary);
}

.force-update-content p {
  margin: 0 0 24px;
  font-size: 14px;
  color: var(--text-secondary);
}

.update-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 12px;
  padding: 12px 16px;
  background: linear-gradient(135deg, rgba(25, 137, 250, 0.1), rgba(25, 137, 250, 0.05));
  border: 1px solid rgba(25, 137, 250, 0.2);
  border-radius: 12px;
  position: relative;
}

.update-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-primary);
}

.update-card .close-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}

/* ========== 公告卡片 ========== */
.announcement-cards {
  padding: 8px 12px 0;
}

.announcement-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  margin-bottom: 8px;
  background: var(--bg-card);
  border-radius: 10px;
  cursor: pointer;
  transition: transform 0.2s;
}

.announcement-card:active {
  transform: scale(0.98);
}

.announcement-card.info {
  border-left: 3px solid #1989fa;
}

.announcement-card.info .van-icon {
  color: #1989fa;
}

.announcement-card.warning {
  border-left: 3px solid #ff976a;
}

.announcement-card.warning .van-icon {
  color: #ff976a;
}

.announcement-card.update {
  border-left: 3px solid #07c160;
}

.announcement-card.update .van-icon {
  color: #07c160;
}

.announcement-title {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
}

.announcement-card .van-icon:last-child {
  color: var(--text-secondary);
}

/* ========== 公告详情弹窗 ========== */
.announcement-detail {
  background: var(--bg-card);
}

.announcement-detail-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px;
  border-bottom: 1px solid var(--border-color);
}

.announcement-detail-header.info {
  color: #1989fa;
}

.announcement-detail-header.warning {
  color: #ff976a;
}

.announcement-detail-header.update {
  color: #07c160;
}

.announcement-detail-header h3 {
  flex: 1;
  margin: 0;
  font-size: 17px;
  color: var(--text-primary);
}

.announcement-detail-content {
  padding: 20px;
  max-height: 300px;
  overflow-y: auto;
}

.announcement-detail-content p {
  margin: 0 0 8px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--text-primary);
}

.announcement-detail-content p:last-child {
  margin-bottom: 0;
}

/* [WHAT] 公告中的链接样式 */
.announcement-link {
  color: var(--color-primary);
  text-decoration: underline;
  word-break: break-all;
}

.announcement-link:active {
  opacity: 0.7;
}

.announcement-detail-footer {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
