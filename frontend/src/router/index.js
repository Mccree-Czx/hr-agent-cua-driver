import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/Login.vue') },
  {
    path: '/',
    component: () => import('../views/Layout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/Dashboard.vue'), meta: { title: '驾驶舱' } },
      { path: 'jd', name: 'jd', component: () => import('../views/JdList.vue'), meta: { title: '岗位管理' } },
      { path: 'candidate', name: 'candidate', component: () => import('../views/CandidateList.vue'), meta: { title: '候选人台账' } },
      { path: 'runs', name: 'runs', component: () => import('../views/Runs.vue'), meta: { title: '运行日志', adminOnly: true } },
      { path: 'account', name: 'account', component: () => import('../views/AccountList.vue'), meta: { title: '账号管理' } },
      { path: 'user', name: 'user', component: () => import('../views/UserList.vue'), meta: { title: '用户管理', adminOnly: true } }
    ]
  }
]

const router = createRouter({
  // hash 模式:由 Spring Boot 静态托管时无需 SPA fallback 配置
  history: createWebHashHistory(),
  routes
})

router.beforeEach((to) => {
  const token = localStorage.getItem('token')
  if (to.path !== '/login' && !token) {
    return { path: '/login' }
  }
  if (to.meta.adminOnly && localStorage.getItem('role') !== 'ADMIN') {
    return { path: '/dashboard' }
  }
  return true
})

export default router
