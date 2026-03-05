<script setup lang="ts">
// [WHY] 公告中心页面 - 集中展示所有公告、更新日志、关于信息
// [WHAT] 显示远程公告、版本信息、开源链接、更新记录

import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { 
  fetchRemoteConfig, 
  clearShownAnnouncements,
  type Announcement,
  type RemoteConfig
} from '@/api/remote'
import { useThemeStore } from '@/stores/theme'
import { APP_VERSION } from '@/config/version'
import { showToast } from 'vant'

const router = useRouter()
const themeStore = useThemeStore()

// [WHAT] 数据状态
const loading = ref(true)
const config = ref<RemoteConfig | null>(null)
const activeTab = ref<'settings' | 'announcement' | 'update' | 'about'>('settings')

// [WHAT] 更新日志（本地维护）
const updateLogs = [
  {
    version: '1.9.0',
    date: '2026-02-05',
    changes: [
      '新增：全球指数展示（A股/港股/美股/欧洲/亚洲）',
      '新增：记住用户上次访问的页面',
      '优化：默认使用浅色主题，日间使用更舒适',
      '优化：API调用策略，数据加载更快',
      '优化：底部导航组件升级为Varlet',
      '修复：CSS变量冲突导致的颜色显示问题',
      '修复：持仓页面更新状态标签显示',
    ]
  },
  {
    version: '1.8.0',
    date: '2026-02-03',
    changes: [
      '新增：AI智能日报（通义千问生成）',
      '新增：大盘指数交易状态实时显示',
      '新增：联系作者QQ信息',
      '优化：大盘指数UI交易终端风格',
      '优化：多源API备用机制，数据更稳定',
      '优化：交易终端深色主题风格',
    ]
  },
  {
    version: '1.7.0',
    date: '2026-02-02',
    changes: [
      '优化：多源数据验证，确保净值准确',
      '优化：智能选择公布净值或估值数据',
      '优化：交易时间内30秒缓存，非交易5分钟',
      '修复：持仓页面修改弹窗直接打开',
      '修复：买入手续费支持自定义',
    ]
  },
  {
    version: '1.6.0',
    date: '2026-02-02',
    changes: [
      '新增：截图识别导入持仓功能',
      '新增：支持支付宝、天天基金、蛋卷等平台截图',
      '新增：本地 OCR 识别，无需联网',
      '新增：批量导入多只基金',
    ]
  },
  {
    version: '1.5.0',
    date: '2026-02-02',
    changes: [
      '新增：持仓成本调整功能',
      '新增：支持分红再投、补仓摊薄等场景',
      '修复：Android 状态栏重叠问题',
      '优化：持仓操作增加"调整"按钮',
    ]
  },
  {
    version: '1.4.0',
    date: '2026-02-02',
    changes: [
      '修复：Android APP 页面滑动问题',
      '优化：使用 Flex 布局重构页面滚动',
      '优化：适配 Android WebView 触摸滚动',
      '优化：统一所有页面的滚动行为',
    ]
  },
  {
    version: '1.3.0',
    date: '2026-01-29',
    changes: [
      '新增：全局水印防盗版标识',
      '新增：应用内更新检测提示',
      '优化：点击更新跳转123云盘下载',
      '修复：休市日当日收益显示为0',
    ]
  },
  {
    version: '1.2.0',
    date: '2026-01-30',
    changes: [
      '新增：行业配置饼图展示',
      '新增：资产配置柱状图',
      '新增：基金评级信息（夏普比率、最大回撤等）',
      '优化：图表X轴时间标签避免重叠',
      '优化：实时价格标签样式改进',
      '优化：当日模式显示真实数据',
      '修复：导航栏改为虚拟按键模式',
    ]
  },
  {
    version: '1.1.0',
    date: '2026-01-29',
    changes: [
      '新增：全球指数实时行情',
      '新增：基金重仓股票明细',
      '新增：公告中心页面',
      '优化：首页布局调整',
    ]
  },
  {
    version: '1.0.0',
    date: '2026-01-28',
    changes: [
      '首次发布',
      '支持基金自选、持仓管理',
      '支持基金对比、定投计算',
      '支持基金经理排行、回测模拟',
      '支持智能提醒、投资日历',
    ]
  }
]

// [WHAT] 关于信息
const aboutInfo = {
  name: '基金宝',
  version: APP_VERSION,
  description: '一款简洁实用的基金管理工具',
  github: 'https://github.com/xiriovo/fund-app',
  contact: {
    qq: '1708298587'
  },
  features: [
    '实时估值 - 秒级更新基金估值',
    '自选管理 - 便捷管理关注基金',
    '持仓记录 - 记录买入计算收益',
    '基金对比 - 多维度对比分析',
    '定投计算 - 模拟定投收益',
    '智能提醒 - 涨跌提醒不错过',
  ]
}

// [WHAT] 所有公告（不过滤showOnce）
const allAnnouncements = computed(() => {
  if (!config.value) return []
  const now = new Date()
  return config.value.announcements.filter(a => {
    const start = new Date(a.startTime)
    const end = new Date(a.endTime)
    return now >= start && now <= end
  })
})

