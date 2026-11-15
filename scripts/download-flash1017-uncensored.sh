#!/usr/bin/env bash
# Self-repairing download of dealignai/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8
# onto spark1's 8 TB exFAT store, in flat (--local-dir) form. DOWNLOAD ONLY —
# this never touches the running dsv41-* containers.
#
# Runs ON spark1 (edgexpert-74a6, 100.79.103.61). Installed copy:
#   ~/dsv41-uncensored-download/download.sh
#
#   download.sh start    start/resume detached in tmux session "dsv41-unc" (no-op if running)
#   download.sh run      the retry loop in the foreground (what tmux runs)
#   download.sh status   one-screen status: state, bytes on disk, throughput, ETA
#   download.sh verify   size-check every file vs the HF manifest -> "complete" | "N files missing/wrong"
#   download.sh verify --deep   also sha256 every LFS shard (slow: ~510 GB read over USB)
#   download.sh stop     stop the tmux session (partial files are kept and resumed)
#
# Self-repair:
#   resumable   hf --local-dir keeps .incomplete files under DEST/.cache and resumes them;
#               completed files are skipped because only missing/wrong-sized ones are requested.
#   retrying    bounded loop (MAX_ATTEMPTS) with exponential backoff; stall watchdog kills an
#               attempt whose bytes stop growing for STALL_SECS; memory guard kills it if
#               spark1's MemAvailable falls under MEM_FLOOR_MB (spark1 is a serving node).
#
# Why HTTP, not Xet: spark1 reaches the internet over 1 GbE (enP7s7, ~120 MB/s), and on
# 2026-11-15 Xet (HF_XET_HIGH_PERFORMANCE=1) ramped to ~124 concurrent 61 MB range-gets
# buffered in RAM: 13.8 GB RSS + 7 GB swap within 2 minutes, swap full, 5 GB left on a node
# running dsv41-worker. Plain HTTP streams straight into DEST/.cache/huggingface/download/
# *.incomplete with bounded memory, resumes at the byte level, and saturates 1 GbE anyway.
# hf_transfer (HF_HUB_ENABLE_HF_TRANSFER) is ignored by huggingface_hub >= 1.0.
#   verifying   manifest = HF tree API (recursive) pinned to one commit sha; every file is
#               checked for existence + exact byte size; wrong-sized files are deleted and
#               re-fetched. Nothing is declared complete until verify passes.
#   detached    tmux session + STATE_DIR/status file, survives a dropped SSH session.
#   idempotent  `verify` can be run at any time, during or after the download.
set -uo pipefail

REPO=dealignai/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8
DEST=${DEST:-/mnt/models-ext/Models/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8}
STATE_DIR=${STATE_DIR:-$HOME/dsv41-uncensored-download}
SESSION=dsv41-unc
HF=${HF:-$HOME/.local/bin/hf}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-40}
STALL_SECS=${STALL_SECS:-900}
MIN_FREE_GB=${MIN_FREE_GB:-20}
USE_XET=${USE_XET:-0}        # default plain HTTP — see "Why HTTP" below
MEM_FLOOR_MB=${MEM_FLOOR_MB:-8000}   # kill the attempt if spark1 MemAvailable drops below this
MAX_WORKERS=${MAX_WORKERS:-8}
BASE_REPO=deepseek-ai/DeepSeek-V4.1-Flash-1017
BASE_REV=1bae0e1088993b9b82de08f59de5be5a34e42170   # the revision the cluster serves
SEED_DIR=${SEED_DIR:-$HOME/dsv41-model}            # set SEED_DIR=/nonexistent to disable

MANIFEST=$STATE_DIR/manifest.tsv   # path<TAB>size<TAB>sha256-or-empty
REVFILE=$STATE_DIR/revision
STATUS=$STATE_DIR/status
LOG=$STATE_DIR/download.log
HFLOG=$STATE_DIR/hf.log

mkdir -p "$STATE_DIR"
log()    { echo "$(date '+%F %T') $*" | tee -a "$LOG" >&2; }
status() { echo "$(date '+%F %T') $*" > "$STATUS"; }
seedstat() { echo "$(date '+%F %T') $*" > "$STATE_DIR/seed-status"; }

# Pin the revision once so a later push to main can't mix two checkpoints.
revision() {
  if [[ -s $REVFILE ]]; then cat "$REVFILE"; return; fi
  local sha
  sha=$(curl -sf -m 30 "https://huggingface.co/api/models/$REPO" |
        python3 -I -c 'import json,sys; print(json.load(sys.stdin)["sha"])') || return 1
  echo "$sha" > "$REVFILE"; echo "$sha"
}

