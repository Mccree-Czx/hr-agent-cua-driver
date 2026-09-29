<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" @click="openCreate">新增账号</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="name" label="账号备注名" min-width="140" />
      <el-table-column prop="userDataDir" label="user-data-dir" min-width="200" show-overflow-tooltip />
      <el-table-column prop="loginStatus" label="登录态" width="110">
        <template #default="{ row }">
          <el-tag :type="statusType(row.loginStatus)">{{ statusText(row.loginStatus) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="greetMode" label="打招呼模式" width="110">
        <template #default="{ row }">{{ row.greetMode === 'MANUAL' ? '人工确认' : '全自动' }}</template>
      </el-table-column>
      <el-table-column prop="dailyGreetQuota" label="每日配额" width="130">
        <template #header>
          <span>每日配额</span>
          <el-tooltip content="平台权益参考,系统不再限制">
            <span class="header-hint">?</span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="熔断" width="80">
        <template #default="{ row }">
          <el-tag v-if="row.circuitBreaker" type="danger">已熔断</el-tag>
          <el-tag v-else type="success">正常</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <el-button link type="warning" :loading="row._loginLoading" @click="handleLogin(row)">扫码登录</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
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

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑账号' : '新增账号'" width="560px">
      <el-form :model="form" label-width="130px">
        <el-form-item label="账号备注名" required>
          <el-input v-model="form.name" placeholder="如:HR-张三-账号1" />
        </el-form-item>
        <el-form-item label="user-data-dir">
          <el-input v-model="form.userDataDir" placeholder="留空则自动生成,如 /data/liepin/account1" />
        </el-form-item>
        <el-form-item label="打招呼模式">
          <el-radio-group v-model="form.greetMode">
            <el-radio value="AUTO">全自动</el-radio>
            <el-radio value="MANUAL">人工确认</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="每日打招呼配额">
          <el-input-number v-model="form.dailyGreetQuota" :min="1" :max="100" />
          <span class="field-hint">平台权益参考,系统不再限制</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { accountApi } from '../api/modules'

const rows = ref([])
const total = ref(0)
const pageNo = ref(1)
const pageSize = 10
const loading = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
const editingId = ref(null)
const form = reactive({ name: '', userDataDir: '', greetMode: 'AUTO', dailyGreetQuota: 50 })

function statusType(status) {
  return status === 'NORMAL' ? 'success' : status === 'RESTRICTED' ? 'danger' : 'warning'
}
function statusText(status) {
  return { NORMAL: '正常', NEED_SCAN: '需扫码', RESTRICTED: '受限' }[status] || status
}

async function load(page = 1) {
  pageNo.value = page
  loading.value = true
  try {
    const res = await accountApi.page({ pageNo: pageNo.value, pageSize })
    rows.value = res.data.records
    total.value = Number(res.data.total)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  Object.assign(form, { name: '', userDataDir: '', greetMode: 'AUTO', dailyGreetQuota: 50 })
  dialogVisible.value = true
}

function openEdit(row) {
  editingId.value = row.id
  Object.assign(form, row)
  dialogVisible.value = true
}

async function handleSave() {
  if (!form.name) {
    ElMessage.warning('请填写账号备注名')
    return
  }
  saving.value = true
  try {
    if (editingId.value) {
      await accountApi.update(editingId.value, form)
    } else {
      await accountApi.create(form)
    }
    ElMessage.success('保存成功')
    dialogVisible.value = false
    load(pageNo.value)
  } finally {
    saving.value = false
  }
}

async function handleDelete(row) {
  await ElMessageBox.confirm(`确定删除账号「${row.name}」?`, '确认', { type: 'warning' })
  await accountApi.remove(row.id)
  ElMessage.success('已删除')
  load(pageNo.value)
}

async function handleLogin(row) {
  row._loginLoading = true
  try {
    await accountApi.login(row.id)
    ElMessage.info('浏览器窗口已弹出,请在本机完成扫码(最长 3 分钟)')
    // 轮询登录状态直到完成
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      const res = await accountApi.loginStatus(row.id)
      row.loginStatus = res.data.loginStatus
      if (!res.data.loggingIn) {
        break
      }
    }
    const finalRes = await accountApi.loginStatus(row.id)
    row.loginStatus = finalRes.data.loginStatus
    if (row.loginStatus === 'NORMAL') {
      ElMessage.success('登录成功')
    } else {
      ElMessage.warning('登录未完成(超时或取消)')
    }
    load(pageNo.value)
  } finally {
    row._loginLoading = false
  }
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
.header-hint {
  display: inline-block;
  width: 14px;
  height: 14px;
  line-height: 14px;
  margin-left: 4px;
  text-align: center;
  border-radius: 50%;
  background: var(--hr-text-3);
  color: #fff;
  font-size: 11px;
  cursor: help;
}
</style>
