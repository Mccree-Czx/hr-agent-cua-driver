#!/bin/sh
# 安装 fork 版 liepin-cli(评审 P0-1:固定 commit,可自行打补丁)
# 用法:sh install-liepin-cli.sh [fork 仓库地址] [commit/branch]
set -e

REPO_URL="${1:-https://github.com/Viy1204/liepin-cli.git}"
REV="${2:-}"

if ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] 未检测到 npm,请先安装 Node.js >= 20"
    exit 1
fi

TMP_DIR="$(mktemp -d)"
echo "[1/3] clone $REPO_URL"
git clone --depth 1 "$REPO_URL" "$TMP_DIR"
if [ -n "$REV" ]; then
    echo "[2/3] checkout $REV"
    git -C "$TMP_DIR" fetch --depth 1 origin "$REV" || true
    git -C "$TMP_DIR" checkout "$REV"
else
    echo "[2/3] 使用默认分支最新 commit"
    echo "      (生产建议:fork 后以 commit 固定安装,如 sh install-liepin-cli.sh <fork-url> <commit>)"
fi
echo "[3/5] npm install(构建依赖)"
cd "$TMP_DIR"
npm install --silent
echo "[4/5] npm run build(tsc 生成 dist)"
npm run build
echo "[5/5] npm pack + 全局安装(tarball 方式,避免目录符号链接)"
TARBALL="$(npm pack --silent | tail -1)"
npm install -g "$TMP_DIR/$TARBALL"
cd - >/dev/null
rm -rf "$TMP_DIR"
echo "[OK] liepin-cli 安装完成,验证: liepin help"