// [WHAT] 加载远程配置
onMounted(async () => {
  loading.value = true
  try {
    config.value = await fetchRemoteConfig()
  } finally {
    loading.value = false
  }
})

// [WHAT] 获取公告类型样式
function getAnnouncementClass(type: string) {
  return {
    info: 'type-info',
    warning: 'type-warning',
    update: 'type-update'
  }[type] || 'type-info'
}

// [WHAT] 获取公告类型标签
function getTypeLabel(type: string) {
  return {
    info: '公告',
    warning: '警告',
    update: '更新'
  }[type] || '公告'
}

// [WHAT] 打开链接
function openLink(url: string) {
  window.open(url, '_blank')
}

// [WHAT] 复制到剪贴板
async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast('已复制到剪贴板')
  } catch {
    showToast('复制失败')
  }
}

// [WHAT] 清除已读记录
function resetReadStatus() {
  clearShownAnnouncements()
  showToast('已重置，下次启动将重新显示公告')
}
</script>

<template>
  <div class="announcement-page">
    <!-- 顶部导航 -->
    <div class="page-header">
      <van-icon name="arrow-left" size="20" @click="router.back()" />
      <span class="header-title">设置中心</span>
      <div class="header-placeholder"></div>
    </div>

    <!-- Tab 切换 -->
    <div class="tab-bar">
      <div 
        class="tab-item" 
        :class="{ active: activeTab === 'settings' }"
        @click="activeTab = 'settings'"
      >
        设置
      </div>
      <div 
        class="tab-item" 
        :class="{ active: activeTab === 'announcement' }"
        @click="activeTab = 'announcement'"
      >
        公告
      </div>
      <div 
        class="tab-item" 
        :class="{ active: activeTab === 'update' }"
        @click="activeTab = 'update'"
      >
        更新日志
      </div>
      <div 
        class="tab-item" 
        :class="{ active: activeTab === 'about' }"
        @click="activeTab = 'about'"
      >
        关于
      </div>
    </div>

    <!-- 内容区域 -->
    <div class="content-area">
      <!-- 设置 -->
      <div v-if="activeTab === 'settings'" class="settings-section">
        <van-cell-group inset>
          <van-cell title="深色模式" center>
            <template #right-icon>
              <van-switch 
                :model-value="themeStore.actualTheme === 'dark'"
                @update:model-value="themeStore.toggleTheme()"
                size="20px"
              />
            </template>
          </van-cell>
          <van-cell title="跟随系统" center>
            <template #right-icon>
              <van-switch 
                :model-value="themeStore.mode === 'auto'"
                @update:model-value="(v: boolean) => themeStore.setTheme(v ? 'auto' : themeStore.actualTheme)"
                size="20px"
              />
            </template>
          </van-cell>
        </van-cell-group>
      </div>

      <!-- 公告列表 -->
      <div v-if="activeTab === 'announcement'" class="announcement-list">
        <van-loading v-if="loading" class="loading-state" />
        
        <template v-else-if="allAnnouncements.length > 0">
          <div 
            v-for="item in allAnnouncements" 
            :key="item.id"
            class="announcement-card"
          >
            <div class="card-header">
              <span class="type-tag" :class="getAnnouncementClass(item.type)">
                {{ getTypeLabel(item.type) }}
              </span>
              <span class="card-title">{{ item.title }}</span>
            </div>
            <div class="card-content">
              <p v-for="(line, idx) in item.content.split('\\n')" :key="idx">
                <a 
                  v-if="line.startsWith('http')" 
                  :href="line" 
                  target="_blank" 
                  class="content-link"
                  @click.stop
                >{{ line }}</a>
                <span v-else>{{ line }}</span>
              </p>
            </div>
            <div class="card-footer">
              <span class="time-range">
                {{ item.startTime.split('T')[0] }} ~ {{ item.endTime.split('T')[0] }}
              </span>
            </div>
          </div>
        </template>

        <van-empty v-else description="暂无公告" />

        <!-- 重置按钮 -->
        <div class="reset-btn" @click="resetReadStatus">
          重置已读状态
        </div>
      </div>

      <!-- 更新日志 -->
      <div v-if="activeTab === 'update'" class="update-logs">
        <div 
          v-for="log in updateLogs" 
          :key="log.version"
          class="log-card"
        >
          <div class="log-header">
            <span class="log-version">v{{ log.version }}</span>
            <span class="log-date">{{ log.date }}</span>
            <span v-if="log.version === APP_VERSION" class="current-tag">当前版本</span>
          </div>
          <ul class="log-changes">
            <li v-for="(change, idx) in log.changes" :key="idx">
              {{ change }}
            </li>
          </ul>
        </div>
      </div>

      <!-- 关于页面 -->
      <div v-if="activeTab === 'about'" class="about-section">
        <!-- Logo 区域 -->
        <div class="about-logo">
          <div class="logo-icon">💰</div>
          <div class="app-name">{{ aboutInfo.name }}</div>
          <div class="app-version">v{{ aboutInfo.version }}</div>
          <div class="app-desc">{{ aboutInfo.description }}</div>
        </div>

        <!-- 功能特点 -->
        <div class="feature-card">
          <div class="card-title">功能特点</div>
          <div class="feature-list">
            <div 
              v-for="(feature, idx) in aboutInfo.features" 
              :key="idx"
              class="feature-item"
            >
              <van-icon name="checked" color="var(--color-primary)" />
              <span>{{ feature }}</span>
            </div>
          </div>
        </div>

        <!-- 链接 -->
        <div class="link-card">
          <div class="link-item" @click="openLink(aboutInfo.github)">
            <div class="link-icon">
              <van-icon name="link-o" size="20" />
            </div>
            <div class="link-info">
              <div class="link-title">GitHub</div>
              <div class="link-desc">查看源代码，欢迎 Star</div>
            </div>
            <van-icon name="arrow" color="var(--text-secondary)" />
          </div>
        </div>

        <!-- 联系方式 -->
        <div class="link-card">
          <div class="link-item" @click="copyToClipboard(aboutInfo.contact.qq)">
            <div class="link-icon qq-icon">
              <span>QQ</span>
            </div>
            <div class="link-info">
              <div class="link-title">联系作者</div>
              <div class="link-desc">QQ: {{ aboutInfo.contact.qq }}</div>
            </div>
            <van-icon name="records-o" color="var(--text-secondary)" />
          </div>
        </div>

        <!-- 版权信息 -->
        <div class="copyright">
          <p>基金投资有风险，入市需谨慎</p>
          <p>本应用仅供学习参考，不构成投资建议</p>
          <p class="open-source">开源项目 · MIT License</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.announcement-page {
  /* [WHY] 使用 100% 高度适配 flex 布局 */
  height: 100%;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 顶部导航 */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  padding-top: calc(12px + env(safe-area-inset-top));
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.header-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
}

