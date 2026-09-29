#!/bin/sh
# 备份/恢复猎聘账号登录态(user-data-dir,评审 P2-13)
# 用法:
#   sh backup-userdata.sh backup [备份目录]   # 默认 ~/hr-agent-backup/userdata-<日期>
#   sh backup-userdata.sh restore <备份目录>
set -e

ACTION="${1:-backup}"
BACKUP_DIR="${2:-$HOME/hr-agent-backup/userdata-$(date +%Y%m%d-%H%M%S)}"
SOURCE_DIR="${LIEPIN_PROFILES_DIR:-$HOME/.liepin-cli/profiles}"

case "$ACTION" in
  backup)
    if [ ! -d "$SOURCE_DIR" ]; then
      echo "[ERROR] 源目录不存在: $SOURCE_DIR"
      exit 1
    fi
    mkdir -p "$BACKUP_DIR"
    cp -r "$SOURCE_DIR/." "$BACKUP_DIR/"
    echo "[OK] 登录态已备份到: $BACKUP_DIR"
    ;;
  restore)
    if [ ! -d "$BACKUP_DIR" ]; then
      echo "[ERROR] 备份目录不存在: $BACKUP_DIR"
      exit 1
    fi
    mkdir -p "$SOURCE_DIR"
    cp -r "$BACKUP_DIR/." "$SOURCE_DIR/"
    echo "[OK] 登录态已从 $BACKUP_DIR 恢复到 $SOURCE_DIR"
    echo "     (恢复后如浏览器报 profile 冲突,先 liepin quit 或重启机器)"
    ;;
  *)
    echo "用法: sh backup-userdata.sh backup|restore [目录]"
    exit 1
    ;;
esac
