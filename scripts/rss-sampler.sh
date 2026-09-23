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
# 由 systemd 用户单元 literouter-rss-sampler.service 常驻托管。
# 环境变量（均可选）：
#   GATEWAY_UNIT               被采样单元，默认 literouter.service
#   RSS_SAMPLER_LOG            输出文件，默认 <repo>/data/rss-sampler.log
#   RSS_SAMPLER_BASE_INTERVAL  常态采样间隔（秒），默认 15
#   RSS_SAMPLER_HOT_INTERVAL   高位采样间隔（秒），默认 1
#   RSS_SAMPLER_HOT_BYTES      进入高位采样的 memory.current 阈值，默认 400000000
#   RSS_SAMPLER_MAX_BYTES      日志轮转阈值（字节），默认 20000000
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="${GATEWAY_UNIT:-literouter.service}"
OUT="${RSS_SAMPLER_LOG:-$ROOT/data/rss-sampler.log}"
BASE_INTERVAL="${RSS_SAMPLER_BASE_INTERVAL:-15}"
HOT_INTERVAL="${RSS_SAMPLER_HOT_INTERVAL:-1}"
HOT_BYTES="${RSS_SAMPLER_HOT_BYTES:-400000000}"
MAX_BYTES="${RSS_SAMPLER_MAX_BYTES:-20000000}"
CG_ROOT=/sys/fs/cgroup

mkdir -p "$(dirname "$OUT")" 2>/dev/null

ts() { printf '%(%Y-%m-%dT%H:%M:%S%z)T' -1; }
emit() { printf '%s %s\n' "$(ts)" "$*" >>"$OUT"; }

# cgroup 单值文件（去掉换行/制表）
cgval() {
  local v
  v="$(<"$1")" 2>/dev/null || return 1
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

emit "SAMPLER-START unit=$UNIT base_interval=${BASE_INTERVAL}s hot_interval=${HOT_INTERVAL}s hot_bytes=$HOT_BYTES max_bytes=$MAX_BYTES pid=$$"

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
  if [[ -r $cg/cgroup.procs ]]; then
    while read -r pid; do
      [[ -n $pid && -r /proc/$pid/status ]] || continue
      st="$(proc_field "$pid" State)"; st=${st:-?}
      rss="$(proc_field "$pid" VmRSS)"; rss=${rss:-0}
      th="$(proc_field "$pid" Threads)"; th=${th:-0}
      pids+="$pid/$st/$rss/$th,"
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

  # 内存高位时提高采样率，抓细节；否则维持常态间隔保证有长期基线
  if (( cur > HOT_BYTES )); then
    sleep "$HOT_INTERVAL"
  else
    sleep "$BASE_INTERVAL"
  fi
  ticks=$((ticks + 1))
done
