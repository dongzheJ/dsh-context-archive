#!/bin/sh
# 从 DSH Desktop 的 desktop profile 里干净卸掉 dsh-context-archive。
#
# 用法：
#   sh scripts/uninstall-desktop.sh                 # 只卸载
#   sh scripts/uninstall-desktop.sh <backup.tgz>    # 卸载后还原备份
set -eu

BUNDLE_NAME=dsh-context-archive
DSH_HOME=${DSH_HOME:-"$HOME/.dsh"}
PROFILE=desktop
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
APP_RUNTIME="/Applications/DeepSeek Harness.app/Contents/Resources/runtime"
PNPM_JS="$APP_RUNTIME/pnpm/bin/pnpm.mjs"
NODE=${NODE:-$(command -v node || true)}
BACKUP=${1:-}

die() { printf '✗ %s\n' "$*" >&2; exit 1; }

[ -n "$NODE" ] || die "PATH 里没有 node"
[ -f "$PNPM_JS" ] || die "找不到 App 自带的 pnpm：$PNPM_JS"

if pgrep -f "DeepSeek Harness" >/dev/null 2>&1; then
  die "请先完全退出 DSH Desktop，再执行卸载。"
fi

# ── 1. 从 bundles 里摘掉（先摘，避免还原依赖时仍被激活）────────────────────
"$NODE" -e '
const fs = require("node:fs")
const [file, name] = process.argv.slice(1)
const json = JSON.parse(fs.readFileSync(file, "utf8"))
const bundles = json.dsh?.profile?.bundles
if (Array.isArray(bundles) && bundles.includes(name)) {
  json.dsh.profile.bundles = bundles.filter((entry) => entry !== name)
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n")
  console.log("✓ bundles -= " + name)
} else {
  console.log("✓ bundles 里没有 " + name)
}
' "$PROFILE_DIR/package.json" "$BUNDLE_NAME"

# ── 2. 移除依赖 ────────────────────────────────────────────────────────────
cd "$PROFILE_DIR"
"$NODE" "$PNPM_JS" remove "$BUNDLE_NAME" || printf '! pnpm remove 退出码非 0，请检查 package.json\n'

# ── 3. 可选的整目录还原 ────────────────────────────────────────────────────
if [ -n "$BACKUP" ]; then
  [ -f "$BACKUP" ] || die "找不到备份：$BACKUP"
  CURRENT="$DSH_HOME/backups/desktop-profile-before-restore-$(date +%Y%m%d-%H%M%S).tgz"
  tar czf "$CURRENT" -C "$DSH_HOME/profiles" --exclude=node_modules --exclude=.dsh-market "$PROFILE"
  tar xzf "$BACKUP" -C "$DSH_HOME/profiles"
  echo "✓ 已从 $BACKUP 还原（还原前的状态另存为 $CURRENT）"
fi

echo "✓ 卸载完成。启动 DSH Desktop 确认 Settings → Plugins 里已无 $BUNDLE_NAME"
