<template>
  <div>
    <el-tabs v-model="activeTab" @tab-change="onTabChange">
      <el-tab-pane label="已收简历" name="received" />
      <el-tab-pane v-if="isAdmin" label="待分配" name="unassigned" />
    </el-tabs>
    <div class="toolbar">
      <el-select v-if="activeTab === 'received'" v-model="selectedJdId" placeholder="选择岗位" clearable style="width: 220px" @change="load()">
        <el-option v-for="jd in jds" :key="jd.id" :label="jd.title" :value="jd.id" />
      </el-select>
      <el-select v-model="filterStatus" placeholder="评分状态" clearable style="width: 140px" @change="load()">
        <el-option label="待评分" value="PENDING" />
        <el-option label="已通过" value="PASS" />
        <el-option label="留库" value="KEPT" />
        <el-option label="疑似否决" value="HOLD" />
        <el-option label="未通过" value="FAIL" />
      </el-select>
      <el-select v-model="filterStar" placeholder="星级" clearable style="width: 100px" @change="load()">
        <el-option v-for="n in 5" :key="n" :label="`${n} 星`" :value="n" />
      </el-select>
      <el-select v-model="filterRecruit" placeholder="招聘状态" clearable style="width: 130px" @change="load()">
        <el-option v-for="opt in recruitOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
      <template v-if="activeTab === 'received' && isAdmin">
        <el-button type="warning" :loading="runOnceLoading" @click="runOnce">立即运行一轮</el-button>
        <el-button @click="advancedVisible = !advancedVisible">{{ advancedVisible ? '收起高级操作' : '高级操作' }}</el-button>
      </template>
      <span v-if="activeTab === 'unassigned'" class="tab-hint">待分配:无有效岗位的候选人(含已入库附件),需人工指派岗位</span>
    </div>

    <div v-if="activeTab === 'received' && isAdmin && advancedVisible" class="advanced-panel">
      <el-button type="primary" :disabled="!selectedJdId" @click="runScore">批量评分(10人)</el-button>
      <el-button type="success" :disabled="!selectedJdId" @click="runGreet">批量打招呼(10人)</el-button>
      <el-button :disabled="!selectedJdId" @click="runCollect">检测回复并索要简历</el-button>
      <el-button type="warning" :disabled="!selectedJdId" :loading="recommendLoading" @click="runRecommend">拉取平台推荐</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border empty-text="没有符合条件的候选人">
      <el-table-column prop="candidate.id" label="ID" width="60" />
      <el-table-column prop="candidate.name" label="候选人" width="100" />
      <el-table-column label="简历快照" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.candidate.snapshot">{{ snapshotSummary(row.candidate.snapshot) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="星级" width="190">
        <template #default="{ row }">
          <template v-if="row.candidate.star">
            <el-tag :type="starTagOf(row.candidate.star)" size="small">
              {{ starTextOf(row.candidate.star) }}
            </el-tag>
            <el-tooltip
              v-if="row.latestScore && row.latestScore.reason"
              :content="row.latestScore.reason"
              placement="top"
              popper-class="reason-tooltip"
            >
              <span class="score-detail">详情</span>
            </el-tooltip>
          </template>
          <template v-else-if="row.latestScore">
            <el-tag type="info" size="small">旧分 {{ row.latestScore.score }}</el-tag>
            <el-tooltip v-if="row.latestScore.reason" :content="row.latestScore.reason" placement="top" popper-class="reason-tooltip">
              <span class="score-detail">详情</span>
            </el-tooltip>
          </template>
          <el-tag v-else type="info" size="small">待评分</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="打招呼" width="150">
        <template #default="{ row }">
          <template v-if="row.greeting">
            <el-tooltip :content="`关联猎聘职位: ${row.greeting.liepinJobId || '无(历史记录)'}`">
              <el-tag :type="tagOf(GREETING_STATUS, row.greeting.status)" size="small">{{ textOf(GREETING_STATUS, row.greeting.status) }}</el-tag>
            </el-tooltip>
          </template>
          <el-tag v-else type="info" size="small">未联系</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="简历" width="100">
        <template #default="{ row }">
          <el-tag v-if="row.resumeFile" type="success" size="small">已入库</el-tag>
          <el-tag v-else type="info" size="small">未入库</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="招聘状态" width="110">
        <template #default="{ row }">
          <el-tag :type="tagOf(RECRUIT_STATUS, row.candidate.recruitStatus)" size="small">
            {{ textOf(RECRUIT_STATUS, row.candidate.recruitStatus) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="activeTab === 'received'" label="最后查看" width="130">
        <template #default="{ row }">
          <span class="last-viewed">{{ lastViewedOf(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column v-if="activeTab === 'received'" label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <template v-if="row.candidate.passStatus === 'HOLD'">
            <el-button link type="danger" @click="resolveVeto(row, 'confirm')">确认淘汰</el-button>
            <el-button link type="success" @click="resolveVeto(row, 'reject')">驳回恢复</el-button>
          </template>
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
          <el-button v-if="isAdmin" link type="primary" @click="redo(row.candidate.id)">重新打分</el-button>
        </template>
      </el-table-column>
    </el-table>
    <CandidateDrawer v-model="drawerVisible" :candidate-id="drawerId" @updated="load()" />
    <el-pagination
      class="pagination"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :current-page="pageNo"
      @current-change="load"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { jdApi, candidateApi, recruitApi, searchTaskApi, autoRecruitApi } from '../api/modules'
import CandidateDrawer from '../components/CandidateDrawer.vue'
import { GREETING_STATUS, RECRUIT_STATUS, textOf, tagOf, optionsOf, starTextOf, starTagOf } from '../utils/labels'

// 待分配视图仅 ADMIN 可见:后端 unassigned=true 亦仅对 ADMIN 生效(评审 I-1)
const isAdmin = computed(() => localStorage.getItem('role') === 'ADMIN')

const rows = ref([])
const jds = ref([])
const selectedJdId = ref(null)
const filterStatus = ref('')
const filterStar = ref(null)
const filterRecruit = ref('')
const recruitOptions = optionsOf(RECRUIT_STATUS)
const activeTab = ref('received')
const total = ref(0)
const pageNo = ref(1)
const pageSize = 10
const loading = ref(false)

// ---------- 详情抽屉(三区:基本信息/AI 评分/简历资料) ----------
const drawerVisible = ref(false)
const drawerId = ref(null)

function openDetail(row) {
  drawerId.value = row.candidate.id
  drawerVisible.value = true
}

function lastViewedOf(row) {
  const c = row.candidate
  if (!c.resumeLastViewedAt) return '未读'
  const isMe = row.lastViewedByName && row.lastViewedByName === localStorage.getItem('username')
  const viewer = isMe ? '我' : (row.lastViewedByName || '他人')
  return `${viewer} · ${String(c.resumeLastViewedAt).slice(5, 16).replace('T', ' ')}`
}

async function loadJds() {
  const res = await jdApi.page({ pageNo: 1, pageSize: 100 })
  jds.value = res.data.records
  if (jds.value.length > 0 && !selectedJdId.value) {
    selectedJdId.value = jds.value[0].id
  }
}

function onTabChange() {
  load(1)
}

async function load(page = 1) {
  pageNo.value = page
  loading.value = true
  try {
    const params = {
      pageNo: pageNo.value,
      pageSize,
      passStatus: filterStatus.value || undefined,
      star: filterStar.value || undefined,
      recruitStatus: filterRecruit.value || undefined
    }
    if (activeTab.value === 'received') {
      // 已收简历:仅入库成功者;可按岗位/评分状态筛选
      params.hasResumeFile = true
      params.jdId = selectedJdId.value || undefined
    } else {
      // 待分配:无有效岗位者(含已入库附件)
      params.unassigned = true
    }
    const res = await candidateApi.page(params)
    rows.value = res.data.records
    total.value = Number(res.data.total)
  } finally {
    loading.value = false
  }
}

function snapshotSummary(snapshot) {
  try {
    const s = JSON.parse(snapshot)
    return [s.title, s.salary, s.city, s.experience, s.company].filter(Boolean).join(' | ')
  } catch {
    return snapshot
  }
}

async function runScore() {
  const res = await recruitApi.score({ jdId: selectedJdId.value, limit: 10 })
  ElMessage.success(`评分完成: ${res.data.scored} 人,通过 ${res.data.passed} 人`)
  load()
}

async function runGreet() {
  const res = await recruitApi.greet({ jdId: selectedJdId.value, limit: 10 })
  ElMessage.success(`打招呼完成: ${res.data.greeted} 人`)
  load()
}

async function runCollect() {
  const res = await recruitApi.collect({ jdId: selectedJdId.value, limit: 50 })
  ElMessage.success(`检测处理: ${res.data.processed} 人`)
  load()
}

async function redo(candidateId) {
  await recruitApi.redo(candidateId)
  ElMessage.success('已重新打分')
  load()
}

/** 疑似否决改判(2026-09-29):confirm=确认淘汰;reject=驳回并按星级恢复 */
async function resolveVeto(row, action) {
  const tip = action === 'confirm'
    ? `确认淘汰候选人「${row.candidate.name || row.candidate.id}」?该操作将其置为未通过。`
    : `驳回疑似否决,按星级恢复「${row.candidate.name || row.candidate.id}」的评分结论?`
  await ElMessageBox.confirm(tip, action === 'confirm' ? '确认淘汰' : '驳回恢复',
    { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' })
  await candidateApi.resolveVeto(row.candidate.id, action)
  ElMessage.success(action === 'confirm' ? '已确认淘汰' : '已驳回并按星级恢复')
  load()
}

// ---------- 自动招聘操作(仅 ADMIN;手动不受开关限制) ----------
const advancedVisible = ref(false)
const runOnceLoading = ref(false)

async function runOnce() {
  try {
    await ElMessageBox.confirm(
      '将立即执行一轮自动招聘（检测回复 / 评分 / 打招呼 / 推荐），耗时可能较长，确认执行？',
      '执行确认',
      { type: 'warning', confirmButtonText: '立即执行', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户取消
  }
  runOnceLoading.value = true
  try {
    await autoRecruitApi.runOnce()
    ElMessage.success('一轮已执行完成')
    load()
  } catch {
    // 拦截器已提示(如“已有轮次正在运行”)
  } finally {
    runOnceLoading.value = false
  }
}

// ---------- 简历查看已迁入详情抽屉(应用内预览 + 读标记) ----------

const recommendLoading = ref(false)

async function runRecommend() {
  recommendLoading.value = true
  try {
    await searchTaskApi.createRecommend({ jdId: selectedJdId.value, accountId: 1 })
    await searchTaskApi.tick()
    ElMessage.success('平台推荐任务已入队,稍后刷新查看候选人')
  } finally {
    recommendLoading.value = false
  }
}

onMounted(async () => {
  await loadJds()
  await load()
})
</script>

<style scoped>
.toolbar {
  margin-bottom: 12px;
  display: flex;
  gap: 8px;
}
.pagination {
  margin-top: 12px;
  justify-content: flex-end;
}
.score-detail {
  margin-left: 6px;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
}
.score-stars {
  color: #e6a23c;
  margin-right: 6px;
  font-size: 13px;
  letter-spacing: 1px;
}
.last-viewed {
  font-size: 12px;
  color: var(--hr-text-3);
}
.tab-hint {
  color: var(--hr-text-3);
  font-size: 12px;
  align-self: center;
}
.advanced-panel {
  margin: -4px 0 12px;
  display: flex;
  gap: 8px;
}
</style>

<style>
/* tooltip 挂载在 body,需非 scoped 样式;限制超长评分理由的展示宽度 */
.reason-tooltip {
  max-width: 420px;
  line-height: 1.6;
}
</style>