fetch_manifest() {
  [[ -s $MANIFEST ]] && return 0
  local rev; rev=$(revision) || return 1
  curl -sf -m 60 "https://huggingface.co/api/models/$REPO/tree/$rev?recursive=true" |
    python3 -I -c '
import json, sys
for f in json.load(sys.stdin):
    if f["type"] != "file":
        continue
    sha = (f.get("lfs") or {}).get("oid", "")
    print("\t".join([f["path"], str(f["size"]), sha]))' >"$MANIFEST.tmp" || { rm -f "$MANIFEST.tmp"; return 1; }
  [[ -s $MANIFEST.tmp ]] || { rm -f "$MANIFEST.tmp"; return 1; }
  mv "$MANIFEST.tmp" "$MANIFEST"
}

# Prints the paths that are missing or wrong-sized. Deletes wrong-sized finals
# (a truncated/oversized final file would otherwise be skipped by hf).
bad_files() {
  local fix=${1:-}
  while IFS=$'\t' read -r path size _; do
    local f=$DEST/$path have
    if [[ -L $f ]]; then echo "$path"; [[ $fix == fix ]] && rm -f "$f"; continue; fi
    have=$(stat -c %s "$f" 2>/dev/null) || { echo "$path"; continue; }
    if [[ $have != "$size" ]]; then
      echo "$path"
      [[ $fix == fix ]] && { log "wrong size $path: have $have want $size -> deleting"; rm -f "$f"; }
    fi
  done < "$MANIFEST"
}

# 21 of the 48 shards are byte-identical to the base deepseek-ai/DeepSeek-V4.1-Flash-1017
# (same LFS sha256), incl. the two ~101 GB shards. spark1 already holds the base checkpoint
# locally (SEED_DIR, the dir the dsv41-worker container serves from), so those ~310 GB are
# copied locally instead of downloaded. A seed is only used when the base repo's sha256 equals
# the target's AND the local file hashes to it, so a bad local copy can never be seeded.
fetch_base_manifest() {
  local base=$STATE_DIR/base-manifest.tsv
  [[ -s $base ]] && return 0
  curl -sf -m 60 "https://huggingface.co/api/models/$BASE_REPO/tree/$BASE_REV?recursive=true" |
    python3 -I -c '
import json, sys
for f in json.load(sys.stdin):
    if f["type"] == "file" and f.get("lfs"):
        print(f["path"] + "\t" + f["lfs"]["oid"])' > "$base.tmp" && [[ -s $base.tmp ]] && mv "$base.tmp" "$base" ||
    { rm -f "$base.tmp"; log "seed: cannot fetch base manifest, downloading everything"; return 1; }
}

seed_from_base() {
  [[ -d $SEED_DIR ]] || { log "seed: $SEED_DIR absent, downloading everything"; return 0; }
  local base=$STATE_DIR/base-manifest.tsv
  [[ -s $base ]] || { log "seed: no base manifest, skipping seeding"; return 0; }
  local path size sha bsha
  while IFS=$'\t' read -r path size sha; do
    [[ -n $sha ]] || continue
    [[ $(stat -c %s "$DEST/$path" 2>/dev/null) == "$size" ]] && continue
    bsha=$(awk -F'\t' -v p="$path" '$1==p {print $2}' "$base")
    [[ $bsha == "$sha" ]] || continue
    [[ $(stat -c %s "$SEED_DIR/$path" 2>/dev/null) == "$size" ]] || continue
    seedstat "hashing $path in $SEED_DIR"
    if [[ $(sha256sum "$SEED_DIR/$path" | cut -d' ' -f1) != "$sha" ]]; then
      log "seed: $SEED_DIR/$path sha256 mismatch — will download it instead"; continue
    fi
    seedstat "copying $path ($((size/1000000000)) GB) from $SEED_DIR"
    mkdir -p "$(dirname "$DEST/$path")"
    if cp "$SEED_DIR/$path" "$DEST/$path.seed-part" && mv "$DEST/$path.seed-part" "$DEST/$path"; then
      log "seed: copied $path ($size bytes) from local base checkpoint"
    else
      rm -f "$DEST/$path.seed-part"; log "seed: copy of $path failed — will download it"
    fi
  done < "$MANIFEST"
  seedstat "finished"
}

