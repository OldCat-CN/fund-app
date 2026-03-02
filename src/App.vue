<script setup lang="ts">
// [WHY] 根组件，包含路由视图和底部导航
// [WHAT] 使用 Varlet BottomNavigation 实现底部导航切换
// [NOTE] 公告和更新检查已移至 Home.vue 中处理
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Snackbar } from '@varlet/ui'

// [WHAT] 水印文字
const watermarkText = '开源软件基金宝'

// [FIX] #50 记住用户上次访问的主页面
const LAST_TAB_KEY = 'fund_app_last_tab'

const route = useRoute()
const router = useRouter()

// [WHY] 处理 Android 返回键，防止直接退出应用
// [WHAT] 在主页时需要双击才能退出
let lastBackTime = 0
let backButtonHandler: ((e: any) => void) | null = null

onMounted(() => {
  // [FIX] #50 首次加载时跳转到上次保存的页面
  const lastTabIndex = getLastTab()
  const currentTab = tabs[lastTabIndex]
  if (currentTab && route.path === '/' && lastTabIndex !== 2) {
    // 如果当前在首页但上次访问的不是首页，则跳转
    router.replace(currentTab.route)
  }
  
  // [WHAT] 仅在 Capacitor 原生环境下处理返回键
  // [WHY] Web 环境不需要处理
  const Capacitor = (window as any).Capacitor
  if (!Capacitor?.isNativePlatform?.()) return
  
  // [WHAT] 使用 Capacitor 全局对象注册返回键监听
  // [WHY] 避免导入 @capacitor/app 模块（Web 环境可能未安装）
  const plugins = Capacitor.Plugins
  if (!plugins?.App) return
  
  plugins.App.addListener('backButton', () => {
    // [WHY] 如果不在主页，正常返回上一页
    const mainPages = ['home', 'market', 'holding', 'analysis', 'announcement']
    const isMainPage = mainPages.includes(route.name as string)
    
    if (!isMainPage && window.history.length > 1) {
      router.back()
      return
    }
    
    // [WHY] 在主页时，双击退出
    const now = Date.now()
    if (now - lastBackTime < 2000) {
      // 2秒内双击返回键，退出应用
      plugins.App.exitApp()
    } else {
      lastBackTime = now
      Snackbar('再按一次退出应用')
    }
  })
  
  backButtonHandler = () => plugins.App.removeAllListeners()
})

onUnmounted(() => {
  if (backButtonHandler) {
    backButtonHandler(null)
  }
})

// [WHAT] Tab配置
const tabs = [
  { name: 'holding', label: '持仓', icon: 'account_balance_wallet', route: '/holding' },
  { name: 'market', label: '行情', icon: 'show_chart', route: '/market' },
  { name: 'home', label: '自选', icon: 'home', route: '/' },
  { name: 'analysis', label: '分析', icon: 'insights', route: '/analysis' },
  { name: 'announcement', label: '公告', icon: 'bell', route: '/announcement' }
]

// [FIX] #50 从本地存储恢复上次访问的主页面
function getLastTab(): number {
  try {
    const saved = localStorage.getItem(LAST_TAB_KEY)
    if (saved !== null) {
      const index = parseInt(saved, 10)
      if (index >= 0 && index < tabs.length) {
        return index
      }
    }
  } catch {
    // 忽略错误
  }
  return 2 // 默认首页(home)在索引2
}

// [WHAT] 当前激活的 tab 索引
const activeTab = ref(getLastTab())

// [WHAT] 需要隐藏底部导航的页面
const hiddenTabbarPages = ['search', 'detail', 'trades']
const showTabbar = computed(() => !hiddenTabbarPages.includes(route.name as string))

// [WHY] 路由变化时同步更新 tab 状态
watch(
  () => route.name,
  (name) => {
    const tabIndex = tabs.findIndex(t => t.name === name)
    if (tabIndex !== -1) {
      activeTab.value = tabIndex
    }
  },
  { immediate: true }
)

// [WHAT] 切换 tab 时跳转路由
function onTabChange(index: number) {
  const tab = tabs[index]
  if (tab) {
    router.push(tab.route)
    // [FIX] #50 保存当前 tab 到本地存储
    try {
      localStorage.setItem(LAST_TAB_KEY, String(index))
    } catch {
      // 忽略存储失败
    }
  }
}
</script>

<template>
  <div class="app-container">
    <!-- 全局水印 -->
    <div class="watermark">
      <div class="watermark-content">
        <span v-for="i in 50" :key="i" class="watermark-text">{{ watermarkText }}</span>
      </div>
    </div>

    <!-- 路由视图 -->
    <!-- [WHY] 暂时禁用 keep-alive 避免页面缓存混乱 -->
    <!-- [WHY] 包装容器确保页面撑满剩余空间，正确处理 Android 滚动 -->
    <div class="page-wrapper">
      <router-view />
    </div>

    <!-- 底部导航栏 - 使用 Varlet BottomNavigation -->
    <var-bottom-navigation
      v-if="showTabbar"
      v-model:active="activeTab"
      @change="onTabChange"
      safe-area
    >
      <var-bottom-navigation-item
        v-for="(tab, index) in tabs"
        :key="tab.name"
        :label="tab.label"
        :icon="tab.icon"
      />
    </var-bottom-navigation>
  </div>
</template>

<style scoped>
.app-container {
  /* [WHY] 固定高度，让子组件处理滚动 */
  height: 100%;
  /* [WHY] 使用主题变量 */
  background: var(--bg-primary);
  transition: background-color 0.3s;
  /* [WHY] 防止容器本身滚动，由子页面处理 */
  overflow: hidden;
  /* [WHY] 弹性布局，让 router-view 撑满剩余空间 */
  display: flex;
  flex-direction: column;
}

/* [WHY] 页面包装器，撑满 tabbar 之外的所有空间 */
.page-wrapper {
  flex: 1;
  overflow: hidden;
  /* [WHY] 相对定位，让子页面可以使用绝对定位或百分比高度 */
  position: relative;
}

/* [WHY] Varlet 底部导航适配 */
:deep(.var-bottom-navigation) {
  --bottom-navigation-background: var(--bg-secondary);
  --bottom-navigation-item-active-color: var(--color-primary);
  border-top: 1px solid var(--border-color);
}

/* [WHY] 全局水印样式 */
/* [WHAT] 覆盖整个页面，半透明，不可点击 */
.watermark {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 9999;
  pointer-events: none; /* [WHY] 不阻挡用户点击 */
  overflow: hidden;
}

.watermark-content {
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  transform: rotate(-30deg); /* [WHY] 斜向排列更美观 */
}

.watermark-text {
  display: inline-block;
  padding: 30px 50px;
  font-size: 16px;
  font-weight: 500;
  color: rgba(128, 128, 128, 0.15); /* [WHY] 半透明灰色，不影响阅读 */
  white-space: nowrap;
  user-select: none;
}
</style>
