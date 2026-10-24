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
#   SMOKE_TIMEOUT=90 scripts/deploy.sh
#
# 是否需要部署由 data/last-deployed-sha（上次成功部署的提交）与 origin/<BRANCH>
# 比较决定，不看本地 HEAD：本地提前快进/手工 pull 后仍会正常补跑备份、门禁与重启。
# 该文件在冒烟通过后才更新，可用 STATE_FILE 覆盖路径。
#
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."
REPO_ROOT="$PWD"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-literouter.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/data/deploy-backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-60}"
SMOKE_INTERVAL="${SMOKE_INTERVAL:-2}"
# 上次成功部署（重启 + 冒烟通过）的提交。不放 BACKUP_DIR，避免备份目录被换路径或
# 清理时连带丢失部署状态。
STATE_FILE="${STATE_FILE:-$REPO_ROOT/data/last-deployed-sha}"

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
# 生产网关运行的就是本工作树的源码：停在 dev 时重启会加载未发布的开发代码，
# 所以部署必须发生在 $BRANCH 上。
CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  die "当前分支为 ${CURRENT_BRANCH:-detached HEAD}，部署只允许在 $BRANCH 上进行（开发请留在 dev）"
fi

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

# --- 1. 判断是否真的需要部署 ---------------------------------------------------
# 依据是「上次成功部署的提交」而不是「本地 HEAD」：本地 HEAD 可能已经提前快进
# （手工 pull、直接在主仓库开发），此时服务仍在跑旧代码，按 HEAD 判断会误判为
# 已是最新而跳过备份、门禁与重启。
DEPLOYED=""
if [ -s "$STATE_FILE" ]; then
  RECORDED="$(tr -d '[:space:]' < "$STATE_FILE")"
  if [ -n "$RECORDED" ] && git cat-file -e "${RECORDED}^{commit}" 2>/dev/null; then
    DEPLOYED="$(git rev-parse "$RECORDED")"
  else
    printf '\033[1;33m[提示] 部署记录 %s 无法解析，按“未部署过”处理\033[0m\n' "$RECORDED" >&2
  fi
fi

if [ "$DEPLOYED" = "$AFTER" ]; then
  log "已是最新（已部署 $(git rev-parse --short "$AFTER")），无需部署"
  if [ "$BEFORE" != "$AFTER" ]; then
    printf '\033[1;33m[提示] 本地 HEAD 与已部署版本不同，存在尚未推送或尚未部署的提交\033[0m\n' >&2
  fi
  exit 0
fi

if [ -n "$DEPLOYED" ]; then
  # 已部署的提交必须仍在远端历史里，否则是远端强推/回滚，变更清单与回滚提示都会失真
  if ! git merge-base --is-ancestor "$DEPLOYED" "$AFTER"; then
    printf '\033[1;31m已部署版本 %s 不在 origin/%s 历史中（远端被强推或回滚？），拒绝自动部署。\033[0m\n' \
      "$(git rev-parse --short "$DEPLOYED")" "$BRANCH" >&2
    die "请人工确认线上版本后修正 $STATE_FILE"
  fi
  DIFF_BASE="$DEPLOYED"
else
  # 没有部署记录（首次使用本脚本或记录丢失）：不复用 HEAD，一律按“需要部署”处理
  DIFF_BASE="$BEFORE"
fi

if [ "$BEFORE" != "$AFTER" ] && ! git merge-base --is-ancestor "$BEFORE" "$AFTER"; then
  printf '\033[1;31m本地与远端已分叉（本地有远端没有的提交），拒绝部署。\033[0m\n' >&2
  git log --oneline "$AFTER..$BEFORE" >&2
  die "本地不应存在远端没有的提交"
fi

log "本次变更（$(git rev-parse --short "$DIFF_BASE") → $(git rev-parse --short "$AFTER")）"
if [ "$DIFF_BASE" = "$AFTER" ]; then
  echo "    代码已是目标版本，仅补跑备份 / 质量门禁 / 重启"
else
  git diff --stat "$DIFF_BASE" "$AFTER"
  if [ -n "$(git diff --name-only "$DIFF_BASE" "$AFTER" -- package.json pnpm-lock.yaml)" ]; then
    log "注意：依赖清单有变化，将执行 pnpm install"
  fi
