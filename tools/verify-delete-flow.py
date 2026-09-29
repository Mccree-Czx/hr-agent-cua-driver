#!/usr/bin/env python3
"""删除同步闭环验证:发布临时职位 → 系统创建 JD 并关联 → 系统删除 → 双端确认"""
import json
import os
import subprocess
import urllib.request

BASE = 'http://localhost:8080/api'
CLI_ENV = {**os.environ, 'PATH': '/Users/mj/.npm-global/bin:' + os.environ.get('PATH', '')}


def req(method, path, data=None, token=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(f'{BASE}{path}', data=body, method=method)
    r.add_header('Content-Type', 'application/json')
    if token:
        r.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read())


token = req('POST', '/auth/login', {'username': 'admin', 'password': 'admin123'})['data']['token']
print('[1] 登录 OK')

# 2. 发布临时测试职位(通过 fork CLI)
data_json = json.dumps({
    'title': '测试勿投-复核验证',
    'jobCategory': 'N000330',
    'description': '系统删除同步功能闭环验证使用,验证后自动删除,请勿投递。',
    'salaryMinK': 12, 'salaryMaxK': 18,
}, ensure_ascii=False)
out = subprocess.run(
    ['liepin', 'jobpublish', '--data', data_json, '--json'],
    capture_output=True, text=True, timeout=300, env=CLI_ENV,
)
if out.returncode != 0 or '{' not in out.stdout:
    print('jobpublish 失败:', out.stdout[-500:], out.stderr[-300:])
    raise SystemExit(1)
raw = out.stdout
job = json.loads(raw[raw.index('{'):])
job_id = job['job_id']
print(f"[2] 临时职位已发布: job_id={job_id}")

# 3. 系统创建 JD 并关联该职位(模拟系统发布的岗位)
jd = req('POST', '/jd', {
    'title': '测试勿投-复核验证',
    'externalJd': '验证用',
    'salaryMin': 12000, 'salaryMax': 18000,
}, token=token)['data']
full = req('GET', f"/jd/{jd['id']}", token=token)['data']
full['liepinJobId'] = job_id
full['publishStatus'] = 'PUBLISHED'
req('PUT', f"/jd/{jd['id']}", full, token=token)
print(f"[3] 系统 JD id={jd['id']} 已关联猎聘职位 {job_id}")

# 4. 系统删除(触发同步删除猎聘)
req('DELETE', f"/jd/{jd['id']}", token=token)
print(f"[4] 系统删除完成")

# 5. 验证系统记录消失
try:
    req('GET', f"/jd/{jd['id']}", token=token)
    print('[5] !! 系统记录仍在(异常)')
except urllib.error.HTTPError as e:
    print(f"[5] 系统记录已删除 (HTTP {e.code})" if e.code == 404 else f'[5] !! 异常: {e.code}')

# 6. 验证猎聘职位消失
out2 = subprocess.run(
    ['liepin', 'joblist', '--json'],
    capture_output=True, text=True, timeout=300, env=CLI_ENV,
)
raw2 = out2.stdout
jobs = json.loads(raw2[raw2.index('['):])
remaining = [j for j in jobs if j.get('jobId') == job_id]
print(f"[6] 猎聘职位校验: {'!! 职位仍在(异常)' if remaining else '职位已从猎聘删除'}")
print(f"\n猎聘当前职位数: {len(jobs)}")
for j in jobs:
    print(f"  {j['title'][:26]} | {j['status']} | {j['jobId']}")
