/**
 * 枚举中文标签单一映射表（参照 HR Portal V2 约定：持久化枚举保持英文，中文标签集中于此）。
 * 列表 / 详情抽屉 / 驾驶舱 / 运行日志统一从这里取值，禁止散落硬编码。
 */

export const GREETING_STATUS = {
  SENT: { label: '已打招呼', tag: 'primary' },
  AGREED: { label: '候选人已同意', tag: 'success' },
  REQUESTED: { label: '已索要简历', tag: 'warning' },
  PENDING_CONFIRM: { label: '待确认', tag: 'info' },
  SEND_FAILED: { label: '发送失败', tag: 'danger' }
}

export const RECRUIT_STATUS = {
  PENDING_REVIEW: { label: '待筛选', tag: 'info' },
  QUALIFIED: { label: '合格', tag: 'success' },
  INTERVIEW_SCHEDULED: { label: '已约面', tag: 'warning' },
  NOT_SUITABLE: { label: '不合适', tag: 'danger' }
}

/** 评分结论状态(2026-09-29 星级模型:≥3星 PASS/2星 KEPT 留库/1星 FAIL/疑似否决 HOLD) */
export const PASS_STATUS = {
  PASS: { label: '通过', tag: 'success' },
  FAIL: { label: '未通过', tag: 'danger' },
  KEPT: { label: '留库', tag: 'warning' },
  HOLD: { label: '疑似否决', tag: 'warning' },
  PENDING: { label: '待评分', tag: 'info' }
}

export const ROUND_MODE = {
  full: '完整轮',
  collectOnly: '只收模式'
}

/** 取中文标签（未知值回退原值/占位符） */
export function textOf(map, value, fallback = '-') {
  if (value === null || value === undefined || value === '') return fallback
  return map[value]?.label || String(value)
}

/** 取标签样式（Element tag type） */
export function tagOf(map, value, fallback = 'info') {
  return map[value]?.tag || fallback
}

/** 生成下拉选项（value/label） */
export function optionsOf(map) {
  return Object.entries(map).map(([value, meta]) => ({ value, label: meta.label }))
}

/** 星级显示(★ 重复;1-5;无星级返回空串) */
export function starTextOf(star) {
  if (star === null || star === undefined || star === '') return ''
  const n = Number(star)
  if (Number.isNaN(n) || n < 1) return ''
  return '★'.repeat(Math.min(5, Math.round(n)))
}

/** 星级标签类型(≥3 绿 / 2 黄 / 1 红) */
export function starTagOf(star) {
  const n = Number(star)
  if (Number.isNaN(n) || n < 1) return 'info'
  return n >= 3 ? 'success' : n === 2 ? 'warning' : 'danger'
}

/** JSON 文本数组解析(否决/加分命中;容错返回空数组) */
export function parseJsonList(text) {
  if (!text) return []
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** 文件大小格式化 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '-'
  const n = Number(bytes)
  if (Number.isNaN(n)) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
