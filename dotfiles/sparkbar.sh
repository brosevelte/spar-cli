#!/usr/bin/env bash
# Machine vitals as sparklines for the tmux status bar: CPU, memory, GPU, network.
# Installed to ~/.local/bin/sparkbar and called from status-right; see dotfiles/tmux.conf.
#
# Sampling is split from drawing (2026-10-16). `sparkbar --collect-loop` runs as the systemd user
# service dotfiles/sparkbar-sampler.service and appends one sample per metric to a state file under
# /tmp every SPARKBAR_INTERVAL seconds (default 3, matching tmux's status-interval), trimming to
# SPARKBAR_SAMPLES. tmux's status-right runs plain `sparkbar`, which only READS that file and draws.
# Before the split, tmux's status redraw was the sampler, so history only accumulated while a client
# was attached and looking at the bar: detach, switch away, close the laptop lid and the graph went
# blank or showed one giant averaged sample on return. Now history is wall-clock real whether or not
# anyone is watching. If the sampler is not running (state missing or older than three intervals),
# the renderer takes one sample itself so the bar still works -- just with the old gaps.
# CPU and network are RATES and need two samples, so the first tick after a reboot reads 0 rather
# than a meaningless since-boot average.
#
# Three renderers, picked by SPARKBAR_STYLE (default `braille`):
#   braille -- a 2x4 dot-matrix LINE plot, one dot per sample, two samples per cell, so 32 samples
#              (~96s) fit where 16 bars did. U+2800 glyphs: Unicode 3.0, width 1 in every layer
#              between the script and the pixels (glibc, tmux, mosh, Ghostty). The default because
#              it is the only two-per-cell style that survives mosh -- see octants.
#   octants -- the same 2x4 geometry as solid bars: Unicode 16 octant blocks (U+1CD00..). Heavier
#              and prettier, but NOT over mosh: glibc 2.39 (Unicode 15.1) and mosh 1.4.0 return
#              wcwidth -1 for them while tmux 3.4 and Ghostty count 1, so mosh's screen model and
#              the real glyph positions drift by the number of octants on screen. Because that
#              count changes every tick, the cloud at the far right moves without mosh repainting
#              the cells it left, and a ghost cloud (or two) stays on screen at a varying distance
#              (seen 2026-10-19). Fine over plain ssh, or once mosh ships Unicode 16 tables.
#   bars    -- the classic ▁▂▃▄▅▆▇█ sparkline, one sample per cell, eight levels, rendered by
#              holman/spark (github.com/holman/spark). It installs as `spark` -- same name as the
#              laptop-side CLI in this repo, but a different machine, so they never share a PATH:
#                curl -fsSL https://raw.githubusercontent.com/holman/spark/master/spark -o ~/.local/bin/spark
#                chmod +x ~/.local/bin/spark
# Nothing off the shelf keeps rolling history for a status bar, so the sampling below is ours;
# only the drawing is delegated (bars) or a few lines of bit-twiddling (braille).
#
# GPU memory is deliberately absent: on a GB10 the GPU shares system RAM and nvidia-smi reports
# memory.used/total as [N/A]. The MEM figure already accounts for it.
set -uo pipefail

STATE="/tmp/sparkbar-${USER:-$(id -un)}.state"
STYLE=${SPARKBAR_STYLE:-braille}
N=${SPARKBAR_SAMPLES:-$([ "$STYLE" = bars ] && echo 16 || echo 32)}
INTERVAL=${SPARKBAR_INTERVAL:-3}

# Segment labels: three-letter words by default. SPARKBAR_LABELS=icons swaps in Nerd Font Material
# icons (network U+F06F3, chip U+F061A, memory U+F035B, expansion card U+F08AE); tried and
# rejected 2026-10-16 as busier than the words, kept for anyone who disagrees. The icons declare one
# cell but draw wider in the non-Mono Nerd Font faces, hence the trailing space in each label.
if [ "${SPARKBAR_LABELS:-text}" = icons ]; then
  L_NET=$(printf '\U000F06F3 ') L_CPU=$(printf '\U000F061A ') L_MEM=$(printf '\U000F035B ') L_GPU=$(printf '\U000F08AE ')
