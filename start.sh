#!/usr/bin/env bash
# NOFX 一键启动/管理（Git Bash）。
#   ./start.sh            构建(按需) + 部署 + PM2 启动 + 健康检查
#   ./start.sh stop       停止
#   ./start.sh status     查看状态
#   ./start.sh logs       跟踪日志（可加 -f 之外的原生参数）
#
# 关键点：
# - 一律用干净环境启动，防止 IDE/沙箱注入的 HTTP(S)_PROXY 被继承进交易进程；
# - 构建产物复制到 ecosystem.nofx-runtime.json 指向的运行时目录（先备份），
#   不动同目录下无法重建的 *-compat.exe 预测服务。
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
PM2_HOME_LOCAL="$ROOT/.pm2"
ECOSYSTEM="$ROOT/ecosystem.nofx-runtime.json"

clean_env() {
  env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
      PM2_HOME="$PM2_HOME_LOCAL" "$@"
}

case "${1:-start}" in
  stop)
    clean_env npx --no-install pm2 stop nofx-api
    exit 0
    ;;
  status)
    clean_env npx --no-install pm2 ls
    exit 0
    ;;
  logs)
    shift
    clean_env npx --no-install pm2 logs nofx-api "$@"
    exit 0
    ;;
esac

echo "[start] 1/4 构建服务端（无变化时秒过）..."
cargo build --release --locked --bin nofx-server

echo "[start] 2/4 部署二进制到运行时目录..."
RUNTIME_BIN=$(python -c "
import json,sys
eco=json.load(open(sys.argv[1],encoding='utf-8'))
print(eco['apps'][0]['script'])
" "$(cygpath -w "$ECOSYSTEM")")
mkdir -p "$(dirname "$RUNTIME_BIN")"
if [ -f "$RUNTIME_BIN" ]; then
  cp "$RUNTIME_BIN" "$RUNTIME_BIN.bak-$(date +%Y%m%d-%H%M%S)"
fi
cp target/release/nofx-server.exe "$RUNTIME_BIN"

if [ ! -f "$ROOT/dist/index.html" ]; then
  echo "[start] 2.5/4 前端产物缺失，构建前端..."
  npm run build
fi

echo "[start] 3/4 PM2 启动（干净环境）..."
clean_env npx --no-install pm2 delete nofx-api >/dev/null 2>&1 || true
clean_env npx --no-install pm2 start "$ECOSYSTEM"
# 守护进程若因终端关闭被回收，pm2 save 可让应用列表自动恢复
clean_env npx --no-install pm2 save >/dev/null 2>&1 || true

echo "[start] 4/4 健康检查..."
for _ in $(seq 1 30); do
  curl -s --max-time 2 http://127.0.0.1:3100/api/paper/account >/dev/null 2>&1 && break
  sleep 2
done
curl -s http://127.0.0.1:3100/api/paper/account | python -c \
  "import json,sys;d=json.load(sys.stdin);a=d['exchangeAccounts']['demo'];print('syncedAt:',a.get('syncedAt'),'error:',a.get('error'))" \
  || echo "(account 接口未就绪，看日志：./start.sh logs)"
clean_env npx --no-install pm2 ls
echo "[start] 完成。"