# Paths the seeder may still supply (base sha == target sha, local file of the right size).
seedable() {
  local base=$STATE_DIR/base-manifest.tsv
  [[ -s $base && -d $SEED_DIR ]] || return 0
  awk -F'\t' 'NR==FNR {b[$1]=$2; next} $3!="" && b[$1]==$3 {print $1"\t"$2}' "$base" "$MANIFEST" |
    while IFS=$'\t' read -r path size; do
      [[ $(stat -c %s "$SEED_DIR/$path" 2>/dev/null) == "$size" ]] && echo "$path"
    done
}

total_bytes()  { awk -F'\t' '{s+=$2} END {print s}' "$MANIFEST"; }
# Bytes landed = finished files + in-flight .incomplete files under DEST/.cache.
landed_bytes() { du -sb --apparent-size "$DEST" 2>/dev/null | cut -f1; }

cmd_verify() {
  fetch_manifest || { echo "cannot fetch manifest from huggingface.co"; return 2; }
  local bad n total
  bad=$(bad_files); n=$(grep -c . <<<"$bad")
  total=$(wc -l < "$MANIFEST")
  if (( n == 0 )); then
    if [[ ${1:-} == --deep ]]; then
      local fails=0
      while IFS=$'\t' read -r path size sha; do
        [[ -n $sha ]] || continue
        local got; got=$(sha256sum "$DEST/$path" | cut -d' ' -f1)
        if [[ $got != "$sha" ]]; then echo "SHA MISMATCH $path"; fails=$((fails+1)); fi
      done < "$MANIFEST"
      (( fails == 0 )) || { echo "$fails shards failed sha256"; return 1; }
      echo "complete ($total files, sizes + sha256 verified, rev $(cat "$REVFILE"))"
    else
      echo "complete ($total files, sizes verified, rev $(cat "$REVFILE"))"
    fi
    return 0
  fi
  echo "$n of $total files missing or wrong-sized"
  sed 's/^/  /' <<<"$bad" | head -60
  return 1
}

cmd_status() {
  echo "status : $(cat "$STATUS" 2>/dev/null || echo 'never started')"
  [[ -s $STATE_DIR/seed-status ]] && echo "seed   : $(cat "$STATE_DIR/seed-status")"
  if tmux has-session -t "$SESSION" 2>/dev/null; then echo "tmux   : running (tmux attach -t $SESSION)"; else echo "tmux   : not running"; fi
  [[ -s $MANIFEST ]] || return 0
  local tot land a b
  tot=$(total_bytes)
  a=$(landed_bytes); sleep 10; b=$(landed_bytes)
  land=${b:-0}
  python3 -I - "$tot" "$land" "${a:-0}" <<'PY'
import sys
tot, land, a = map(int, sys.argv[1:])
rate = max(land - a, 0) / 10
print(f"landed : {land/1e9:,.1f} / {tot/1e9:,.1f} GB ({100*land/tot:.1f}%)")
if rate > 0:
    eta = (tot - land) / rate
    print(f"rate   : {rate/1e6:,.1f} MB/s (10 s sample)   ETA: {eta/3600:.1f} h")
else:
    print("rate   : 0 MB/s in the last 10 s")
PY
  echo "free   : $(df -h --output=avail /mnt/models-ext | tail -1 | tr -d ' ') on /mnt/models-ext"
  tail -3 "$LOG" 2>/dev/null | sed 's/^/log    : /'
}

