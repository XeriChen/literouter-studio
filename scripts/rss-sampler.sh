#!/usr/bin/env bash
# 网关内存「外部」采样器。
#
# 为什么需要它：网关内存暴涨到卡死时，进程会停在内核内存回收里（D 状态），事件循环
# 不再调度，于是进程内的 RSS 看门狗既写不出堆快照、也打不出任何日志——历次事故因此
# 一份现场都没留下。本脚本是**独立进程**，只读 cgroup 与 /proc，网关无论卡成什么样
# 都能持续记录，留下：
#   - 内存曲线的形状（阶跃式单次巨额分配 vs 持续爬升）
#   - anon / file 分解（判断是堆/native buffer 还是页缓存）
#   - 各进程状态（S/R/D）与线程数（D 状态出现的时刻）
#   - cgroup 的 high/max/oom 事件计数与 PSI 停顿时长（进入 reclaim 的时刻）
#
# 追查「突发」还需要一步：曲线只说明涨了，不说明**谁**涨的。真正的突发是同步巨额分配，
# 会把事件循环阻塞数秒——Node 侧的 setInterval 看门狗、--heapsnapshot-signal、
# --heapsnapshot-near-heap-limit 全都抓不到（2026-09-28 实测：信号直到循环恢复后才写快照，
# near-heap-limit 对大 ArrayBuffer 完全不触发）。所以本脚本在探针发现突发时，立刻用
# perf（内核侧采样，不受事件循环阻塞影响）附着到网关进程采栈，配合网关常驻的
# --perf-basic-prof 符号表，直接给出分配点的 JS 函数与源码行。
#
# 由 systemd 用户单元 literouter-rss-sampler.service 常驻托管。
# 环境变量（均可选）：
#   GATEWAY_UNIT               被采样单元，默认 literouter.service
#   RSS_SAMPLER_LOG            输出文件，默认 <repo>/data/rss-sampler.log
#   RSS_SAMPLER_BASE_INTERVAL  常态采样间隔（秒），默认 15
#   RSS_SAMPLER_HOT_INTERVAL   高位采样间隔（秒），默认 1
#   RSS_SAMPLER_HOT_BYTES      进入高位采样的 memory.current 阈值，默认 400000000
#   RSS_SAMPLER_MAX_BYTES      日志轮转阈值（字节），默认 20000000
#   RSS_SAMPLER_FAST_INTERVAL  突发探针间隔（秒，可为小数），默认 0.5
#   RSS_SAMPLER_BURST_DELTA_BYTES  单次探针增量超过该值即判定突发，默认 33554432（32MB）
#   RSS_SAMPLER_CAPTURE_SECONDS    perf 捕获时长（秒），默认 12
#   RSS_SAMPLER_CAPTURE_DIR        报告输出目录，默认 <repo>/data/burst-captures
#   RSS_SAMPLER_KEEP_CAPTURES      保留最近 N 份报告，默认 3
#   RSS_SAMPLER_CAPTURE_COOLDOWN   两次捕获的最小间隔（秒），默认 60
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="${GATEWAY_UNIT:-literouter.service}"
OUT="${RSS_SAMPLER_LOG:-$ROOT/data/rss-sampler.log}"
BASE_INTERVAL="${RSS_SAMPLER_BASE_INTERVAL:-15}"
HOT_INTERVAL="${RSS_SAMPLER_HOT_INTERVAL:-1}"
HOT_BYTES="${RSS_SAMPLER_HOT_BYTES:-400000000}"
MAX_BYTES="${RSS_SAMPLER_MAX_BYTES:-20000000}"
FAST_INTERVAL="${RSS_SAMPLER_FAST_INTERVAL:-0.5}"
BURST_DELTA="${RSS_SAMPLER_BURST_DELTA_BYTES:-33554432}"
CAPTURE_SECONDS="${RSS_SAMPLER_CAPTURE_SECONDS:-12}"
CAPTURE_DIR="${RSS_SAMPLER_CAPTURE_DIR:-$ROOT/data/burst-captures}"
KEEP_CAPTURES="${RSS_SAMPLER_KEEP_CAPTURES:-3}"
CAPTURE_COOLDOWN="${RSS_SAMPLER_CAPTURE_COOLDOWN:-60}"
CG_ROOT=/sys/fs/cgroup

