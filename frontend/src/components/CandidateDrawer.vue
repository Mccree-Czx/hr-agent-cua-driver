<template>
  <el-drawer
    :model-value="modelValue"
    size="620px"
    :with-header="false"
    @update:model-value="(v) => $emit('update:modelValue', v)"
    @open="loadDetail"
  >
    <template v-if="detail">
      <div class="cd-header">
        <div>
          <div class="cd-name">{{ detail.candidate.name || '匿名候选人' }}</div>
          <div class="cd-meta">
            <el-tag size="small" type="info">{{ detail.jdTitle || '无岗位' }}</el-tag>
            <el-tag size="small" :type="tagOf(RECRUIT_STATUS, cur)">{{ textOf(RECRUIT_STATUS, cur) }}</el-tag>
            <el-tag v-if="detail.candidate.star" size="small" :type="starTagOf(detail.candidate.star)">
              {{ starTextOf(detail.candidate.star) }} · {{ textOf(PASS_STATUS, detail.candidate.passStatus) }}
            </el-tag>
            <el-tag v-else size="small" :type="tagOf(PASS_STATUS, detail.candidate.passStatus)">
              {{ textOf(PASS_STATUS, detail.candidate.passStatus) }}
            </el-tag>
          </div>
        </div>
        <el-button text @click="$emit('update:modelValue', false)">关闭</el-button>
      </div>

      <el-card shadow="never" class="cd-card">
        <template #header>招聘状态</template>
        <div class="cd-status-row">
          <el-button :type="cur === 'QUALIFIED' ? 'primary' : 'default'" @click="setStatus('QUALIFIED')">合格</el-button>
          <el-button :type="cur === 'INTERVIEW_SCHEDULED' ? 'warning' : 'default'" @click="setStatus('INTERVIEW_SCHEDULED')">约面</el-button>
          <el-button :type="cur === 'NOT_SUITABLE' ? 'danger' : 'default'" @click="setStatus('NOT_SUITABLE')">不合适</el-button>
          <el-button text :disabled="cur === 'PENDING_REVIEW'" @click="setStatus('PENDING_REVIEW')">恢复待筛选</el-button>
        </div>
      </el-card>

      <el-card shadow="never" class="cd-card">
        <template #header>基本信息</template>
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="来源岗位">{{ detail.jdTitle || '-' }}</el-descriptions-item>
          <el-descriptions-item label="入库时间">{{ fmt(detail.candidate.createdAt) }}</el-descriptions-item>
          <el-descriptions-item v-for="f in snapshotFields" :key="f.label" :label="f.label">{{ f.value }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-card shadow="never" class="cd-card">
        <template #header>AI 评分</template>
        <template v-if="detail.latestScore">
          <div class="cd-score-row">
            <template v-if="detail.latestScore.star">
              <span class="cd-score-num">{{ detail.latestScore.star }}</span>
              <span class="cd-stars">{{ starTextOf(detail.latestScore.star) }}</span>
            </template>
            <template v-else>
              <span class="cd-score-num">{{ detail.latestScore.score }}</span>
              <span class="cd-score-meta">旧分制记录</span>
            </template>
            <span class="cd-score-meta">{{ fmt(detail.latestScore.createdAt) }} · {{ detail.latestScore.model || '-' }}</span>
          </div>
          <div v-if="vetoList.length" class="cd-veto">
            <el-tag type="danger" size="small">疑似否决 {{ vetoList.length }}</el-tag>
            <div v-for="(v, i) in vetoList" :key="i" class="cd-veto-item">
              {{ v.point || v }}<span v-if="v.evidence" class="cd-veto-evidence">（{{ v.evidence }}）</span>
            </div>
          </div>
          <div v-else-if="bonusList.length" class="cd-bonus">
            <el-tag type="success" size="small">加分 {{ bonusList.length }}</el-tag>
            <div v-for="(b, i) in bonusList" :key="i" class="cd-bonus-item">{{ b }}</div>
          </div>
          <div class="cd-reason">{{ detail.latestScore.reason || '无评分理由' }}</div>
        </template>
        <el-empty v-else description="尚未评分" :image-size="56" />
      </el-card>

      <el-card shadow="never" class="cd-card">
        <template #header>简历资料</template>
        <div class="cd-online-row">
          <el-button type="primary" plain :loading="onlineLoading" @click="openOnlineResume">查看在线简历</el-button>
          <span class="cd-online-hint">实时拉取平台在线简历（每次查看为一次读取）</span>
        </div>
        <template v-if="detail.resumeFile">
          <div class="cd-file-row">
            <span class="cd-file-name">{{ detail.resumeFileName }}</span>
            <span class="cd-file-meta">{{ formatBytes(detail.resumeFile.size) }} · 入库 {{ fmt(detail.resumeFile.createdAt) }}</span>
          </div>
          <div class="cd-file-hint">
            最后查看：{{ lastViewedText }}
          </div>
          <div class="cd-file-actions">
            <el-button type="primary" :loading="previewLoading" @click="openPreview">预览简历</el-button>
            <el-button text type="primary" @click="openInNewTab">在新标签打开</el-button>
          </div>
          <iframe v-if="previewUrl" :src="previewUrl" class="cd-preview" title="简历预览" />
        </template>
        <el-empty v-else description="简历未入库" :image-size="56" />
      </el-card>
    </template>
    <el-skeleton v-else :rows="7" animated />
  </el-drawer>

  <el-dialog v-model="onlineVisible" title="在线简历（平台实时）" width="720px" append-to-body>
    <template v-if="onlineResume">
      <el-descriptions :column="2" size="small" border>
        <el-descriptions-item label="姓名">{{ onlineResume.name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="性别 / 年龄">{{ [onlineResume.sex, onlineResume.age].filter(Boolean).join(' · ') || '-' }}</el-descriptions-item>
        <el-descriptions-item label="城市">{{ onlineResume.city || '-' }}</el-descriptions-item>
        <el-descriptions-item label="经验 / 学历">{{ [onlineResume.experience, onlineResume.education].filter(Boolean).join(' · ') || '-' }}</el-descriptions-item>
        <el-descriptions-item label="当前公司">{{ onlineResume.current_company || '-' }}</el-descriptions-item>
        <el-descriptions-item label="行业">{{ onlineResume.industry || '-' }}</el-descriptions-item>
        <el-descriptions-item label="求职状态">{{ onlineResume.work_status || '-' }}</el-descriptions-item>
        <el-descriptions-item label="在线状态">{{ onlineResume.online_status || '-' }}</el-descriptions-item>
      </el-descriptions>
      <div class="or-title">求职期望</div>
      <el-descriptions :column="2" size="small" border>
        <el-descriptions-item label="期望职位">{{ onlineResume.want_title || '-' }}</el-descriptions-item>
        <el-descriptions-item label="期望薪资">{{ onlineResume.want_salary || '-' }}</el-descriptions-item>
        <el-descriptions-item label="期望城市">{{ onlineResume.want_city || '-' }}</el-descriptions-item>
        <el-descriptions-item label="期望行业">{{ onlineResume.want_industry || '-' }}</el-descriptions-item>
      </el-descriptions>
      <template v-if="onlineResume.work_history">
        <div class="or-title">工作经历</div>
        <div class="or-pre">{{ onlineResume.work_history }}</div>
      </template>
      <template v-if="onlineResume.education_history">
        <div class="or-title">教育经历</div>
        <div class="or-pre">{{ onlineResume.education_history }}</div>
      </template>
      <template v-if="onlineResume.skills || onlineResume.languages">
        <div class="or-title">技能与语言</div>
        <div class="or-pre">{{ [onlineResume.skills, onlineResume.languages].filter(Boolean).join('\n') }}</div>
      </template>
      <template v-if="onlineResume.self_descr">
        <div class="or-title">自我评价</div>
        <div class="or-pre">{{ onlineResume.self_descr }}</div>
      </template>
    </template>
    <el-skeleton v-else :rows="6" animated />
    <template #footer>
      <span class="or-hint">数据实时拉取，非本地缓存</span>
      <el-button @click="onlineVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { candidateApi } from '../api/modules'
import { RECRUIT_STATUS, PASS_STATUS, textOf, tagOf, starTextOf, starTagOf, parseJsonList, formatBytes } from '../utils/labels'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  candidateId: { type: [Number, String], default: null }
})
const emit = defineEmits(['update:modelValue', 'updated'])

const detail = ref(null)
const previewUrl = ref('')
const previewLoading = ref(false)
const onlineVisible = ref(false)
const onlineLoading = ref(false)
const onlineResume = ref(null)

const cur = computed(() => detail.value?.candidate?.recruitStatus || 'PENDING_REVIEW')

/** 疑似否决 / 加分命中(JSON 文本容错解析;2026-09-29) */
const vetoList = computed(() => parseJsonList(detail.value?.latestScore?.vetoSuspects))
const bonusList = computed(() => parseJsonList(detail.value?.latestScore?.bonusHits))

const lastViewedText = computed(() => {
  const c = detail.value?.candidate
  if (!c?.resumeLastViewedAt) return '未读'
  const isMe = detail.value?.lastViewedByName && detail.value.lastViewedByName === localStorage.getItem('username')
  const viewer = isMe ? '我' : (detail.value?.lastViewedByName || '他人')
  return `${viewer} · ${fmt(c.resumeLastViewedAt)}`
})

const snapshotFields = computed(() => {
  try {
    const s = JSON.parse(detail.value?.candidate?.snapshot || '{}')
    return [
      { label: '城市', value: s.city },
      { label: '薪资', value: s.salary },
      { label: '经验', value: s.experience },
      { label: '学历', value: s.degree },
      { label: '公司', value: s.company },
      { label: '职位', value: s.title }
    ].filter((f) => f.value)
  } catch {
    return []
  }
})

async function loadDetail() {
  if (!props.candidateId) return
  detail.value = null
  clearPreview()
  try {
    const res = await candidateApi.detail(props.candidateId)
    detail.value = res.data
  } catch {
    // 拦截器已提示(403/404)
  }
}

// 抽屉已打开时切换候选人:重新加载
watch(
  () => props.candidateId,
  (v) => {
    onlineVisible.value = false
    onlineResume.value = null
    if (props.modelValue && v) loadDetail()
  }
)

async function setStatus(status) {
  if (status === cur.value) return
  try {
    await candidateApi.setRecruitStatus(props.candidateId, status)
    ElMessage.success(`已标记为「${textOf(RECRUIT_STATUS, status)}」`)
    await loadDetail()
    emit('updated')
  } catch {
    // 拦截器已提示
  }
}

async function openPreview() {
  previewLoading.value = true
  try {
    const blob = await candidateApi.resumeBlob(props.candidateId)
    clearPreview()
    previewUrl.value = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
    // 预览即写入读标记:通知父级刷新"最后查看"
    emit('updated')
  } catch {
    // 拦截器已提示
  } finally {
    previewLoading.value = false
  }
}

async function openInNewTab() {
  if (!previewUrl.value) await openPreview()
  if (previewUrl.value) window.open(previewUrl.value, '_blank')
}

// 在线简历:实时拉取(一次平台读取);成功即写读标记
async function openOnlineResume() {
  onlineLoading.value = true
  try {
    const res = await candidateApi.onlineResume(props.candidateId)
    onlineResume.value = res.data
    onlineVisible.value = true
    await loadDetail()
    emit('updated')
  } catch {
    // 拦截器已提示(含风控/无可用账号等原因)
  } finally {
    onlineLoading.value = false
  }
}

function clearPreview() {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
  }
}

