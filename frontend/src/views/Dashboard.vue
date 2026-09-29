<template>
  <div class="dash">
    <div class="kpi-grid">
      <el-card shadow="never" class="kpi">
        <div class="kpi-label">在招岗位</div>
        <div class="kpi-num">{{ summary.jobs.active }}</div>
        <div class="kpi-sub">共 {{ summary.jobs.total }} 个 · 评分偏好已确认 {{ summary.jobs.thresholdConfirmed }}</div>
      </el-card>
      <el-card shadow="never" class="kpi">
        <div class="kpi-label">候选人库</div>
        <div class="kpi-num">{{ summary.candidates.total }}</div>
        <div class="kpi-sub">在线简历已入库并自动评分</div>
      </el-card>
      <el-card shadow="never" class="kpi">
        <div class="kpi-label">已收简历</div>
        <div class="kpi-num">{{ summary.candidates.withResume }}</div>
        <div class="kpi-sub">PDF 已入库，可在线查看</div>
      </el-card>
      <el-card shadow="never" class="kpi">
        <div class="kpi-label">待筛选</div>
        <div class="kpi-num">{{ summary.recruit.pendingReview }}</div>
        <div class="kpi-sub">收到简历后待你处理</div>
      </el-card>
    </div>

    <div class="cols">
      <el-card shadow="never" class="panel">
        <template #header>
          <div class="panel-head">
            <span>招聘进度</span>
            <el-button link type="primary" @click="$router.push('/candidate')">查看候选人</el-button>
          </div>
        </template>
        <div class="prog-grid">
          <div v-for="item in progressItems" :key="item.key" class="prog">
            <el-tag :type="item.tag" size="small">{{ item.label }}</el-tag>
            <span class="prog-num">{{ item.count }}</span>
          </div>
        </div>
      </el-card>

      <el-card v-if="isAdmin" shadow="never" class="panel">
        <template #header>
          <div class="panel-head">
            <span>自动化状态</span>
            <el-button link type="primary" @click="$router.push('/runs')">运行日志</el-button>
          </div>
        </template>
        <div class="auto-rows">
          <div class="auto-row">
            <span class="auto-label">外发开关</span>
            <el-tag :type="ar.enabled ? 'success' : 'info'" size="small">{{ ar.enabled ? '开' : '关 · 只收' }}</el-tag>
          </div>
          <div class="auto-row">
            <span class="auto-label">当前</span>
            <span>{{ ar.running ? `运行中(自 ${fmt(ar.runningSince)})` : '空闲' }}</span>
          </div>
          <div class="auto-row">
            <span class="auto-label">上轮</span>
            <span v-if="ar.lastRun">
              {{ fmt(ar.lastRun.at) }} · 评分 {{ ar.lastRun.scored ?? 0 }} · 打招呼 {{ ar.lastRun.greeted ?? 0 }} · 推荐 {{ ar.lastRun.recommended ?? 0 }}
              <el-tag v-if="ar.lastRun.riskStopped" type="danger" size="small" class="ml6">风控停轮</el-tag>
              <el-tag v-if="ar.lastRun.noAccount" type="warning" size="small" class="ml6">无可用账号</el-tag>
            </span>
            <span v-else>-</span>
          </div>
          <div class="auto-row">
            <span class="auto-label">下次运行</span>
            <span>{{ ar.nextRunAt ? fmt(ar.nextRunAt) : '-' }}</span>
          </div>
          <div v-if="ar.accountWarning" class="auto-row warn">
            <span class="auto-label">账号</span>
            <span>{{ ar.accountWarning }}</span>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="panel">
        <template #header>
          <div class="panel-head"><span>最新入库简历</span></div>
        </template>
        <el-table :data="summary.latestResumes" size="small" empty-text="暂无入库简历" @row-click="openCandidate">
          <el-table-column prop="name" label="候选人" width="90" />
          <el-table-column prop="jdTitle" label="岗位" min-width="140" show-overflow-tooltip />
          <el-table-column label="星级" width="110">
            <template #default="{ row }">
              <span v-if="row.star" class="stars">{{ starTextOf(row.star) }}</span>
              <span v-else-if="row.score !== null && row.score !== undefined" class="muted">旧分 {{ row.score }}</span>
              <span v-else class="muted">未评分</span>
            </template>
          </el-table-column>
          <el-table-column label="入库时间" width="110">
            <template #default="{ row }">{{ fmt(row.resumeCreatedAt) }}</template>
          </el-table-column>
          <el-table-column label="" width="70">
            <template #default><el-button link type="primary" size="small">查看</el-button></template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <CandidateDrawer v-model="drawerVisible" :candidate-id="drawerId" @updated="loadSummary" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { autoRecruitApi, dashboardApi } from '../api/modules'