fi

# --- 2. 快进合并（禁止在生产机产生合并提交） ---------------------------------
if [ "$BEFORE" != "$AFTER" ]; then
  log "快进合并 $BRANCH"
  git merge --ff-only "$AFTER"
fi

# --- 3. 备份数据库（在任何构建/测试之前，对应部署前状态） --------------------
# WAL 模式下直接 cp 会拿到落后的副本，必须走 SQLite 在线备份 API。
if [ -f "$REPO_ROOT/data/gateway.db" ]; then
  mkdir -p "$BACKUP_DIR"
  SNAPSHOT="$BACKUP_DIR/gateway-$(git rev-parse --short "$DIFF_BASE")-$(date +%Y%m%d-%H%M%S).db"
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
  # 部署状态在冒烟通过后才写（见步骤 8），此处不再记录部署前版本。
  # 只保留最近若干份，避免备份把磁盘吃满（只删本脚本自己生成的命名格式）。
  # 校验快照（只读打开）会重生 -wal/-shm，裁剪时一并带走，避免积累碎片。
  # 无匹配时 ls 会非零退出，pipefail 下需显式收敛。
  ls -1t "$BACKUP_DIR"/gateway-*.db 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
    rm -f -- "$old" "$old-wal" "$old-shm"
  done || true
else
  log "未发现 data/gateway.db，跳过备份（首次部署？）"
fi

# --- 4. 依赖 -----------------------------------------------------------------
log "安装依赖"
pnpm install --frozen-lockfile

# --- 5. 质量门禁：typecheck + 单元测试 + 前端生产构建 ------------------------
# 失败则脚本在此中止，不重启服务，旧版本继续对外服务。
log "质量门禁（pnpm check）"
pnpm check

# --- 6. 重启服务 -------------------------------------------------------------
log "重启 $SERVICE"
systemctl --user restart "$SERVICE"
sleep 2
systemctl --user is-active --quiet "$SERVICE" || {
  systemctl --user status "$SERVICE" --no-pager --lines=30 >&2 || true
  die "服务未能进入 active 状态"
}

# --- 7. 冒烟检查 -------------------------------------------------------------
# 轮询等待而不是一次性探测：冷启动在高负载下可能十几秒才 listen（曾出现 curl -m 10
# 恰好落在 listening 之前，报出 HTTP 000 的假失败并给出误导性的回滚提示）。
log "冒烟检查 $HEALTH_URL（最多等待 ${SMOKE_TIMEOUT}s）"
CODE=''
TRIES=0
START=$SECONDS
while :; do
  TRIES=$((TRIES + 1))
  CODE="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$HEALTH_URL" || true)"
  if [[ $CODE == 200 || $((SECONDS - START)) -ge $SMOKE_TIMEOUT ]]; then break; fi
  sleep "$SMOKE_INTERVAL"
done
echo "    HTTP $CODE（第 ${TRIES} 次探测，等待 $((SECONDS - START))s）"
if [ "$CODE" != "200" ]; then
  printf '\n\033[1;31m冒烟失败（HTTP %s）。代码与数据都已落盘，需要人工判断。\033[0m\n' "$CODE" >&2
  printf '回滚到部署前版本（数据不会自动回滚，必要时先恢复备份）：\n' >&2
  printf '  git checkout %s && pnpm install && pnpm build:web && systemctl --user restart %s\n' "$DIFF_BASE" "$SERVICE" >&2
  die "部署后冒烟未通过（部署记录未更新，下次运行会重试）"
fi

# --- 8. 记录已部署版本 -------------------------------------------------------
# 只有走到这里（服务 active + 冒烟 200）才算部署成功；失败时保留旧记录以便重试。
mkdir -p "$(dirname "$STATE_FILE")"
printf '%s\n' "$AFTER" > "$STATE_FILE" || die "部署完成但写入部署记录失败：$STATE_FILE"

log "部署完成：$(git rev-parse --short "$DIFF_BASE") → $(git rev-parse --short "$AFTER")"
if [ -f "$REPO_ROOT/data/gateway.db" ]; then
  echo "    数据未改动；部署前快照在 $BACKUP_DIR"
  echo "    回滚：git checkout $DIFF_BASE && pnpm install && pnpm build:web && systemctl --user restart $SERVICE"
fi