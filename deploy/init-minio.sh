#!/bin/sh
# 初始化 MinIO:创建简历存储桶(依赖 docker compose 已启动 minio)
set -e

BUCKET="${RESUME_BUCKET:-resumes}"
MINIO_HOST="${MINIO_HOST:-localhost:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-hr-agent-minio}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-hr-agent-minio-pass}"

if command -v mc >/dev/null 2>&1; then
    mc alias set local "http://$MINIO_HOST" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    mc mb --ignore-existing "local/$BUCKET"
    echo "[OK] bucket '$BUCKET' 已就绪"
else
    echo "[INFO] 未安装 minio client(mc),使用 docker 内 mc 初始化"
    docker exec hr-agent-minio sh -c "
        mc alias set local http://localhost:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD &&
        mc mb --ignore-existing local/$BUCKET"
    echo "[OK] bucket '$BUCKET' 已就绪"
fi
