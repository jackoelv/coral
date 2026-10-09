#!/bin/bash
# 每 10 分钟在本机跑一次 BSC 主网索引，只写 preview 库，不写正式库 neondb。
# 每段区块数固定为 50000；一次跑完会扫到当前安全区块，下一轮再补新块。
#
# 前台循环（关掉终端就停）：
#   ./scripts/index-mainnet-every-10m.sh
#
# 登录后自动跑，合上终端也继续：
#   ./scripts/index-mainnet-every-10m.sh install
#   ./scripts/index-mainnet-every-10m.sh uninstall
#   ./scripts/index-mainnet-every-10m.sh status

set -u

INTERVAL_SEC=600
CHUNK_BLOCKS=50000
LABEL="com.nemoido.index-mainnet"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/nemoido"
LOCK_DIR="${TMPDIR:-/tmp}/nemoido-index-mainnet.lock"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

run_once() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') 已有一轮索引在跑，本次跳过。"
    return 0
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' RETURN
  echo "$(date '+%Y-%m-%d %H:%M:%S') 开始索引 preview 库 CHUNK_BLOCKS=${CHUNK_BLOCKS}"
  (
    cd "$ROOT"
    CHUNK_BLOCKS="$CHUNK_BLOCKS" npm run index:mainnet -- --db preview
  )
  local status=$?
  echo "$(date '+%Y-%m-%d %H:%M:%S') 本轮结束，退出码 ${status}"
  return "$status"
}

install_agent() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/scripts/index-mainnet-every-10m.sh</string>
    <string>once</string>
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/index-mainnet.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/index-mainnet.log</string>
</dict>
</plist>
EOF
  local domain="gui/$(id -u)"
  launchctl bootout "$domain" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "$domain" "$PLIST"
  launchctl enable "${domain}/${LABEL}"
  launchctl kickstart -k "${domain}/${LABEL}"
  echo "已安装并启动。每 ${INTERVAL_SEC} 秒跑一次，日志：${LOG_DIR}/index-mainnet.log"
}

uninstall_agent() {
  local domain="gui/$(id -u)"
  launchctl bootout "$domain" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸下 ${LABEL}"
}

status_agent() {
  launchctl print "gui/$(id -u)/${LABEL}" 2>&1 | sed -n '1,40p'
}

case "${1:-loop}" in
  once) run_once ;;
  install) install_agent ;;
  uninstall) uninstall_agent ;;
  status) status_agent ;;
  loop)
    echo "前台每 ${INTERVAL_SEC} 秒索引一次。Ctrl-C 停止。要登录后自动跑： $0 install"
    while true; do
      started=$(date +%s)
      run_once || true
      elapsed=$(( $(date +%s) - started ))
      wait_sec=$(( INTERVAL_SEC - elapsed ))
      if (( wait_sec > 0 )); then
        echo "$(date '+%Y-%m-%d %H:%M:%S') ${wait_sec} 秒后开始下一轮"
        sleep "$wait_sec"
      fi
    done
    ;;
  *)
    echo "用法: $0 [once|install|uninstall|status]" >&2
    exit 2
    ;;
esac
