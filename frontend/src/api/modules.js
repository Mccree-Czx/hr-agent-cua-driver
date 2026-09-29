import http from './index'

export const authApi = {
  login: (data) => http.post('/auth/login', data),
  me: () => http.get('/auth/me')
}

export const jdApi = {
  page: (params) => http.get('/jd', { params }),
  get: (id) => http.get(`/jd/${id}`),
  create: (data) => http.post('/jd', data),
  update: (id, data) => http.put(`/jd/${id}`, data),
  remove: (id) => http.delete(`/jd/${id}`),
  publish: (id) => http.post(`/jd/${id}/publish`),
  syncLiepin: () => http.post('/jd/sync-liepin'),
  suggestThreshold: (id) => http.post(`/jd/${id}/threshold/suggest`),
  confirmThreshold: (id, threshold) => http.put(`/jd/${id}/threshold/confirm`, { threshold }),
  // 评分偏好(2026-09-29 星级模型):读取 / 保存并确认(保存=确认→放行外发;仅 ADMIN)
  scoringPreference: (id) => http.get(`/jd/${id}/scoring-preference`),
  saveScoringPreference: (id, data) => http.put(`/jd/${id}/scoring-preference`, data)
}

export const accountApi = {
  page: (params) => http.get('/account', { params }),
  create: (data) => http.post('/account', data),
  update: (id, data) => http.put(`/account/${id}`, data),
  remove: (id) => http.delete(`/account/${id}`),
  login: (id) => http.post(`/account/${id}/login`),
  loginStatus: (id) => http.get(`/account/${id}/login-status`)
}

export const userApi = {
  page: (params) => http.get('/user', { params }),
  create: (data) => http.post('/user', data),
  update: (id, data) => http.put(`/user/${id}`, data),
  remove: (id) => http.delete(`/user/${id}`)
}

export const auditApi = {
  logs: (params) => http.get('/audit/logs', { params })
}

export const candidateApi = {
  page: (params) => http.get('/candidate', { params }),
  // 简历下载(blob):HR 按分配岗位授权;前端转 objectURL 预览
  resumeBlob: (id) => http.get(`/candidate/${id}/resume`, { responseType: 'blob' }),
  // 详情抽屉三区(基本信息/AI 评分/简历资料)
  detail: (id) => http.get(`/candidate/${id}/detail`),
  // 招聘跟进状态(HR 工作流:待筛选/合格/已约面/不合适)
  setRecruitStatus: (id, recruitStatus) => http.patch(`/candidate/${id}/recruit-status`, { recruitStatus }),
  // 疑似否决改判(2026-09-29):confirm=确认淘汰;reject=驳回按星级恢复
  resolveVeto: (id, action) => http.patch(`/candidate/${id}/veto`, { action }),
  // 在线简历(实时拉取平台详情;CLI 最长达 3 分钟,关闭 axios 超时)
  onlineResume: (id) => http.post(`/candidate/${id}/online-resume`, null, { timeout: 0 })
}

export const autoRecruitApi = {
  status: () => http.get('/auto-recruit/status'),
  setEnabled: (data) => http.put('/auto-recruit/enabled', data),
  // 手动一轮为同步执行(可能耗时较长),关闭 axios 超时
  runOnce: () => http.post('/auto-recruit/run-once', null, { timeout: 0 }),
  // 运行历史(轮次摘要,倒序分页;ADMIN)
  rounds: (params) => http.get('/auto-recruit/rounds', { params })
}

export const dashboardApi = {
  // 驾驶舱聚合(按当前用户授权岗位范围过滤)
  summary: () => http.get('/dashboard/summary')
}

export const recruitApi = {
  score: (data) => http.post('/recruit/score', data),
  redo: (candidateId) => http.post(`/recruit/score/${candidateId}/redo`),
  greet: (data) => http.post('/recruit/greet', data),
  collect: (data) => http.post('/recruit/collect', data)
}

export const searchTaskApi = {
  create: (data) => http.post('/search-task', data),
  createRecommend: (data) => http.post('/search-task/recommend', data),
  page: (params) => http.get('/search-task', { params }),
  tick: () => http.post('/search-task/tick')
}

export const userJdApi = {
  list: (userId) => http.get(`/user/${userId}/jd`),
  assign: (userId, jdId) => http.post(`/user/${userId}/jd/${jdId}`),
  unassign: (userId, jdId) => http.delete(`/user/${userId}/jd/${jdId}`)
}
