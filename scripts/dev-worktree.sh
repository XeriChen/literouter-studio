#!/usr/bin/env bash
#
# 创建本机开发 worktree 并以非生产端口启动开发实例（前台运行，Ctrl+C 退出）。
#
# 背景：本机 3000 端口是 systemd 托管的生产网关（literouter.service），仓库根目录
# 只做远端镜像与部署（scripts/deploy.sh）。功能开发一律在 worktree 里进行：
#   网关开发实例  http://127.0.0.1:3001  （HOST=127.0.0.1，仅本机可达）
#   Vite 前端     http://localhost:5174  （/api、/openai、/anthropic 代理到 3001）
#
# worktree 自带独立的 data/（.gitignore，不入库）与独立 .env，与生产库完全隔离。
# 开发完成后：push 分支 → 合入 main → 在生产仓库跑 scripts/deploy.sh。
#
# 用法：
#   scripts/dev-worktree.sh <分支名>
#   DEV_PORT=3002 VITE_PORT=5175 scripts/dev-worktree.sh <分支名>
#   WT_ROOT=~/somewhere scripts/dev-worktree.sh <分支名>   # 自定义 worktree 路径
#
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."
REPO_ROOT="$PWD"
BRANCH="${1:-}"
DEV_PORT="${DEV_PORT:-3001}"
VITE_PORT="${VITE_PORT:-5174}"
SAFE_BRANCH="${BRANCH//\//-}"
WT_ROOT="${WT_ROOT:-$REPO_ROOT/../literouter-dev-$SAFE_BRANCH}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$BRANCH" ] || die "用法: scripts/dev-worktree.sh <分支名>"
# 生产网关端口绝不能被开发实例占用
[ "$DEV_PORT" != "3000" ] || die "DEV_PORT 不能是 3000（生产网关端口）"
[ "$VITE_PORT" != "5173" ] || [ "$VITE_PORT" != "$DEV_PORT" ] || die "VITE_PORT 与 DEV_PORT 不能相同"

# 分支不能正被生产仓库检出（git 也不允许两个 worktree 检出同一分支）
CURRENT_BRANCH="$(git branch --show-current)"
[ "$BRANCH" != "$CURRENT_BRANCH" ] || die "分支 $BRANCH 正被生产仓库（$REPO_ROOT）检出，换一个分支名"

if [ -e "$WT_ROOT/.git" ]; then
  # linked worktree 的 .git 是文件（指向主仓 .git/worktrees），主仓才是目录
  log "复用既有 worktree：$WT_ROOT"
elif [ -e "$WT_ROOT" ]; then
  die "$WT_ROOT 已存在但不是 git worktree，请确认后手动处理或改用 WT_ROOT="
else
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    log "挂载已有分支 $BRANCH → $WT_ROOT"
    git worktree add "$WT_ROOT" "$BRANCH"
  else
    log "创建 worktree：$WT_ROOT（新分支 $BRANCH，基于 main）"
    git worktree add "$WT_ROOT" -b "$BRANCH" main
  fi
fi

cd "$WT_ROOT"

log "安装依赖"
pnpm install --frozen-lockfile

# 构建一次前端：worktree 是全新检出，web/dist 被 gitignore 不会随仓库带来。
# 不构建的话网关对 / 返回 404，Playwright 的复用探测（要求状态码 < 404）会
# 误判服务未就绪而去自起 pnpm start（默认 3000，会撞生产网关）。
log "构建前端（web/dist，供网关直接托管与 E2E 复用探测）"
pnpm build:web

# 开发实例使用自己的 ENCRYPTION_KEY：与生产库无关，但重启后仍需解开自己存的凭据。
# HOST 固定 127.0.0.1，避免在局域网暴露第二个网关。
if [ ! -f .env ]; then
  KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  printf 'HOST=127.0.0.1\nENCRYPTION_KEY=%s\n' "$KEY" > .env
  chmod 600 .env
  log "已生成 .env（HOST=127.0.0.1 + 独立 ENCRYPTION_KEY，已被 .gitignore 忽略）"
fi

log "启动开发实例（前台）：网关 http://127.0.0.1:$DEV_PORT ，前端 http://localhost:$VITE_PORT"
log "E2E 指向本实例：E2E_GATEWAY_URL=http://127.0.0.1:$DEV_PORT pnpm test:e2e"
exec env PORT="$DEV_PORT" VITE_PORT="$VITE_PORT" pnpm dev
