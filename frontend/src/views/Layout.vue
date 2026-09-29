<template>
  <el-container class="layout">
    <el-aside width="200px" class="aside">
      <div class="logo">HR Agent</div>
      <el-menu :default-active="$route.path" router background-color="#F2F3EF" text-color="#5C665F" active-text-color="#285E52">
        <el-menu-item index="/dashboard">驾驶舱</el-menu-item>
        <el-menu-item index="/candidate">候选人台账</el-menu-item>
        <el-menu-item index="/jd">岗位管理</el-menu-item>
        <el-menu-item v-if="isAdmin" index="/runs">运行日志</el-menu-item>
        <el-menu-item index="/account">账号管理</el-menu-item>
        <el-menu-item v-if="isAdmin" index="/user">用户管理</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="page-title">{{ $route.meta.title }}</span>
        <div class="header-right">
          <template v-if="isAdmin">
            <el-tooltip content="关闭后:仍自动检测来信/下载附件/评分/拉推荐,但不主动发消息(打招呼/索要);手动操作不受影响" placement="bottom">
              <el-switch v-model="arEnabled" :loading="arLoading" @change="toggleAutoRecruit" />
            </el-tooltip>
            <span class="ar-status" :class="{ warn: !!ar.accountWarning }">{{ arStatusText }}</span>
          </template>
          <el-dropdown @command="handleCommand">
            <span class="user-name">{{ username }}</span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { autoRecruitApi } from '../api/modules'

const router = useRouter()
const username = localStorage.getItem('username') || ''
const isAdmin = computed(() => localStorage.getItem('role') === 'ADMIN')

// ---------- 自动招聘顶部常驻面板(仅 ADMIN 可见) ----------
const ar = ref({ enabled: false, running: false, runningSince: null, lastRun: null, nextRunAt: null, accountWarning: null })
const arEnabled = ref(false)
const arLoading = ref(false)
let arTimer = null

async function loadAutoRecruit() {
  if (!isAdmin.value) return
  try {
    const res = await autoRecruitApi.status()
    ar.value = res.data
    arEnabled.value = res.data.enabled
  } catch {
    // 静默:拦截器已提示
  }
}

async function toggleAutoRecruit(value) {
  // 关闭外发为高影响操作:二次确认(取消时回滚开关显示)
  if (!value) {
    try {
      await ElMessageBox.confirm(
        '关闭后仅收集(检测回复/附件/评分/推荐)，不再主动发消息(打招呼/索要)，确认关闭？',
        '关闭自动外发',
        { type: 'warning', confirmButtonText: '确认关闭', cancelButtonText: '取消' }
      )
    } catch {
      arEnabled.value = true // 用户取消 → 回滚
      return
    }
  }
  arLoading.value = true
  try {
    const res = await autoRecruitApi.setEnabled({ enabled: value })
    ar.value = res.data
    arEnabled.value = res.data.enabled
    ElMessage.success(value ? '自动外发已开启' : '自动外发已关闭(只收简历,不发消息)')
  } catch {
    arEnabled.value = !value // 失败回滚
  } finally {
    arLoading.value = false
  }
}

const arStatusText = computed(() => {
  const s = ar.value
  if (s.accountWarning) return s.accountWarning
  if (s.running) return `运行中(自 ${fmtTime(s.runningSince)})`
  const parts = [s.enabled ? '外发开' : '外发关·只收']
  if (s.lastRun?.at) {
    parts.push(s.lastRun.noAccount ? '上轮无账号' : `上轮 ${fmtTime(s.lastRun.at)} 发声${s.lastRun.greeted ?? 0}`)
  }
  if (s.nextRunAt) parts.push(`下次 ${fmtTime(s.nextRunAt)}`)
  return parts.join(' · ')
})

function fmtTime(t) {
  if (!t) return '-'
  return String(t).slice(5, 16).replace('T', ' ')
}

onMounted(() => {
  loadAutoRecruit()
  if (isAdmin.value) arTimer = setInterval(loadAutoRecruit, 60000)
})

onUnmounted(() => {
  if (arTimer) clearInterval(arTimer)
})

async function handleCommand(command) {
  if (command === 'logout') {
    try {
      await ElMessageBox.confirm('确定退出登录？', '退出确认', { type: 'warning' })
    } catch {
      return // 用户取消
    }
    localStorage.removeItem('token')
    localStorage.removeItem('role')
    localStorage.removeItem('username')
    router.push('/login')
  }
}
</script>

<style scoped>
.layout {
  height: 100vh;
  background: var(--hr-bg);
}
.aside {
  background: var(--hr-bg-alt);
  border-right: 1px solid var(--hr-border);
}
.logo {
  color: var(--hr-text-1);
  font-size: 18px;
  font-weight: 600;
  text-align: center;
  padding: 16px 0;
}
/* 侧边栏菜单:去掉默认右边框,激活项用主色+品牌软底(对齐目标站导航观感) */
.aside :deep(.el-menu) {
  border-right: none;
  padding: 0 8px;
}
.aside :deep(.el-menu-item) {
  border-radius: var(--hr-radius-sm);
  margin-bottom: 2px;
}
.aside :deep(.el-menu-item.is-active) {
  background: var(--hr-brand-soft);
  font-weight: 600;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--hr-surface);
  border-bottom: 1px solid var(--hr-border);
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ar-status {
  font-size: 12px;
  color: var(--hr-text-2);
  max-width: 460px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ar-status.warn {
  color: var(--el-color-danger);
  font-weight: 600;
}
.page-title {
  font-size: 16px;
  font-weight: 600;
}
.user-name {
  cursor: pointer;
}
</style>
