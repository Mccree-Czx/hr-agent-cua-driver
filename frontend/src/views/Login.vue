<template>
  <div class="login-page">
    <div class="brand-panel">
      <div class="brand-logo">HR Agent</div>
      <div class="brand-title">好的人才，<br />值得更快被看见。</div>
      <div class="brand-sub">岗位发布、自动打分、主动沟通与简历回收，一处清晰掌握。</div>
      <div class="brand-foot">内部工作区 · 数据仅供团队使用</div>
    </div>
    <div class="form-panel">
      <el-card class="login-card" shadow="never">
        <div class="login-title">登录</div>
        <div class="login-sub">使用你的工作区账号登录</div>
        <el-form :model="form" @keyup.enter="handleLogin">
          <el-form-item>
            <el-input v-model="form.username" placeholder="账号" size="large" />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.password" type="password" placeholder="密码" size="large" show-password />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" size="large" style="width: 100%" :loading="loading" @click="handleLogin">
              登 录
            </el-button>
          </el-form-item>
        </el-form>
      </el-card>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authApi } from '../api/modules'

const router = useRouter()
const loading = ref(false)
const form = reactive({ username: '', password: '' })

async function handleLogin() {
  if (!form.username || !form.password) return
  loading.value = true
  try {
    const res = await authApi.login(form)
    localStorage.setItem('token', res.data.token)
    localStorage.setItem('role', res.data.role)
    localStorage.setItem('username', res.data.username)
    router.push('/')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
}
/* 品牌区:深绿渐变(主色体系),窄屏隐藏 */
.brand-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
  padding: 0 72px;
  background: linear-gradient(160deg, var(--hr-brand) 0%, var(--hr-brand-hover) 100%);
  color: #fff;
}
.brand-logo {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 1px;
  margin-bottom: 28px;
}
.brand-title {
  font-size: 40px;
  font-weight: 700;
  line-height: 1.3;
}
.brand-sub {
  font-size: 15px;
  color: rgba(255, 255, 255, 0.85);
}
.brand-foot {
  margin-top: 40px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}
.form-panel {
  width: 520px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--hr-bg);
}
.login-card {
  width: 380px;
  border-radius: var(--hr-radius);
}
.login-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--hr-text-1);
}
.login-sub {
  font-size: 13px;
  color: var(--hr-text-3);
  margin: 6px 0 22px;
}
@media (max-width: 900px) {
  .brand-panel {
    display: none;
  }
  .form-panel {
    width: 100%;
  }
}
</style>
