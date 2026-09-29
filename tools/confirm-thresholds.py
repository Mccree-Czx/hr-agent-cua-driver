#!/usr/bin/env python3
"""为全部在招岗位生成 AI 门槛建议并确认(记录确认人)。"""
import json
import urllib.request

BASE = 'http://localhost:8080/api'


def req(method, path, data=None, token=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(f'{BASE}{path}', data=body, method=method)
    r.add_header('Content-Type', 'application/json')
    if token:
        r.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(r, timeout=180) as resp:
        return json.loads(resp.read())


token = req('POST', '/auth/login', {'username': 'admin', 'password': 'admin123'})['data']['token']
jobs = req('GET', '/jd?pageNo=1&pageSize=20', token=token)['data']['records']
print(f"在招岗位 {len(jobs)} 个,开始生成建议...\n")
for jd in jobs:
    title = jd['title']
    try:
        suggestion = req('POST', f"/jd/{jd['id']}/threshold/suggest", token=token)['data']
    except Exception as e:
        print(f"[{title}] 建议生成失败: {e}")
        continue
    # 从建议文本提取数字并确认
    text = suggestion if isinstance(suggestion, str) else json.dumps(suggestion, ensure_ascii=False)
    import re
    m = re.search(r'\d+', text)
    if not m:
        print(f"[{title}] 建议无可解析数值: {text[:80]}")
        continue
    threshold = int(m.group())
    req('PUT', f"/jd/{jd['id']}/threshold/confirm", {'threshold': threshold}, token=token)
    print(f"[{title}] 建议={threshold}分 | 已确认\n    {text[:200]}\n")
print("全部完成")
