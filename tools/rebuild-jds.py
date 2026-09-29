#!/usr/bin/env python3
"""重建两个 JD(招聘主管/人事经理)并关联已发布的猎聘职位"""
import json
import urllib.request

BASE = 'http://localhost:8080/api'


def req(method, path, data=None, token=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(f'{BASE}{path}', data=body, method=method)
    r.add_header('Content-Type', 'application/json')
    if token:
        r.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read())


token = req('POST', '/auth/login', {'username': 'admin', 'password': 'admin123'})['data']['token']
print('登录 OK')

recruit_jd = req('POST', '/jd', {
    'title': '招聘主管',
    'externalJd': '岗位职责：1、根据公司及各部门用人需求，执行招聘计划，保障岗位及时到岗；2、负责全流程招聘工作：岗位发布、筛选、邀约、背景调查、录用；3、跟进招聘数据，定期输出招聘报表；4、对接业务部门，提升人岗匹配度；5、负责人才库搭建与维护；6、协助完成入离职手续等基础人事工作。任职要求：本科及以上，5-10年招聘/人事经验，消费电子、制造业优先；熟悉招聘全流程与各类渠道；熟练使用Excel。薪资12-18K·13薪，工作地点上海虹口区。',
    'internalNotes': '招聘主管 招聘经理 HR 人力资源',
    'city': '上海', 'district': '虹口区', 'jobCategory': 'N000330',
    'experienceReq': '5-10年', 'degreeReq': '本科', 'salaryMonths': 13,
    'salaryMin': 12000, 'salaryMax': 18000,
}, token=token)['data']
print('招聘主管 JD id =', recruit_jd['id'])

hr_jd = req('POST', '/jd', {
    'title': '人事经理（绩效、企业文化方向）',
    'externalJd': '岗位职责：1、负责公司绩效管理体系的搭建、落地与持续优化；2、定期输出绩效数据分析报告，推动绩效结果与薪酬调整、职级晋升、人才盘点联动；3、负责企业文化体系的梳理、提炼与落地运营；4、运营企业文化传播阵地，开展员工敬业度与满意度调研；5、赋能各级管理者；6、完成其他人力资源专项工作。任职要求：本科及以上，3年以上人力资源全模块经验，其中至少2年绩效管理与企业文化专项经验；熟悉上海地区劳动法律法规；优秀的数据分析能力。薪资20-30K·13薪，工作地点上海虹口区。',
    'internalNotes': '人事经理 绩效管理 企业文化 HRBP',
    'city': '上海', 'district': '虹口区', 'jobCategory': 'N000328',
    'experienceReq': '3-5年', 'degreeReq': '本科', 'salaryMonths': 13,
    'salaryMin': 20000, 'salaryMax': 30000,
}, token=token)['data']
print('人事经理 JD id =', hr_jd['id'])

# 关联已发布的猎聘职位
for jd, job_id in [(recruit_jd, '85869365'), (hr_jd, '85869375')]:
    full = req('GET', f"/jd/{jd['id']}", token=token)['data']
    full['liepinJobId'] = job_id
    full['publishStatus'] = 'PUBLISHED'
    req('PUT', f"/jd/{jd['id']}", full, token=token)
    print(f"JD {jd['id']} 已关联猎聘职位 {job_id} (PUBLISHED)")

print('\n重建完成')
