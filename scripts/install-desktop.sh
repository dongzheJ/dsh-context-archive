#!/bin/sh
# 把 dsh-context-archive 手工装进 DSH Desktop 的 desktop profile。
#
# 为什么必须手工：
#   - dsh CLI 拒绝管理 Electron 的 profile（"managed exclusively by the Electron application"）
#   - dshmarket 的 /dsh-market/install 只接受 curated registry 里的条目（本地 tarball 会被 400）
#
# 用法：
#   sh scripts/install-desktop.sh [tgz 路径]
# 默认 tgz：与本仓库同级的 dsh-context-archive-0.1.0.tgz
set -eu

BUNDLE_NAME=dsh-context-archive
TGZ_SRC=${1:-"$(cd "$(dirname "$0")/.." && pwd)/dsh-context-archive-0.1.0.tgz"}
DSH_HOME=${DSH_HOME:-"$HOME/.dsh"}
PROFILE=desktop
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
STABLE_DIR="$DSH_HOME/local-plugins"
APP_RUNTIME="/Applications/DeepSeek Harness.app/Contents/Resources/runtime"
PNPM_JS="$APP_RUNTIME/pnpm/bin/pnpm.mjs"
NODE=${NODE:-$(command -v node || true)}

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

[ -f "$TGZ_SRC" ] || die "找不到 tarball：$TGZ_SRC（先在插件目录跑 npm pack）"
[ -f "$PNPM_JS" ] || die "找不到 App 自带的 pnpm：$PNPM_JS（App 是否被移动过？）"
[ -n "$NODE" ] || die "PATH 里没有 node"
[ -f "$PROFILE_DIR/package.json" ] || die "找不到 profile：$PROFILE_DIR"

# ── 0. 守卫：App 必须处于退出状态 ────────────────────────────────────────────
# macOS 上 `pgrep -f` 匹配不到完整 .app 路径（进程 argv 里被截成短名），
# 因此用短名匹配；2026-10-05 实测该写法能命中 App 主进程与两个 Helper。
if pgrep -f "DeepSeek Harness" >/dev/null 2>&1; then
  die "请先完全退出 DSH Desktop。pnpm 会重写 profile 的 node_modules，App 运行中安装会弄坏正在工作的 agent。"
fi

# ── 1. 备份（配置层；node_modules 由 lockfile 重建）─────────────────────────
mkdir -p "$DSH_HOME/backups"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$DSH_HOME/backups/desktop-profile-$STAMP.tgz"
tar czf "$BACKUP" -C "$DSH_HOME/profiles" --exclude=node_modules --exclude=.dsh-market "$PROFILE"
say "✓ 已备份：$BACKUP"

# ── 2. 把 tarball 放到稳定位置（file: 依赖不能指向临时目录）────────────────
mkdir -p "$STABLE_DIR"
cp "$TGZ_SRC" "$STABLE_DIR/"
STABLE_TGZ="$STABLE_DIR/$(basename "$TGZ_SRC")"
say "✓ tarball 已固定到：$STABLE_TGZ"

# ── 3. 安装依赖（用 App 自带的 pnpm 11.7.0，避免 lockfile 被改写）───────────
cd "$PROFILE_DIR"
"$NODE" "$PNPM_JS" add "file:$STABLE_TGZ"
say "✓ 依赖已安装"

# ── 4. 激活为 profile layer（不加这一行只是一份不生效的依赖）────────────────
"$NODE" -e '
const fs = require("node:fs")
const [file, name] = process.argv.slice(1)
const json = JSON.parse(fs.readFileSync(file, "utf8"))
json.dsh ??= {}
json.dsh.profile ??= {}
json.dsh.profile.bundles ??= []
if (json.dsh.profile.bundles.includes(name)) {
  console.log("✓ bundles 已包含 " + name)
} else {
  json.dsh.profile.bundles.push(name)
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n")
  console.log("✓ bundles += " + name)
}
' "$PROFILE_DIR/package.json" "$BUNDLE_NAME"

# ── 5. 策略覆盖（profile patch 层在 bundle 层之后生效，升级包不会冲掉它）────
if grep -q "id: context-archive" "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null; then
  say "✓ cordis.patch.yml 已有 context-archive 覆盖行"
else
  cat >> "$PROFILE_DIR/cordis.patch.yml" <<'YAML'

# ── dsh-context-archive：策略覆盖（本层在 bundle 层之后应用）──
- id: context-archive
  config:
    parkAfterCompactions: 1   # 首次验证用；验完改回 3
YAML
  say "✓ cordis.patch.yml += context-archive 覆盖行（parkAfterCompactions: 1）"
fi

cat <<EOF

装完了。接着：
  1. 启动 DSH Desktop
  2. Settings → Plugins 应能看到 $BUNDLE_NAME
  3. 新建会话里敲 /park，应出现在斜杠命令中
  4. 跑完首次验证后，把 $PROFILE_DIR/cordis.patch.yml 里的 parkAfterCompactions 改回 3

起不来的话：
  sh scripts/uninstall-desktop.sh            # 干净卸载
  tar xzf $BACKUP -C $DSH_HOME/profiles      # 或整目录还原
EOF
