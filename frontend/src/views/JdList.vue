<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" @click="openCreate">新增岗位</el-button>
      <el-button type="warning" :loading="syncing" @click="handleSync">同步猎聘职位</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="title" label="岗位名称" min-width="150" />
      <el-table-column label="薪资" width="140">
        <template #default="{ row }">
          <span v-if="row.salaryMin || row.salaryMax">{{ (row.salaryMin || 0) / 1000 }}K - {{ (row.salaryMax || 0) / 1000 }}K·{{ row.salaryMonths || 13 }}薪</span>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="城市" width="110">
        <template #default="{ row }">
          <span>{{ row.city || '-' }}{{ row.district ? '-' + row.district : '' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">
            {{ row.status === 'ACTIVE' ? '招聘中' : '已关闭' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="source" label="来源" width="95">
        <template #default="{ row }">
          <el-tag :type="row.source === 'SYNCED' ? 'warning' : 'info'" size="small">
            {{ row.source === 'SYNCED' ? '猎聘同步' : '系统创建' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="评分偏好" width="130">
        <template #default="{ row }">
          <el-tag v-if="row.scoringPrefConfirmedAt" type="success" size="small">已确认 {{ row.minCommStar || 3 }} 星</el-tag>
          <el-tag v-else type="warning" size="small">偏好待确认</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="猎聘发布" width="150">
        <template #default="{ row }">
          <el-tooltip v-if="row.publishStatus === 'FAILED'" :content="row.publishError || '发布失败'">
            <el-tag type="danger" size="small">发布失败</el-tag>
          </el-tooltip>
          <el-tag v-else-if="row.publishStatus === 'PUBLISHED'" type="success" size="small">
            已发布 #{{ row.liepinJobId }}
          </el-tag>
          <el-tag v-else-if="row.publishStatus === 'PUBLISHING'" type="warning" size="small">发布中</el-tag>
          <el-tag v-else type="info" size="small">未发布</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间" width="160" />
      <el-table-column label="操作" width="420" fixed="right">
        <template #default="{ row }">
          <el-button link type="warning" :disabled="row.publishStatus === 'PUBLISHED' || row.publishStatus === 'PUBLISHING'" :loading="row._publishing" @click="handlePublish(row)">发布到猎聘</el-button>
          <el-button link type="primary" @click="openPreference(row)">评分偏好</el-button>
          <el-button link type="primary" @click="openCommunication(row)">筛选与沟通</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" :loading="row._deleting" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      class="pagination"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :current-page="pageNo"
      @current-change="load"
    />

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑岗位' : '新增岗位'" width="640px">
      <el-form :model="form" label-width="110px">
        <el-form-item label="岗位名称" required>
          <el-input v-model="form.title" />
        </el-form-item>
        <el-form-item label="对外 JD">
          <el-input v-model="form.externalJd" type="textarea" :rows="6" placeholder="发布到平台的职位描述" />
        </el-form-item>
        <el-form-item label="对内寻源备注">
          <el-input v-model="form.internalNotes" type="textarea" :rows="3" placeholder="搜索关键词、排除信号等(不外发)" />
        </el-form-item>
        <el-form-item label="城市/区">
          <el-input v-model="form.city" placeholder="如:上海" style="width: 130px" />
          <span style="margin: 0 8px">-</span>
          <el-input v-model="form.district" placeholder="如:虹口区" style="width: 130px" />
        </el-form-item>
        <el-form-item label="猎聘类别编码">
          <el-input v-model="form.jobCategory" placeholder="如 N000330(招聘经理/主管)" style="width: 260px" />
          <span class="field-hint">发布到猎聘必填:招聘主管 N000330 / HRBP N000340 / 人力资源经理 N000328 / 薪酬绩效经理 N000334</span>
        </el-form-item>
        <el-form-item label="经验/学历">
          <el-input v-model="form.experienceReq" placeholder="经验要求,如 5-10年" style="width: 160px" />
          <el-input v-model="form.degreeReq" placeholder="学历,如 本科" style="width: 120px; margin-left: 8px" />
        </el-form-item>
        <el-form-item label="薪资范围">
          <el-input-number v-model="form.salaryMin" :min="0" :step="1000" placeholder="下限" />
          <span style="margin: 0 8px">~</span>
          <el-input-number v-model="form.salaryMax" :min="0" :step="1000" placeholder="上限" />
          <span style="margin: 0 8px">·</span>
          <el-input-number v-model="form.salaryMonths" :min="12" :max="24" />
          <span style="margin-left: 4px">薪</span>
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="ACTIVE">招聘中</el-radio>
            <el-radio value="CLOSED">已关闭</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="prefDialogVisible" :title="`评分偏好 - ${prefRow?.title || ''}`" width="620px">
      <div v-if="prefRow">
        <el-alert
          v-if="prefRow.scoringPrefConfirmedAt"
          type="success"
          :closable="false"
          show-icon
          title="评分偏好已确认"
          description="该岗位允许自动外发;重新保存将覆盖当前偏好。"
          style="margin-bottom: 12px"
        />
        <el-alert
          v-else
          type="warning"
          :closable="false"
          show-icon
          title="评分偏好待确认"
          description="未确认评分偏好的岗位禁止一切自动外发(仅收集来信与附件)。"
          style="margin-bottom: 12px"
        />
        <el-form label-width="120px">
          <el-form-item label="最低主动沟通星级">
            <el-select v-model="prefForm.minCommStar" style="width: 160px">
              <el-option v-for="n in 5" :key="n" :value="n" :label="`${n} 星`" />
            </el-select>
            <span class="field-hint">≥该星级自动打招呼要简历(默认 3 星=基本符合)</span>
          </el-form-item>
          <el-form-item label="加分点">
            <el-input v-model="prefForm.bonusPoints" type="textarea" :rows="3" placeholder="选填,每行一项(≤10 行、每行 ≤50 字)" />
          </el-form-item>
          <el-form-item label="一票否决点">
            <el-input v-model="prefForm.vetoPoints" type="textarea" :rows="3" placeholder="选填,每行一项;命中后进入人工复核,不直接淘汰" />
          </el-form-item>
          <el-form-item label="其他要求">
            <el-input v-model="prefForm.otherRequirements" type="textarea" :rows="3" placeholder="选填,每行一项" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="prefDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="prefSaving" @click="handleSavePreference">保存并确认</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="drawerVisible" :title="`筛选与沟通 - ${drawerRow?.title || ''}`" size="62%">
      <el-table :data="drawerRows" v-loading="drawerLoading" border>
        <el-table-column prop="candidate.name" label="姓名" width="100" />
        <el-table-column label="星级" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.candidate.star" :type="starTagOf(row.candidate.star)" size="small">
              {{ starTextOf(row.candidate.star) }}
            </el-tag>
            <el-tag v-else-if="row.latestScore && row.latestScore.score" type="info" size="small">旧分 {{ row.latestScore.score }}</el-tag>
            <el-tag v-else type="info" size="small">待评分</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="pass状态" width="100">
          <template #default="{ row }">
            <el-tag :type="tagOf(PASS_STATUS, row.candidate.passStatus)" size="small">{{ textOf(PASS_STATUS, row.candidate.passStatus) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="否决/加分" min-width="160">
          <template #default="{ row }">
            <el-tooltip v-if="vetoListOf(row).length" :content="vetoTextOf(row)">
              <el-tag type="danger" size="small">疑似否决 {{ vetoListOf(row).length }}</el-tag>
            </el-tooltip>
            <el-tag v-else-if="bonusListOf(row).length" type="success" size="small">加分 {{ bonusListOf(row).length }}</el-tag>
            <span v-else style="color: var(--hr-text-3)">-</span>
          </template>
        </el-table-column>
        <el-table-column label="打招呼状态" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.greeting" :type="greetTagType(row.greeting.status)" size="small">{{ greetText(row.greeting.status) }}</el-tag>
            <el-tag v-else type="info" size="small">未联系</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="附件状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.resumeFile" type="success" size="small">已入库</el-tag>
            <el-tag v-else type="info" size="small">未入库</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        class="pagination"
        layout="total, prev, pager, next"
        :total="drawerTotal"
        :page-size="drawerPageSize"
        :current-page="drawerPage"
        @current-change="loadDrawer"
      />
    </el-drawer>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { jdApi, candidateApi } from '../api/modules'
import { PASS_STATUS, textOf, tagOf, starTextOf, starTagOf, parseJsonList } from '../utils/labels'

const rows = ref([])
const total = ref(0)
const pageNo = ref(1)
const pageSize = 10
const loading = ref(false)
const saving = ref(false)
const syncing = ref(false)
const dialogVisible = ref(false)
const editingId = ref(null)
const emptyForm = {
  title: '', externalJd: '', internalNotes: '',
  city: '', district: '', jobCategory: '', experienceReq: '', degreeReq: '',
  salaryMin: null, salaryMax: null, salaryMonths: 13, status: 'ACTIVE'
}
const form = reactive({ ...emptyForm })

// 评分偏好弹窗(2026-09-29 星级模型;保存=确认→放行该岗位自动外发)
const prefDialogVisible = ref(false)
const prefRow = ref(null)
const prefSaving = ref(false)
const prefForm = reactive({ minCommStar: 3, bonusPoints: '', vetoPoints: '', otherRequirements: '' })

// 筛选与沟通抽屉(该岗位候选人)
const drawerVisible = ref(false)
const drawerRow = ref(null)
const drawerRows = ref([])
const drawerTotal = ref(0)
const drawerPage = ref(1)
const drawerPageSize = 10
const drawerLoading = ref(false)

async function load(page = 1) {
  pageNo.value = page
  loading.value = true
  try {
    const res = await jdApi.page({ pageNo: pageNo.value, pageSize })
    rows.value = res.data.records
    total.value = Number(res.data.total)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  Object.assign(form, emptyForm)
  dialogVisible.value = true
}

function openEdit(row) {
  editingId.value = row.id
  Object.assign(form, row)
  dialogVisible.value = true
}

async function handleSave() {
  if (!form.title) {
    ElMessage.warning('请填写岗位名称')
    return
  }
  saving.value = true
  try {
    if (editingId.value) {
      await jdApi.update(editingId.value, form)
    } else {
      await jdApi.create(form)
    }
    ElMessage.success('保存成功')
    dialogVisible.value = false
    load(pageNo.value)
  } finally {
    saving.value = false
  }
}

async function handleDelete(row) {
  const liepinTip = row.liepinJobId
    ? `\n将同时删除猎聘上的职位(#${row.liepinJobId}),此操作不可撤销!`
    : ''
  await ElMessageBox.confirm(
    `确定删除岗位「${row.title}」?${liepinTip}`,
    '删除确认',
    { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
  )
  row._deleting = true
  try {
    await jdApi.remove(row.id)
    ElMessage.success(row.liepinJobId ? '已删除(含猎聘职位)' : '已删除')
    load(pageNo.value)
  } finally {
    row._deleting = false
  }
}

async function handlePublish(row) {
  await ElMessageBox.confirm(
    `将把「${row.title}」发布到猎聘平台(对外公开可见,不可撤销),确定发布?`,
    '发布确认',
    { type: 'warning', confirmButtonText: '确认发布', cancelButtonText: '取消' }
  )
  row._publishing = true
  try {
    const res = await jdApi.publish(row.id)
    ElMessage.success(`已发布到猎聘,职位ID: ${res.data.liepinJobId}`)
    load(pageNo.value)
  } finally {
    row._publishing = false
  }
}

async function handleSync() {
  syncing.value = true
  try {
    const res = await jdApi.syncLiepin()
    ElMessage.success(`同步完成:新增 ${res.data.created} 个,更新 ${res.data.updated} 个(共 ${res.data.total} 个)`)
    load(1)
  } finally {
    syncing.value = false
  }
}

/** 打开评分偏好弹窗(读取当前偏好) */
async function openPreference(row) {
  prefRow.value = row
  const res = await jdApi.scoringPreference(row.id)
  const data = res.data || {}
  prefForm.minCommStar = data.minCommStar || 3
  prefForm.bonusPoints = data.bonusPoints || ''
  prefForm.vetoPoints = data.vetoPoints || ''
  prefForm.otherRequirements = data.otherRequirements || ''
  prefDialogVisible.value = true
}

/** 保存并确认(后端校验 ≤10 行/≤50 字;保存即确认→放行外发) */
async function handleSavePreference() {
  if (!prefRow.value) return
  prefSaving.value = true
  try {
    await jdApi.saveScoringPreference(prefRow.value.id, { ...prefForm })
    ElMessage.success('评分偏好已保存并确认,该岗位已放行自动外发')
    prefDialogVisible.value = false
    load(pageNo.value)
  } finally {
    prefSaving.value = false
  }
}

async function openCommunication(row) {
  drawerRow.value = row
  drawerVisible.value = true
  await loadDrawer(1)
}

async function loadDrawer(page = 1) {
  if (!drawerRow.value) return
  drawerPage.value = page
  drawerLoading.value = true
  try {
    const res = await candidateApi.page({
      pageNo: drawerPage.value,
      pageSize: drawerPageSize,
      jdId: drawerRow.value.id
    })
    drawerRows.value = res.data.records
    drawerTotal.value = Number(res.data.total)
  } finally {
    drawerLoading.value = false
  }
}

/** 否决/加分命中列表(JSON 文本容错解析) */
function vetoListOf(row) {
  return parseJsonList(row.latestScore && row.latestScore.vetoSuspects)
}
function bonusListOf(row) {
  return parseJsonList(row.latestScore && row.latestScore.bonusHits)
}
function vetoTextOf(row) {
  return vetoListOf(row).map((v) => v.point || v).join('; ')
}
function greetTagType(status) {
  return { SENT: 'primary', AGREED: 'success', REQUESTED: 'warning', PENDING_CONFIRM: 'info', SEND_FAILED: 'danger' }[status] || 'info'
}
function greetText(status) {
  return { SENT: '已打招呼', AGREED: '候选人已同意', REQUESTED: '已索要简历', PENDING_CONFIRM: '待确认', SEND_FAILED: '发送失败' }[status] || status
}

onMounted(() => load())
</script>

<style scoped>
.toolbar {
  margin-bottom: 12px;
}
.pagination {
  margin-top: 12px;
  justify-content: flex-end;
}
.field-hint {
  margin-left: 8px;
  color: var(--hr-text-3);
  font-size: 12px;
}
</style>