mkdir -p "$(dirname "$OUT")" 2>/dev/null

# 回收上次中断留下的半成品捕获（陈旧 .capture.lock 的判定放在获取锁时处理）
mkdir -p "$CAPTURE_DIR" 2>/dev/null
find "$CAPTURE_DIR" -maxdepth 1 -name 'perf-burst-*.data' -mmin +60 -delete 2>/dev/null

# 清理已退出进程遗留的 perf 符号表：网关每次重启都会新生成一份，/tmp 常为 tmpfs 会占内存
for _m in /tmp/perf-*.map; do
  [[ -e $_m ]] || continue
  _mpid="${_m##*/perf-}"; _mpid="${_mpid%.map}"
  if [[ ! $_mpid =~ ^[0-9]+$ ]] || ! kill -0 "$_mpid" 2>/dev/null; then
    rm -f "$_m"
  fi
done

ts() { printf '%(%Y-%m-%dT%H:%M:%S%z)T' -1; }
emit() { printf '%s %s\n' "$(ts)" "$*" >>"$OUT"; }

# cgroup 单值文件（去掉换行/制表）
cgval() {
  local v
  # 整个复合命令吞掉 stderr：cgroup 消失时（重启窗口）探针会高频访问，不能让报错刷 journal
  { v="$(<"$1")"; } 2>/dev/null || return 1
  printf '%s' "${v//[$'\n\t']/}"
}

# 从 "key value" 文本中取出指定 key，输出 "k1=v1 k2=v2"
readkv() {
  local f=$1; shift
  local k v out='' line
  local -A want=()
  for k in "$@"; do want[$k]=1; done
  [[ -r $f ]] || return 0
  while read -r k v line; do
    [[ -n ${want[$k]:-} ]] && out+="$k=$v "
  done <"$f"
  printf '%s' "${out% }"
}

# memory.pressure 中 "some" 行的 total 微秒数（任务因内存停顿的累计时长）
read_pressure_total() {
  local -a parts
  local p
  [[ -r $1 ]] || return 0
  while read -r -a parts; do
    [[ ${parts[0]:-} == some ]] || continue
    for p in "${parts[@]:1}"; do
      [[ $p == total=* ]] && { printf '%s' "${p#total=}"; return 0; }
    done
  done <"$1"
}

# /proc/<pid>/status 中的单个字段（State / VmRSS / Threads）
proc_field() {
  local k v line
  [[ -r /proc/$1/status ]] || return 0
  while IFS=$':\t ' read -r k v line; do
    [[ $k == "$2" ]] && { printf '%s' "$v"; return 0; }
  done <"/proc/$1/status"
}

# --- 突发捕获（perf 外部采样）------------------------------------------------
#
# 只统计「栈里含大块内存写（memmove/memcpy/memset）的样本」中出现的 JS 帧并计次——
# 突发就是这些大块写，计数最高的 JS 帧即分配点。
# perf script 每个样本是一行表头 + 若干缩进帧，样本间空行分隔。
js_frames_in_copies() {
  awk '
    /^[[:space:]]/ {
      if (!haswrite && ($0 ~ /memmove|memcpy|memset/)) haswrite = 1
      if (index($0, "JS:")) { f = $0; sub(/^[[:space:]]+/, "", f); frames[nframes++] = f }
      next
    }
    { flush() }
    END { flush(); for (k in count) printf "%d %s\n", count[k], k }
    function flush(   i) {
      if (haswrite) for (i = 0; i < nframes; i++) count[frames[i]]++
      haswrite = 0; nframes = 0; delete frames
    }
  ' | sort -rn | head -30
}

