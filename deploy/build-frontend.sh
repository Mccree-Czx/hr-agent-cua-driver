#!/bin/sh
# 构建前端并复制到后端静态资源目录(Spring Boot 单进程托管,生产部署用)
set -e
cd "$(dirname "$0")/../frontend"
npm install
npm run build
rm -rf ../backend/src/main/resources/static
mkdir -p ../backend/src/main/resources/static
cp -r dist/* ../backend/src/main/resources/static/
echo "[OK] 前端已构建并复制到 backend/src/main/resources/static/"
echo "     随后 cd ../backend && mvn package 即可得到含前端的可部署 jar"
