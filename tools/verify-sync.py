#!/usr/bin/env python3
"""验证职位同步(猎聘在招职位 → 系统岗位管理)"""
import json
import urllib.request

BASE = 'http://localhost:8080/api'


def req(method, path, data=None, token=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(f'{BASE}{path}', data=body, method=method)
    r.add_header('Content-Type', 'application/json')
    if token:
        r.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read())


token = req('POST', '/auth/login', {'username': 'admin', 'password': 'admin123'})['data']['token']
print('登录 OK')

# 同步猎聘职位
result = req('POST', '/jd/sync-liepin', token=token)
print(f"同步结果: 新增 {result['data']['created']} 个, 更新 {result['data']['updated']} 个, 共 {result['data']['total']} 个")

# 查看岗位列表
page = req('GET', '/jd?pageNo=1&pageSize=20', token=token)['data']
print(f'\n系统岗位管理共 {page["total"]} 个:')
for r in page['records']:
    src = '猎聘同步' if r.get('source') == 'SYNCED' else '系统创建'
    pub = f"#{r.get('liepinJobId')}" if r.get('liepinJobId') else '-'
    city = f"{r.get('city') or ''}-{r.get('district') or ''}".strip('-')
    salary = f"{int((r.get('salaryMin') or 0) / 1000)}-{int((r.get('salaryMax') or 0) / 1000)}K" if r.get('salaryMin') else '-'
    print(f"  [{src}] {r['title'][:30]} | {city} | {salary} | 猎聘: {pub}")
