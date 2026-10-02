#!/usr/bin/env bash
# Machine vitals as sparklines for the tmux status bar: CPU, memory, GPU, network.
# Installed to ~/.local/bin/sparkbar and called from status-right; see dotfiles/tmux.conf.
#
# History lives in a state file under /tmp keyed by user: each tick appends one sample per metric
# and trims to SPARKBAR_SAMPLES. At tmux's 3s status-interval, 16 samples is ~48s of history.
# CPU and network are RATES and need two samples, so the first tick after a reboot reads 0 rather
# than a meaningless since-boot average.
#
# Sparklines are rendered by holman/spark (github.com/holman/spark), the canonical shell
# sparkline. Note it installs as `spark` -- same name as the laptop-side CLI in this repo, but a
# different machine, so they never share a PATH. Install:
#   curl -fsSL https://raw.githubusercontent.com/holman/spark/master/spark -o ~/.local/bin/spark
#   chmod +x ~/.local/bin/spark
# Nothing off the shelf keeps rolling history for a status bar, so the sampling below is ours;
# only the drawing is delegated.
#
# GPU memory is deliberately absent: on a GB10 the GPU shares system RAM and nvidia-smi reports
# memory.used/total as [N/A]. The MEM figure already accounts for it.
set -uo pipefail

STATE="/tmp/sparkbar-${USER:-$(id -un)}.state"
N=${SPARKBAR_SAMPLES:-16}
SPARK=${SPARK_BIN:-$(command -v spark || echo "$HOME/.local/bin/spark")}

# Percentages are drawn on a FIXED 0-100 scale; network autoscales.
#
# Percentages were briefly autoscaled (2026-09-23) so idle variation stayed visible, and reverted
# the next day: with training running on the box, autoscale drew 2% idle noise as a full-height
# bar -- exactly when a bar has to mean real load. A fixed scale makes height absolute, so a tall
# bar is always a busy machine, and the three percentages are comparable to each other. The
# number beside each line still carries the fine detail.
#
# spark itself always autoscales to the largest value it is given, so the scale is pinned by
# prepending 0 and 100 as sentinels and stripping the two glyphs they produce. sed counts
# characters (not bytes) under a UTF-8 locale, which these 3-byte glyphs need.
#
# Network has no ceiling to be absolute against, so it keeps autoscaling -- shape is the signal
# there. One correction: spark renders a FLAT series at mid height (min == max), so a flat window
# is drawn as floor when idle and mid when steady.
BARS=(▁ ▂ ▃ ▄ ▅ ▆ ▇ █)

