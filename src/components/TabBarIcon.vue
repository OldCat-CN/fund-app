<script setup lang="ts">
defineProps<{
  name: 'holding' | 'market' | 'home' | 'analysis' | 'announcement'
}>()
</script>

<template>
  <svg
    v-if="name === 'holding'"
    class="tab-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="4" y="5" width="16" height="3" rx="1.2" />
    <rect x="4" y="10.5" width="16" height="3" rx="1.2" />
    <rect x="4" y="16" width="16" height="3" rx="1.2" />
  </svg>

  <svg
    v-else-if="name === 'market'"
    class="tab-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M4 17l4.2-4.2 3.3 2.8 5.2-6.1 3.3 2.6" />
    <path d="M4 20h16" />
  </svg>

  <svg
    v-else-if="name === 'home'"
    class="tab-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M4 11.5 12 5l8 6.5" />
    <path d="M6 10.8V19h12v-8.2" />
    <path d="M10 19v-4.8h4V19" />
  </svg>

  <svg
    v-else-if="name === 'analysis'"
    class="tab-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="4" y="12.5" width="3.4" height="6.5" rx="1" />
    <rect x="10.3" y="9" width="3.4" height="10" rx="1" />
    <rect x="16.6" y="6" width="3.4" height="13" rx="1" />
  </svg>

  <svg
    v-else
    class="tab-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <circle cx="12" cy="12" r="3.1" />
    <path d="M12 3.8v2.2M12 18v2.2M20.2 12H18M6 12H3.8M17.6 6.4l-1.5 1.5M7.9 16.1l-1.5 1.5M17.6 17.6l-1.5-1.5M7.9 7.9 6.4 6.4" />
  </svg>
</template>

<style scoped>
.tab-icon {
  width: 20px;
  height: 20px;
  display: block;
}
</style>