start_burst_capture() {
  local pid=$1 mem=$2 delta=$3
  if [[ -z $pid || $pid == 0 ]]; then
    pid="$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null)"
    if [[ -z $pid || $pid == 0 ]]; then
      emit "BURST-CAPTURE skipped no-target-pid"
      return 0
    fi
    emit "BURST-CAPTURE note falling back to MainPID=$pid"
  fi
  mkdir -p "$CAPTURE_DIR" 2>/dev/null || { emit "BURST-CAPTURE skipped cannot-create-dir"; return 0; }

  # 冷却：避免内存高位期反复触发
  local last=0
  [[ -r $CAPTURE_DIR/.last-capture ]] && last="$(<"$CAPTURE_DIR/.last-capture")"
  local now; now=$(date +%s)
  (( now - last < CAPTURE_COOLDOWN )) && return 0
  printf '%s' "$now" >"$CAPTURE_DIR/.last-capture" 2>/dev/null

  # 后台执行：采样循环必须继续（捕获期内还要留内存曲线）。
  # 锁由子 shell 自己建立、写入自身 PID：采样器若在捕获途中被杀（systemd 会杀掉整个 cgroup），
  # 锁会因持有者已消失而被判为陈旧并回收——否则一次中断就会永久堵死后续所有捕获。
  (
    set -u
    local lockf="$CAPTURE_DIR/.capture.lock"
    local owner
    if ! { set -o noclobber; printf '%s' "$BASHPID" >"$lockf"; } 2>/dev/null; then
      owner="$(<"$lockf")" 2>/dev/null || owner=''
      if [[ $owner =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
        exit 0
      fi
      rm -f "$lockf"
      emit "BURST-CAPTURE stale-lock recovered owner=${owner:-?}"
      { set -o noclobber; printf '%s' "$BASHPID" >"$lockf"; } 2>/dev/null || exit 0
    fi
    trap 'rm -f "$lockf"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    local stamp; stamp="$(date +%Y%m%dT%H%M%S%z)"
    local data="$CAPTURE_DIR/perf-burst-$stamp.data"
    local report="$CAPTURE_DIR/burst-$stamp.txt"
    local mapfile="/tmp/perf-$pid.map"
    local err=''
    emit "BURST-CAPTURE start pid=$pid mem=$mem delta=$delta seconds=$CAPTURE_SECONDS"

    if ! command -v perf >/dev/null 2>&1; then
      err='perf not found'
    elif ! perf record -p "$pid" -g -F 500 -o "$data" -- sleep "$CAPTURE_SECONDS" >/dev/null 2>&1; then
      err="perf record failed (pid=$pid)"
    fi

    if [[ -n $err ]]; then
      emit "BURST-CAPTURE failed: $err"
      rm -f "$data"
      exit 0
    fi

    {
      printf 'burst-capture %s\n' "$stamp"
      printf 'target_pid=%s mem_at_trigger=%s delta=%s capture_seconds=%s\n' "$pid" "$mem" "$delta" "$CAPTURE_SECONDS"
      printf 'perf_map=%s\n' "$mapfile"
      printf '\n=== top symbols (userspace) ===\n'
      # 内核地址在本机不可符号化（kallsyms 受限），全是噪声，直接滤掉
      timeout 120 perf report -i "$data" --stdio --no-children -g none 2>/dev/null \
        | awk '$1 ~ /%$/ && $0 !~ /\[unknown\]/ {print}' | head -30
      printf '\n=== JS frames in large-memory-write stacks (count) ===\n'
      timeout 180 perf script -i "$data" 2>/dev/null | js_frames_in_copies
    } >"$report" 2>&1

    [[ -r $mapfile ]] && cp -f "$mapfile" "$CAPTURE_DIR/perf-map-$stamp.map" 2>/dev/null
    rm -f "$data"
    emit "BURST-CAPTURE done report=$report"

    # 只保留最近 KEEP_CAPTURES 份报告（连同其 perf map）
    if (( KEEP_CAPTURES > 0 )); then
      while read -r old; do
        local base="${old##*/}"; base="${base#burst-}"; base="${base%.txt}"
        rm -f "$old" "$CAPTURE_DIR/perf-map-$base.map"
      done < <(ls -1t "$CAPTURE_DIR"/burst-*.txt 2>/dev/null | tail -n +$((KEEP_CAPTURES + 1)))
    fi
  ) &
}

# 分片睡眠：每 FAST_INTERVAL 探一次 memory.current，增量超阈值即判定突发，
# 触发捕获后提前返回，让主循环立刻转入高位采样。
sleep_with_burst_watch() {
  local prev=$1 pid=$2 total=$3
  local steps nxt i
  steps="$(awk -v a="$total" -v b="$FAST_INTERVAL" 'BEGIN { n = a / b; printf "%d", (n < 1 ? 1 : (n == int(n) ? n : int(n) + 1)) }')"
  if (( steps <= 0 )); then
    sleep "$total"
    return 0
  fi
  for ((i = 0; i < steps; i++)); do
    sleep "$FAST_INTERVAL"
    nxt="$(cgval "$cg/memory.current")" || nxt=$prev
    if (( nxt - prev > BURST_DELTA )); then
      emit "BURST-DETECTED mem=$nxt prev=$prev delta=$((nxt - prev)) pid=${pid:-?}"
      start_burst_capture "$pid" "$nxt" "$((nxt - prev))"
      return 0
    fi
    prev=$nxt
  done
}

cg=''

resolve_cg() {
  local c
  c="$(systemctl --user show "$UNIT" -p ControlGroup --value 2>/dev/null)" || return 1
  [[ -n $c ]] || return 1
  cg="$CG_ROOT$c"
  [[ -d $cg ]]
}

ticks=0
last_pids=''
unit_reported=1

emit "SAMPLER-START unit=$UNIT base_interval=${BASE_INTERVAL}s hot_interval=${HOT_INTERVAL}s hot_bytes=$HOT_BYTES max_bytes=$MAX_BYTES fast_interval=${FAST_INTERVAL}s burst_delta=$BURST_DELTA capture_seconds=$CAPTURE_SECONDS capture_dir=$CAPTURE_DIR pid=$$"

while true; do
  # 每 5 分钟或 cgroup 路径失效时重新解析（单元重启/用户管理器重建）
  if (( ticks % 20 == 0 )) || [[ ! -d ${cg:-/nonexistent} ]]; then
    if resolve_cg; then
      unit_reported=1
    else
      if (( unit_reported )); then
        emit "UNIT-GONE unit=$UNIT (采样暂停，仅重试解析)"
        unit_reported=0
      fi
      sleep "$BASE_INTERVAL"
      ticks=$((ticks + 1))
      continue
    fi
  fi

  cur="$(cgval "$cg/memory.current")" || cur=0
  peak="$(cgval "$cg/memory.peak")" || peak=0
  swap="$(cgval "$cg/memory.swap.current")" || swap=0
  statkv="$(readkv "$cg/memory.stat" anon file kernel slab shmem)"
  evkv="$(readkv "$cg/memory.events" high max oom oom_kill)"
  psi="$(read_pressure_total "$cg/memory.pressure")"

  pids=''
  top_pid=''
  top_rss=0
  if [[ -r $cg/cgroup.procs ]]; then
    while read -r pid; do
      [[ -n $pid && -r /proc/$pid/status ]] || continue
      st="$(proc_field "$pid" State)"; st=${st:-?}
      rss="$(proc_field "$pid" VmRSS)"; rss=${rss:-0}
      th="$(proc_field "$pid" Threads)"; th=${th:-0}
      pids+="$pid/$st/$rss/$th,"
      # 捕获目标：cgroup 内 VmRSS 最大的进程，即真正在膨胀的 server 进程
      if (( rss > top_rss )); then top_rss=$rss; top_pid=$pid; fi
    done <"$cg/cgroup.procs"
  fi
  pids=${pids%,}

  # PID 集合变化 = 网关重启，单独打一行便于标注时间线
  if [[ $pids != "$last_pids" ]]; then
    emit "PROCS-CHANGED procs=$pids"
    last_pids=$pids
  fi

  emit "SAMPLE cur=$cur peak=$peak swap=$swap $statkv $evkv psi_some_total=${psi:-0} procs=$pids"

  if (( ticks % 20 == 0 )); then
    size="$(stat -c %s "$OUT" 2>/dev/null || echo 0)"
    if (( size > MAX_BYTES )); then
      mv -f "$OUT" "$OUT.1"
      emit "ROTATED prev_size=$size"
    fi
  fi

  # 内存高位时提高采样率，抓细节；否则维持常态间隔保证有长期基线。
  # 两种情况都分片睡眠并盯着突发（突发是同步巨额分配，必须在事件循环被阻塞前就动手采）。
  if (( cur > HOT_BYTES )); then
    sleep_with_burst_watch "$cur" "$top_pid" "$HOT_INTERVAL"
  else
    sleep_with_burst_watch "$cur" "$top_pid" "$BASE_INTERVAL"
  fi
  ticks=$((ticks + 1))
done