# sparkline <pct|net> <values...>
sparkline() {
  local kind=$1 x
  shift
  local -a v=("$@")
  ((${#v[@]})) || return
  if [ "$kind" = pct ]; then
    LC_ALL=C.UTF-8 "$SPARK" 0 100 "${v[@]}" | LC_ALL=C.UTF-8 sed 's/^..//'
    return
  fi
  local min=${v[0]} max=${v[0]}
  for x in "${v[@]}"; do ((x < min)) && min=$x; ((x > max)) && max=$x; done
  if ((min == max)); then
    printf "${BARS[$(( min > 0 ? 4 : 0 ))]}%.0s" "${v[@]}"
    return
  fi
  LC_ALL=C.UTF-8 "$SPARK" "${v[@]}"
}

# Green under 60, amber under 85, red above — the reading you'd get from a glance at iStat.
hue() {
  if (($1 < 60)); then printf '#[fg=#6ec46e]'
  elif (($1 < 85)); then printf '#[fg=#e0c060]'
  else printf '#[fg=#e06c6c]'
  fi
}

# AWS SSO state. Read from the token cache rather than $AWS_PROFILE: tmux runs this with the
# server's environment, which may predate `spark auth aws`, and the token is the thing that
# actually expires. The file list is collected before grepping -- piping an empty list into
# `xargs grep` runs grep with no operands, and it then reads stdin and hangs the prompt forever.
aws_state() {
  local files exp now
  files=$(grep -l '"accessToken"' "$HOME"/.aws/sso/cache/*.json 2>/dev/null)
  [ -n "$files" ] || { printf 'none'; return; }
  exp=$(grep -ho '"expiresAt": *"[^"]*"' $files 2>/dev/null | sed 's/.*"\([^"]*\)".*/\1/' | sort | tail -1)
  exp=${exp:0:19}
  now=$(date -u +%Y-%m-%dT%H:%M:%S)
  if [ -n "$exp" ] && [[ "$exp" > "$now" ]]; then printf 'ok'; else printf 'expired'; fi
}

# bytes/sec -> a FIXED four characters, always: 3 digits plus a unit. A variable-width field
# here shifts every segment to its left on each tick (9K -> 10K), which reads as the whole bar
# twitching. SI thresholds (1000, not 1024) keep the mantissa at 3 digits, and network rates are
# conventionally quoted in SI anyway.
rate() {
  local b=$1
  if ((b < 1000)); then printf '%3dB' "$b"
  elif ((b < 1000000)); then printf '%3dK' $((b / 1000))
  elif ((b < 1000000000)); then printf '%3dM' $((b / 1000000))
  else printf '%3dG' $((b / 1000000000))
  fi
}

# Keep the last N of "<history> <new>".
trim() {
  local -a a=($1 $2)
  ((${#a[@]} > N)) && a=("${a[@]: -N}")
  printf '%s' "${a[*]}"
}

now=$(date +%s)

read -r _ u n s i w irq sirq st _ < /proc/stat
total=$((u + n + s + i + w + irq + sirq + st))
busy=$((total - i - w))

IFACE=$(ip route show default 2>/dev/null | awk '{print $5; exit}')
rx=0 tx=0
if [ -n "${IFACE:-}" ] && [ -d "/sys/class/net/$IFACE/statistics" ]; then
  rx=$(< "/sys/class/net/$IFACE/statistics/rx_bytes")
  tx=$(< "/sys/class/net/$IFACE/statistics/tx_bytes")
fi

mem_total_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
mem_avail_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
mem_used_gb=$(((mem_total_kb - mem_avail_kb) / 1048576))
mem_total_gb=$((mem_total_kb / 1048576))
mem_pct=$(((mem_total_kb - mem_avail_kb) * 100 / mem_total_kb))

SEP='#[fg=#4a4f5a] │ '
gpu_pct=0 g_temp="?" g_watt=0
if command -v nvidia-smi >/dev/null 2>&1; then
  # One call for every field; nvidia-smi costs ~25ms, so don't invoke it more than once.
  IFS=, read -r gpu_pct g_temp g_watt < <(
    nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw \
      --format=csv,noheader,nounits 2>/dev/null | head -1
  )
  gpu_pct=${gpu_pct// /}; g_temp=${g_temp// /}; g_watt=${g_watt// /}
  [[ $gpu_pct =~ ^[0-9]+$ ]] || gpu_pct=0
  [[ $g_watt =~ ^[0-9.]+$ ]] || g_watt=0
fi

cpu_pct=0 net_rate=0 rx_rate=0 tx_rate=0
h_cpu="" h_mem="" h_gpu="" h_net=""
if [ -r "$STATE" ]; then
  { read -r p_now p_busy p_total p_rx p_tx; read -r h_cpu; read -r h_mem; read -r h_gpu; read -r h_net; } < "$STATE" 2>/dev/null || true
  span=$((now - ${p_now:-now}))
  d_total=$((total - ${p_total:-0}))
  ((d_total > 0)) && cpu_pct=$(((busy - ${p_busy:-0}) * 100 / d_total))
  if ((span > 0)); then
    rx_rate=$(((rx - ${p_rx:-0}) / span))
    tx_rate=$(((tx - ${p_tx:-0}) / span))
  fi
fi
((cpu_pct < 0)) && cpu_pct=0
((rx_rate < 0)) && rx_rate=0
((tx_rate < 0)) && tx_rate=0
net_rate=$((rx_rate + tx_rate))

h_cpu=$(trim "${h_cpu:-}" "$cpu_pct")
h_mem=$(trim "${h_mem:-}" "$mem_pct")
h_gpu=$(trim "${h_gpu:-}" "$gpu_pct")
h_net=$(trim "${h_net:-}" "$net_rate")
printf '%s %s %s %s %s\n%s\n%s\n%s\n%s\n' "$now" "$busy" "$total" "$rx" "$tx" "$h_cpu" "$h_mem" "$h_gpu" "$h_net" > "$STATE"

gpu_seg=""
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_seg=$(printf '#[fg=#8a8a8a]GPU %s%s %3d%%#[fg=#6e6e6e] %2s°%3.0fW' \
    "$(hue "$gpu_pct")" "$(sparkline pct $h_gpu)" "$gpu_pct" "${g_temp:-?}" "$g_watt")
fi
net_seg=$(printf '#[fg=#8a8a8a]NET #[fg=#6ec46e]%s#[fg=#8a8a8a] \u2193%s \u2191%s' \
  "$(sparkline net $h_net)" "$(rate "$rx_rate")" "$(rate "$tx_rate")")
cpu_seg=$(printf '#[fg=#8a8a8a]CPU %s%s %3d%%' "$(hue "$cpu_pct")" "$(sparkline pct $h_cpu)" "$cpu_pct")
mem_seg=$(printf '#[fg=#8a8a8a]MEM %s%s %3d/%sG' "$(hue "$mem_pct")" "$(sparkline pct $h_mem)" "$mem_used_gb" "$mem_total_gb")

# Nerd Font cloud, same glyph the shell prompt uses, so the two agree at a glance.
case "$(aws_state)" in
  ok) aws_seg=$(printf '#[fg=#6ec46e]\uf0c2') ;;
  *)  aws_seg=$(printf '#[fg=#e06c6c]\uf0c2') ;;
esac

# Segment order, left to right. Network leads so that on a narrow client (a phone) the least
# glanceable segment is the one pushed off the edge first, not CPU or GPU. Override per-box with
# SPARKBAR_ORDER; an absent segment (no GPU) is simply skipped along with its separator.
ORDER=${SPARKBAR_ORDER:-net cpu mem gpu aws}
out=""
for key in $ORDER; do
  case $key in
    net) seg=$net_seg ;; cpu) seg=$cpu_seg ;; mem) seg=$mem_seg ;;
    gpu) seg=$gpu_seg ;; aws) seg=$aws_seg ;; *) seg="" ;;
  esac
  [ -n "$seg" ] && out+="${out:+$SEP}$seg"
done
# Two trailing spaces: the Nerd Font cloud is drawn wider than the one cell it declares.
printf '%s  #[default]\n' "$out"