function fmt(t) {
  return t ? String(t).slice(0, 16).replace('T', ' ') : '-'
}

onBeforeUnmount(clearPreview)
</script>

<style scoped>
.cd-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}
.cd-name {
  font-size: 18px;
  font-weight: 600;
  color: var(--hr-text-1);
}
.cd-meta {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.cd-card {
  margin-bottom: 12px;
  border-radius: var(--hr-radius-sm);
}
.cd-status-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.cd-score-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.cd-score-num {
  font-size: 28px;
  font-weight: 700;
  color: var(--el-color-primary);
}
.cd-stars {
  color: #e6a23c;
  font-size: 16px;
  letter-spacing: 2px;
}
.cd-score-meta {
  font-size: 12px;
  color: var(--hr-text-3);
}
.cd-reason {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--hr-text-2);
  white-space: pre-wrap;
}
.cd-veto,
.cd-bonus {
  margin-top: 8px;
  font-size: 12px;
  color: var(--hr-text-2);
}
.cd-veto-item,
.cd-bonus-item {
  margin-top: 4px;
  padding-left: 8px;
  border-left: 2px solid var(--el-color-danger-light-5);
}
.cd-bonus-item {
  border-left-color: var(--el-color-success-light-5);
}
.cd-veto-evidence {
  color: var(--hr-text-3);
}
.cd-file-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.cd-file-name {
  font-weight: 600;
  color: var(--hr-text-1);
  word-break: break-all;
}
.cd-file-meta,
.cd-file-hint {
  font-size: 12px;
  color: var(--hr-text-3);
}
.cd-file-hint {
  margin-top: 4px;
}
.cd-file-actions {
  margin-top: 10px;
}
.cd-preview {
  margin-top: 12px;
  width: 100%;
  height: 560px;
  border: 1px solid var(--hr-border);
  border-radius: var(--hr-radius-sm);
}
.cd-online-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.cd-online-hint {
  font-size: 12px;
  color: var(--hr-text-3);
}
.or-title {
  margin: 14px 0 6px;
  font-weight: 600;
  color: var(--hr-text-1);
}
.or-pre {
  font-size: 13px;
  line-height: 1.7;
  color: var(--hr-text-2);
  white-space: pre-wrap;
}
.or-hint {
  float: left;
  font-size: 12px;
  color: var(--hr-text-3);
  line-height: 32px;
}
</style>