cmd_run() {
  mountpoint -q /mnt/models-ext || { status "FAILED: /mnt/models-ext not mounted"; log "store not mounted"; return 1; }
  mkdir -p "$DEST"
  export HF_HUB_DOWNLOAD_TIMEOUT=60 HF_HUB_DISABLE_PROGRESS_BARS=1 HF_HUB_DISABLE_SYMLINKS_WARNING=1
  local attempt=0 backoff=30 seedpid=0 mode
  find "$DEST" -maxdepth 1 -name '*.seed-part' -delete 2>/dev/null   # leftovers of an interrupted seed
  # Seeding (local NVMe -> USB) runs alongside the internet download of the other shards;
  # while it runs, seedable files are kept out of the download list.
  if [[ -d $SEED_DIR ]] && fetch_manifest && fetch_base_manifest; then
    seed_from_base & seedpid=$!
  fi
  while (( attempt < MAX_ATTEMPTS )); do
    attempt=$((attempt+1))
    if ! fetch_manifest; then
      status "WAITING: cannot reach huggingface.co (attempt $attempt/$MAX_ATTEMPTS)"
      log "manifest fetch failed, sleeping ${backoff}s"; sleep "$backoff"; backoff=$(( backoff*2 > 900 ? 900 : backoff*2 )); continue
    fi
    local rev; rev=$(cat "$REVFILE")
    mapfile -t todo < <(bad_files fix)
    if (( seedpid > 0 )) && kill -0 "$seedpid" 2>/dev/null; then
      mapfile -t todo < <(printf '%s\n' "${todo[@]}" | grep -vxF -f <(seedable) | grep .)
      if (( ${#todo[@]} == 0 )); then
        log "downloads done; waiting for local seeding to finish"; wait "$seedpid"; seedpid=0; attempt=$((attempt-1)); continue
      fi
    fi
    if (( ${#todo[@]} == 0 )); then
      status "DONE: complete and size-verified ($(wc -l < "$MANIFEST") files, rev $rev) -> $DEST"
      log "verify passed — complete"; return 0
    fi
    local need_gb free_gb
    need_gb=$(( ( $(total_bytes) - $(landed_bytes) ) / 1000000000 ))
    free_gb=$(( $(df --output=avail -B1000000000 /mnt/models-ext | tail -1) ))
    if (( free_gb < need_gb + MIN_FREE_GB )); then
      status "FAILED: need ~${need_gb} GB, only ${free_gb} GB free on /mnt/models-ext"; log "disk short"; return 1
    fi
    local avail0; avail0=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
    if (( avail0 < MEM_FLOOR_MB * 3 / 2 )); then
      status "WAITING: only ${avail0} MB RAM available on spark1 (attempt $attempt/$MAX_ATTEMPTS)"
      log "low memory (${avail0} MB), sleeping ${backoff}s"; sleep "$backoff"; backoff=$(( backoff*2 > 900 ? 900 : backoff*2 )); continue
    fi
    if [[ $USE_XET == 1 ]]; then unset HF_HUB_DISABLE_XET; mode=xet; else export HF_HUB_DISABLE_XET=1; mode=http; fi
    log "attempt $attempt/$MAX_ATTEMPTS mode=$mode: ${#todo[@]} files to fetch, ~${need_gb} GB left, ${free_gb} GB free"
    status "DOWNLOADING attempt $attempt/$MAX_ATTEMPTS mode=$mode, ${#todo[@]} files left"
    "$HF" download "$REPO" "${todo[@]}" --revision "$rev" --local-dir "$DEST" --max-workers "$MAX_WORKERS" >>"$HFLOG" 2>&1 &
    local pid=$! last; last=$(landed_bytes); local last_change; last_change=$(date +%s)
    trap 'kill -TERM $pid 2>/dev/null; (( seedpid > 0 )) && kill -TERM $seedpid 2>/dev/null; status "STOPPED (resume with: download.sh start)"; exit 143' TERM INT HUP
    while kill -0 "$pid" 2>/dev/null; do
      sleep 10
      local b now avail; b=$(landed_bytes); now=$(date +%s)
      if (( b > last )); then last=$b; last_change=$now; fi
      avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
      if (( avail < MEM_FLOOR_MB )); then
        log "memory guard: MemAvailable ${avail} MB < ${MEM_FLOOR_MB} MB — killing attempt to protect the serving container"
        kill -KILL "$pid" 2>/dev/null; break
      fi
      if (( now - last_change > STALL_SECS )); then
        log "stalled ${STALL_SECS}s with no byte growth — killing attempt"; kill -TERM "$pid"; sleep 10; kill -KILL "$pid" 2>/dev/null
      fi
    done
    wait "$pid"; local rc=$?
    trap - TERM INT HUP
    if (( rc == 0 )); then backoff=30; continue; fi   # loop re-verifies
    log "hf exited rc=$rc (mode=$mode); backing off ${backoff}s"
    status "RETRYING in ${backoff}s after rc=$rc (attempt $attempt/$MAX_ATTEMPTS)"
    sleep "$backoff"; backoff=$(( backoff*2 > 900 ? 900 : backoff*2 ))
  done
  status "FAILED: gave up after $MAX_ATTEMPTS attempts — re-run 'download.sh start' to resume"
  log "max attempts reached"; return 1
}

case ${1:-status} in
  start)
    if tmux has-session -t "$SESSION" 2>/dev/null; then echo "already running (tmux attach -t $SESSION)"; exit 0; fi
    tmux new-session -d -s "$SESSION" "bash '$(readlink -f "$0")' run; echo 'run exited'; sleep 86400"
    echo "started in tmux session $SESSION"; ;;
  run)    cmd_run ;;
  status) cmd_status ;;
  verify) shift; cmd_verify "$@" ;;
  stop)   tmux kill-session -t "$SESSION" 2>/dev/null && echo stopped || echo "not running" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