import CandidateDrawer from '../components/CandidateDrawer.vue'
import { RECRUIT_STATUS, textOf, starTextOf } from '../utils/labels'

const isAdmin = computed(() => localStorage.getItem('role') === 'ADMIN')

const summary = ref({
  jobs: { total: 0, active: 0, thresholdConfirmed: 0 },
  candidates: { total: 0, withResume: 0 },
  recruit: { pendingReview: 0, qualified: 0, interviewScheduled: 0, notSuitable: 0 },
  latestResumes: []
})

const ar = ref({ enabled: false, running: false, runningSince: null, lastRun: null, nextRunAt: null, accountWarning: null })

const progressItems = computed(() => [
  { key: 'pendingReview', label: textOf(RECRUIT_STATUS, 'PENDING_REVIEW'), count: summary.value.recruit.pendingReview, tag: 'info' },
  { key: 'qualified', label: textOf(RECRUIT_STATUS, 'QUALIFIED'), count: summary.value.recruit.qualified, tag: 'success' },
  { key: 'interviewScheduled', label: textOf(RECRUIT_STATUS, 'INTERVIEW_SCHEDULED'), count: summary.value.recruit.interviewScheduled, tag: 'warning' },
  { key: 'notSuitable', label: textOf(RECRUIT_STATUS, 'NOT_SUITABLE'), count: summary.value.recruit.notSuitable, tag: 'danger' }
])

const drawerVisible = ref(false)
const drawerId = ref(null)

function openCandidate(row) {
  drawerId.value = row.candidateId
  drawerVisible.value = true
}

async function loadSummary() {
  try {
    const res = await dashboardApi.summary()
    summary.value = res.data
  } catch {
    // 拦截器已提示
  }
}

async function loadAutoStatus() {
  if (!isAdmin.value) return
  try {
    const res = await autoRecruitApi.status()
    ar.value = res.data
  } catch {
    // 静默
  }
}

function fmt(t) {
  return t ? String(t).slice(5, 16).replace('T', ' ') : '-'
}

onMounted(() => {
  loadSummary()
  loadAutoStatus()
})
</script>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
.kpi-label {
  font-size: 13px;
  color: var(--hr-text-2);
}
.kpi-num {
  font-size: 30px;
  font-weight: 700;
  color: var(--hr-text-1);
  margin: 4px 0;
}
.kpi-sub {
  font-size: 12px;
  color: var(--hr-text-3);
}
.cols {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.prog-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.prog {
  display: flex;
  align-items: center;
  gap: 10px;
}
.prog-num {
  font-size: 20px;
  font-weight: 600;
}
.auto-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: var(--hr-text-2);
}
.auto-row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.auto-label {
  color: var(--hr-text-3);
  width: 68px;
  flex-shrink: 0;
}
.auto-row.warn {
  color: var(--el-color-danger);
  font-weight: 600;
}
.stars {
  color: #e6a23c;
  letter-spacing: 1px;
}
.muted {
  color: var(--hr-text-3);
  font-size: 12px;
}
.ml6 {
  margin-left: 6px;
}
</style>
