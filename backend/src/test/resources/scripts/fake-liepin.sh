#!/bin/sh
# liepin-cli 桩脚本(测试用)
# - 首个参数 sleep-long:睡 60 秒(验证超时)
# - 首个参数 big-output:输出 >64KB(验证输出超过管道缓冲区时不再假死)
# - 其余情况行为由 FAKE_MODE 环境变量控制
if [ "$1" = "sleep-long" ]; then
  sleep 60
  exit 0
fi
if [ "$1" = "big-output" ]; then
  # 每行约 80 字节 × 2000 行 ≈ 160KB,超过管道缓冲区(约 64KB)
  i=0
  while [ $i -lt 2000 ]; do
    echo '[{"name":"候选人占位","resume_id":"r-big-0000000000000000000000000000000000000000"}]'
    i=$((i+1))
  done
  exit 0
fi
case "$FAKE_MODE" in
  success-search)
    echo '[{"rank":1,"name":"张三","resume_id":"r1001","salary":"20-30K","city":"北京","experience":"5年"},{"rank":2,"name":"李四","resume_id":"r1002","salary":"15-25K","city":"上海","experience":"3年"}]'
    ;;
  echo-env)
    echo "dataDir=$LIEPIN_USER_DATA_DIR port=$LIEPIN_BROWSER_REMOTE_DEBUGGING_PORT"
    ;;
  sleep-long)
    sleep 60
    ;;
  risk)
    echo "302 to safe.liepin.com/captchaPage_PC 行为异常"
    ;;
  not-login)
    echo "请先登录后再操作"
    ;;
  fail)
    echo "some error occurred"
    exit 1
    ;;
  *)
    echo '[{"name":"默认候选人","resume_id":"r0"}]'
    ;;
esac
exit 0
