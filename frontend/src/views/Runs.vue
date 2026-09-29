<template>
  <div>
    <div class="toolbar">
      <span class="hint">自动招聘每轮的运行结果（启动/手动触发都会记录）；历史不回溯，自本版上线起记录。</span>
      <el-button :loading="loading" @click="load()">刷新</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" border empty-text="暂无运行记录">
      <el-table-column label="结束时间" width="160">
        <template #default="{ row }">{{ fmt(row.finishedAt) }}</template>
      </el-table-column>
      <el-table-column label="模式" width="110">
        <template #default="{ row }">{{ ROUND_MODE[row.mode] || row.mode }}</template>
      </el-table-column>
      <el-table-column label="评分" width="80" prop="scored" />
      <el-table-column label="打招呼" width="90" prop="greeted" />
      <el-table-column label="推荐" width="80" prop="recommended" />
      <el-table-column label="检测会话" width="90" prop="polled" />
      <el-table-column label="错误" width="80" prop="errors" />
      <el-table-column label="状态" min-width="160">
        <template #default="{ row }">
          <el-tag v-if="row.riskStopped" type="danger" size="small">风控停轮</el-tag>
          <el-tag v-else-if="row.noAccount" type="warning" size="small">无可用账号</el-tag>
          <el-tag v-else-if="row.errors > 0" type="warning" size="small">有错误</el-tag>
          <el-tag v-else type="success" size="small">正常</el-tag>
          <el-tag v-if="row.mode === 'collectOnly'" type="info" size="small" class="ml6">外发关闭</el-tag>
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
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { autoRecruitApi } from '../api/modules'
import { ROUND_MODE } from '../utils/labels'

const rows = ref([])
const total = ref(0)
const pageNo = ref(1)
const pageSize = 20
const loading = ref(false)

async function load(page = 1) {
  pageNo.value = page
  loading.value = true
  try {
    const res = await autoRecruitApi.rounds({ pageNo: pageNo.value, pageSize })
    rows.value = res.data.records
    total.value = Number(res.data.total)
  } finally {
    loading.value = false
  }
}

function fmt(t) {
  return t ? String(t).slice(5, 16).replace('T', ' ') : '-'
}

onMounted(() => load())
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.hint {
  font-size: 12px;
  color: var(--hr-text-3);
}
.pagination {
  margin-top: 12px;
  justify-content: flex-end;
}
.ml6 {
  margin-left: 6px;
}
</style>
