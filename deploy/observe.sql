-- W6 观察期指标查询(全量 UI 通道后每日执行;2026-09-30 制定)
-- 目的:以数据判定"UI 通道全量替换"是否稳定,覆盖:风控信号/受限/时长/放弃单元/错误率。
-- stats_json 结构: {at, mode, noAccount, polled, scored, greeted, recommended,
--                    errors, riskStopped, suspects, abandoned}

-- 1) 近 7 天轮次概览(按日聚合)
SELECT DATE(finished_at) AS d,
       COUNT(*) AS rounds,
       SUM(polled) AS polled,
       SUM(scored) AS scored,
       SUM(greeted) AS greeted,
       SUM(recommended) AS recommended,
       SUM(errors) AS errors,
       SUM(risk_stopped) AS risk_stops,
       SUM(no_account) AS no_acct,
       ROUND(AVG(TIMESTAMPDIFF(SECOND, started_at, finished_at))) AS avg_sec,
       MAX(TIMESTAMPDIFF(SECOND, started_at, finished_at)) AS max_sec
FROM auto_recruit_round
WHERE finished_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY DATE(finished_at)
ORDER BY d DESC;

-- 2) 风控信号明细(疑似拦截冻结 / 风控停轮)
SELECT id, finished_at, mode,
       JSON_EXTRACT(stats_json, '$.suspects') AS suspects,
       JSON_EXTRACT(stats_json, '$.riskStopped') AS risk_stopped
FROM auto_recruit_round
WHERE risk_stopped = 1
   OR JSON_EXTRACT(stats_json, '$.suspects') > 0
ORDER BY finished_at DESC
LIMIT 50;

-- 3) 放弃单元(平摊窗口跨窗未完成;UI 通道耗时放大的直接体感指标)
SELECT id, finished_at, mode,
       JSON_EXTRACT(stats_json, '$.abandoned') AS abandoned
FROM auto_recruit_round
WHERE JSON_EXTRACT(stats_json, '$.abandoned') > 0
ORDER BY finished_at DESC
LIMIT 50;

-- 4) 错误轮次(驱动失败/抽取异常)
SELECT id, finished_at, mode, polled, errors,
       JSON_EXTRACT(stats_json, '$.at') AS at_ts
FROM auto_recruit_round
WHERE errors > 0
ORDER BY finished_at DESC
LIMIT 50;

-- 5) 账号状态快照(登录态/熔断)
SELECT id, name, login_status, circuit_breaker
FROM liepin_account;