.header-placeholder {
  width: 20px;
}

/* Tab 切换 */
.tab-bar {
  display: flex;
  background: var(--bg-secondary);
  padding: 0 8px;
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
}

.tab-item {
  min-width: 25%;
  text-align: center;
  padding: 12px 0;
  font-size: 14px;
  color: var(--text-secondary);
  position: relative;
  cursor: pointer;
  transition: color 0.2s;
}

.tab-item.active {
  color: var(--color-primary);
  font-weight: 600;
}

.tab-item.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 24px;
  height: 3px;
  background: var(--color-primary);
  border-radius: 2px;
}

/* 内容区域 */
.content-area {
  /* [WHY] 使用 flex: 1 自动撑满剩余空间 */
  flex: 1;
  padding: 12px;
  padding-bottom: 20px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  /* [WHY] Android WebView 需要明确的触摸行为 */
  touch-action: pan-y;
}

.settings-section {
  padding-top: 4px;
}

/* 公告列表 */
.loading-state {
  display: flex;
  justify-content: center;
  padding: 40px;
}

.announcement-card {
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.type-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
}

.type-info {
  background: #e0f2fe;
  color: #0369a1;
}

.type-warning {
  background: #fef3c7;
  color: #d97706;
}

.type-update {
  background: #d1fae5;
  color: #059669;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.card-content {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.card-content p {
  margin: 4px 0;
}

.content-link {
  color: var(--color-primary);
  text-decoration: underline;
  word-break: break-all;
}

.card-footer {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.time-range {
  font-size: 12px;
  color: var(--text-tertiary);
}

.reset-btn {
  text-align: center;
  padding: 12px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

/* 更新日志 */
.log-card {
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
}

.log-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.log-version {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-primary);
}

.log-date {
  font-size: 12px;
  color: var(--text-secondary);
}

.current-tag {
  font-size: 10px;
  padding: 2px 6px;
  background: var(--color-primary);
  color: white;
  border-radius: 4px;
  margin-left: auto;
}

.log-changes {
  margin: 0;
  padding-left: 20px;
}

.log-changes li {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.8;
}

/* 关于页面 */
.about-logo {
  text-align: center;
  padding: 32px 0;
}

.logo-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.app-name {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.app-version {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.app-desc {
  font-size: 14px;
  color: var(--text-secondary);
}

.feature-card,
.link-card {
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
}

.feature-card .card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.feature-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-secondary);
}

.link-item {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.link-icon {
  width: 40px;
  height: 40px;
  background: var(--bg-primary);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.link-icon.qq-icon {
  background: linear-gradient(135deg, #12b7f5 0%, #1e90ff 100%);
  color: white;
  font-size: 12px;
  font-weight: 700;
}

.link-info {
  flex: 1;
}

.link-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.link-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.copyright {
  text-align: center;
  padding: 24px 0 40px;
}

.copyright p {
  font-size: 12px;
  color: var(--text-tertiary);
  margin: 4px 0;
}

.copyright .open-source {
  margin-top: 12px;
  color: var(--text-secondary);
}
</style>
