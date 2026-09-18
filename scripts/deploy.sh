#!/usr/bin/env bash
#
# 本地生产机的 pull 部署脚本（手动触发）。
#
# 语义：本地仓库是远端的纯镜像，只做快进合并；数据库与 .env 都在 .gitignore 里，
# 因此任何 git 操作（含回滚）都不会触碰 data/gateway.db 与凭据加密密钥。
#
# 失败即中止：质量门禁不通过时不会重启服务，旧版本继续对外服务。
#
# 用法：
#   scripts/deploy.sh            # 拉取 origin/main 并部署
#   BRANCH=other scripts/deploy.sh
#   SERVICE=other.service scripts/deploy.sh
#
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."
REPO_ROOT="$PWD"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-literouter.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/data/deploy-backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

# 同一时间只允许一个部署进程，避免两次重启互相打断
mkdir -p "$REPO_ROOT/data"
exec 9>"$REPO_ROOT/data/.deploy.lock"
flock -n 9 || die "已有部署在进行中（$REPO_ROOT/data/.deploy.lock）"

for bin in git pnpm curl systemctl flock node; do
  command -v "$bin" >/dev/null || die "缺少命令：$bin"
done

# --- 0. 前置：本地必须是远端纯镜像 -------------------------------------------
# 只拒绝“已跟踪文件的本地改动”（会导致快进失败或合并出意外结果）；未跟踪的草稿文件
# 不影响拉取，仅告警。本地从不改代码是 pull 部署的前提，否则迟早分叉。
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  printf '\033[1;31m本地已跟踪文件有未提交改动，拒绝部署（本地应只从远端拉取）：\033[0m\n' >&2
  git status --short --untracked-files=no >&2
  die "请先处理本地改动（丢弃，或推送后重新拉取）"
fi

UNTRACKED="$(git ls-files --others --exclude-standard)"
if [ -n "$UNTRACKED" ]; then
  printf '\033[1;33m[提示] 存在未跟踪文件（若远端新增同名文件会导致拉取失败）：\033[0m\n' >&2
  # head 提前退出会让上游收到 SIGPIPE，pipefail 下需收敛掉
  printf '%s\n' "$UNTRACKED" | head -10 >&2 || true
fi

log "拉取远端 $BRANCH"
git fetch --prune origin

BEFORE="$(git rev-parse HEAD)"
AFTER="$(git rev-parse "origin/$BRANCH")"

if [ "$BEFORE" = "$AFTER" ]; then
  log "已是最新（$(git rev-parse --short HEAD)），无需部署"
  exit 0
fi

if ! git merge-base --is-ancestor "$BEFORE" "$AFTER"; then
  printf '\033[1;31m本地与远端已分叉（本地有远端没有的提交），拒绝部署。\033[0m\n' >&2
  git log --oneline "$AFTER..$BEFORE" >&2
  die "本地不应存在远端没有的提交"
fi

log "本次变更（$(git rev-parse --short "$BEFORE") → $(git rev-parse --short "$AFTER")）"
git diff --stat "$BEFORE" "$AFTER"

if [ -n "$(git diff --name-only "$BEFORE" "$AFTER" -- package.json pnpm-lock.yaml)" ]; then
  log "注意：依赖清单有变化，将执行 pnpm install"
fi

# --- 1. 快进合并（禁止在生产机产生合并提交） ---------------------------------
log "快进合并 $BRANCH"
git merge --ff-only "$AFTER"