else
  L_NET='NET ' L_CPU='CPU ' L_MEM='MEM ' L_GPU='GPU '
fi
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

# Braille dot bits, top to bottom: left column dots 1,2,3,7 = 0x01 0x02 0x04 0x40; right column
# dots 4,5,6,8 = 0x08 0x10 0x20 0x80. Indexed by level 0 (floor) .. 3 (top).
BR_L=(0x40 0x04 0x02 0x01)
BR_R=(0x80 0x20 0x10 0x08)

# Octant bars: OCT[a*5+b] is the cell whose left column has `a` of 4 blocks lit from the bottom and
# whose right column has `b`. Built from Unicode 16 UnicodeData.txt (BLOCK OCTANT-<cells>) plus the
# twenty-odd combinations that already existed as block elements / quadrants / U+1CEAx and so have
# no OCTANT name. Regenerate rather than hand-edit if the geometry ever changes.
OCT=(0020 1CEA0 2597 1CD96 2590 1CEA3 2582 1CDCB 1CDD3 1CDD5 2596 1CDBB 2584 1CDE1 259F 1CD48 1CDBF 1CDDE 2586 1CDE5 258C 1CDC0 2599 1CDE4 2588)

# octant_bars <lit 0..4 ...> -- two samples per cell; an odd count leaves the first cell's left
# column empty so the newest sample is always the rightmost column.
octant_bars() {
  local -a lv=("$@")
  local i out=""
  ((${#lv[@]} % 2)) && lv=(0 "${lv[@]}")
  for ((i = 0; i < ${#lv[@]}; i += 2)); do
    printf -v out '%s\\U%08x' "$out" "0x${OCT[lv[i] * 5 + lv[i + 1]]}"
  done
  LC_ALL=C.UTF-8 printf "$out"
}

# braille_line <levels 0..3 ...> -- two levels per cell; an odd count leaves the first cell's
# left column empty so the newest sample is always the rightmost dot.
braille_line() {
  local -a lv=("$@")
  local i cp out=""
  ((${#lv[@]} % 2)) && lv=(-1 "${lv[@]}")
  for ((i = 0; i < ${#lv[@]}; i += 2)); do
    cp=0x2800
    ((lv[i] >= 0)) && ((cp |= BR_L[lv[i]]))
    ((lv[i + 1] >= 0)) && ((cp |= BR_R[lv[i + 1]]))
    printf -v out '%s\\u%04x' "$out" "$cp"
  done
  LC_ALL=C.UTF-8 printf "$out"
}

# sparkline <pct|net> <values...>
sparkline() {
  local kind=$1 x
  shift
  local -a v=("$@")
  ((${#v[@]})) || return
  if [ "$STYLE" = braille ] || [ "$STYLE" = octants ]; then
    # Four levels, 0..3. Fixed scale for percentages: 0-24, 25-49, 50-74, 75-100. Braille lights
    # the dot AT the level (0 = floor dot); octants light level+1 blocks from the bottom, so the
    # floor is a one-quarter bar like the old ▁ and a full bar means >=75%.
    local -a lv=()
    if [ "$kind" = pct ]; then
      for x in "${v[@]}"; do lv+=($((x >= 75 ? 3 : x / 25))); done
    else
      local min=${v[0]} max=${v[0]}
      for x in "${v[@]}"; do ((x < min)) && min=$x; ((x > max)) && max=$x; done
      if ((min == max)); then
        for x in "${v[@]}"; do lv+=($((min > 0 ? 1 : 0))); done
      else
        for x in "${v[@]}"; do lv+=($(((x - min) * 3 / (max - min)))); done
      fi
    fi
    if [ "$STYLE" = octants ]; then
      local -a lit=()
      for x in "${lv[@]}"; do lit+=($((x + 1))); done
      octant_bars "${lit[@]}"
    else
      braille_line "${lv[@]}"
    fi
    return
  fi
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

# AWS SSO state: ok / idle / expired / none, from the shared `aws-sso-state` helper (installed next
# to this script; the shell prompt reads the same one, so the two clouds agree). idle = the access
# token lapsed and a renewal probe is in flight -- NOT an auth failure, do not re-login; expired =
# the probe failed or nothing is left to renew with: run `spark auth aws` from the laptop.
aws_state() {
  aws-sso-state 2>/dev/null || printf 'none'
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

# collect -- take one sample of every metric and roll it into the state file.
collect() {
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
    { read -r p_now p_busy p_total p_rx p_tx; read -r _; read -r h_cpu; read -r h_mem; read -r h_gpu; read -r h_net; } < "$STATE" 2>/dev/null || true
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
  # Line 1: raw counters for the next rate. Line 2: everything the renderer shows. Lines 3-6: history.
  # Written via a temp file + mv so a tmux tick never reads a half-written state.
  printf '%s %s %s %s %s\n%s %s %s %s %s %s %s %s %s\n%s\n%s\n%s\n%s\n' \
    "$now" "$busy" "$total" "$rx" "$tx" \
    "$cpu_pct" "$rx_rate" "$tx_rate" "$mem_used_gb" "$mem_total_gb" "$mem_pct" "$gpu_pct" "${g_temp:-?}" "$g_watt" \
    "$h_cpu" "$h_mem" "$h_gpu" "$h_net" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
}

# render -- draw the status line from the state file. Takes a sample itself only when the sampler
# service is not keeping the file fresh.
render() {
  SEP='#[fg=#4a4f5a] │ '
  local p_now=0
  [ -r "$STATE" ] && read -r p_now _ < "$STATE"
  (( $(date +%s) - p_now > INTERVAL * 3 )) && collect
  { read -r _; read -r cpu_pct rx_rate tx_rate mem_used_gb mem_total_gb mem_pct gpu_pct g_temp g_watt; read -r h_cpu; read -r h_mem; read -r h_gpu; read -r h_net; } < "$STATE"

  gpu_seg=""
  if command -v nvidia-smi >/dev/null 2>&1; then
    gpu_seg=$(printf '#[fg=#8a8a8a]%s%s%s %3d%%#[fg=#6e6e6e] %2s°%3.0fW' \
      "$L_GPU" "$(hue "$gpu_pct")" "$(sparkline pct $h_gpu)" "$gpu_pct" "${g_temp:-?}" "$g_watt")
  fi
  net_seg=$(printf '#[fg=#8a8a8a]%s#[fg=#6ec46e]%s#[fg=#8a8a8a] \u2193%s \u2191%s' \
    "$L_NET" "$(sparkline net $h_net)" "$(rate "$rx_rate")" "$(rate "$tx_rate")")
  cpu_seg=$(printf '#[fg=#8a8a8a]%s%s%s %3d%%' "$L_CPU" "$(hue "$cpu_pct")" "$(sparkline pct $h_cpu)" "$cpu_pct")
  mem_seg=$(printf '#[fg=#8a8a8a]%s%s%s %3d/%sG' "$L_MEM" "$(hue "$mem_pct")" "$(sparkline pct $h_mem)" "$mem_used_gb" "$mem_total_gb")

  # Nerd Font cloud, same glyph the shell prompt uses, so the two agree at a glance.
  case "$(aws_state)" in
    ok)   aws_seg=$(printf '#[fg=#6ec46e]\uf0c2') ;;
    idle) aws_seg=$(printf '#[fg=#d9b44a]\uf0c2') ;;   # amber: renews on next use
    *)    aws_seg=$(printf '#[fg=#e06c6c]\uf0c2') ;;
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
}

case "${1:-}" in
  --collect) collect ;;
  --collect-loop) while :; do collect; sleep "$INTERVAL"; done ;;
  "") render ;;
  *) echo "usage: sparkbar [--collect | --collect-loop]" >&2; exit 2 ;;
esac
