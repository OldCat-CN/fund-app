<script setup lang="ts">
import { useRouter } from 'vue-router'
import ScreenshotImport from '@/components/ScreenshotImport.vue'

const router = useRouter()

function goBack() {
  router.push('/holding')
}

function handleVisibilityChange(show: boolean) {
  if (!show) {
    goBack()
  }
}
</script>

<template>
  <div class="holding-import-page">
    <van-nav-bar title="截图导入持仓" left-arrow safe-area-inset-top @click-left="goBack" />
    <div class="import-content">
      <ScreenshotImport
        :show="true"
        :embedded="true"
        @update:show="handleVisibilityChange"
      />
    </div>
  </div>
</template>

<style scoped>
.holding-import-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(circle at 85% -10%, rgba(25, 137, 250, 0.18), transparent 42%),
    radial-gradient(circle at 10% 120%, rgba(30, 186, 138, 0.14), transparent 36%),
    var(--bg-primary);
}

.import-content {
  flex: 1;
  min-height: 0;
  padding: 0 0 env(safe-area-inset-bottom);
}
</style>