# --- 2. 备份数据库（在任何构建/测试之前，对应部署前状态） --------------------
# WAL 模式下直接 cp 会拿到落后的副本，必须走 SQLite 在线备份 API。
if [ -f "$REPO_ROOT/data/gateway.db" ]; then
  mkdir -p "$BACKUP_DIR"
  SNAPSHOT="$BACKUP_DIR/gateway-$(git rev-parse --short "$BEFORE")-$(date +%Y%m%d-%H%M%S).db"
  log "备份数据库 → ${SNAPSHOT#"$REPO_ROOT"/}"
  # 参数走环境变量而非位置参数，避免 argv 错位把真实库当成写入目标。
  # 先强制读取验证源是真实数据库，再写临时文件，最后原子 rename 落位：
  # 任何一步失败都不会留下残缺快照，更不会碰到线上库。
  BK_SRC="$REPO_ROOT/data/gateway.db" BK_DEST="$SNAPSHOT" node -e '
    const fs = require("fs")
    const path = require("path")
    const src = process.env.BK_SRC
    const dest = process.env.BK_DEST
    const tmp = `${dest}.partial`
    if (!src || !dest) { console.error("[失败] 缺少 BK_SRC / BK_DEST"); process.exit(1) }
    if (path.resolve(src) === path.resolve(dest)) { console.error("[失败] 备份源与目标是同一个文件，拒绝执行"); process.exit(1) }
    const drop = (err) => {
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true })
      console.error(`[失败] 备份失败：${err.message}`)
      process.exit(1)
    }
    const db = require("better-sqlite3")(src, { readonly: true, fileMustExist: true })
    db.pragma("schema_version", { simple: true }) // 读一次 SQLite schema cookie，源不是真库时在此提前失败
    db.backup(tmp)
      .then(() => {
        const copy = require("better-sqlite3")(tmp, { readonly: true, fileMustExist: true })
        const ok = copy.pragma("integrity_check", { simple: true })
        const tables = copy.prepare("SELECT count(*) c FROM sqlite_master WHERE type = ?").get("table").c
        // 副本继承 WAL 模式；截断检查点后 WAL 已空，伴生文件只是空壳，删掉保持目录干净
        const { busy, log: frames } = copy.pragma("wal_checkpoint(TRUNCATE)")[0]
        copy.close()
        if (ok !== "ok") throw new Error(`副本完整性校验失败：${ok}`)
        if (busy !== 0 || frames !== 0) throw new Error(`副本 WAL 未清空（busy=${busy}, frames=${frames}），拒绝落位`)
        fs.rmSync(`${tmp}-wal`, { force: true })
        fs.rmSync(`${tmp}-shm`, { force: true })
        fs.renameSync(tmp, dest)
        console.log(`    备份校验通过：完整性 ${ok}，${tables} 张表`)
      })
      .catch(drop)
  '
  printf '%s\n' "$BEFORE" > "$BACKUP_DIR/last-deployed-sha"
  # 只保留最近若干份，避免备份把磁盘吃满（只删本脚本自己生成的命名格式）。
  # 校验快照（只读打开）会重生 -wal/-shm，裁剪时一并带走，避免积累碎片。
  # 无匹配时 ls 会非零退出，pipefail 下需显式收敛。
  ls -1t "$BACKUP_DIR"/gateway-*.db 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
    rm -f -- "$old" "$old-wal" "$old-shm"
  done || true
else
  log "未发现 data/gateway.db，跳过备份（首次部署？）"
fi

# --- 3. 依赖 -----------------------------------------------------------------
log "安装依赖"
pnpm install --frozen-lockfile

# --- 4. 质量门禁：typecheck + 单元测试 + 前端生产构建 ------------------------
# 失败则脚本在此中止，不重启服务，旧版本继续对外服务。
log "质量门禁（pnpm check）"
pnpm check

# --- 5. 重启服务 -------------------------------------------------------------
log "重启 $SERVICE"
systemctl --user restart "$SERVICE"
sleep 2
systemctl --user is-active --quiet "$SERVICE" || {
  systemctl --user status "$SERVICE" --no-pager --lines=30 >&2 || true
  die "服务未能进入 active 状态"
}

# --- 6. 冒烟检查 -------------------------------------------------------------
log "冒烟检查 $HEALTH_URL"
CODE="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$HEALTH_URL" || true)"
echo "    HTTP $CODE"
if [ "$CODE" != "200" ]; then
  printf '\n\033[1;31m冒烟失败（HTTP %s）。代码与数据都已落盘，需要人工判断。\033[0m\n' "$CODE" >&2
  printf '回滚到部署前版本（数据不会自动回滚，必要时先恢复备份）：\n' >&2
  printf '  git checkout %s && pnpm install && pnpm build:web && systemctl --user restart %s\n' "$BEFORE" "$SERVICE" >&2
  die "部署后冒烟未通过"
fi

log "部署完成：$(git rev-parse --short "$BEFORE") → $(git rev-parse --short "$AFTER")"
if [ -f "$REPO_ROOT/data/gateway.db" ]; then
  echo "    数据未改动；部署前快照在 $BACKUP_DIR"
  echo "    回滚：git checkout $BEFORE && pnpm install && pnpm build:web && systemctl --user restart $SERVICE"
fi