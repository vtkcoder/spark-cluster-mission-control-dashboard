# scripts/

## download-flash1017-uncensored.sh

Self-repairing **download only** of `dealignai/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8`
(abliterated `deepseek-ai/DeepSeek-V4.1-Flash-1017`, pinned to rev `c19ca5ca4eaeb79d29fdf08aea8327da95b1116a`,
79 files, 510.3 GB) onto spark1's 8 TB exFAT store. It never touches the running `dsv41-*` containers.

- **Runs on spark1** (`edgexpert-74a6`, `100.79.103.61`). Installed copy: `~/dsv41-uncensored-download/download.sh`
  (state, manifest, logs in the same dir). After editing here, redeploy with
  `scp scripts/download-flash1017-uncensored.sh absolome@100.79.103.61:dsv41-uncensored-download/download.sh`.
- **Destination:** `/mnt/models-ext/Models/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8/`, a flat `--local-dir` tree
  (real files, no HF-cache symlinks, which exFAT can't hold). Same flat shape as the served
  `~/dsv41-model` dir on each node.
- **Seeding:** 21 shards (310.7 GB, including both ~101 GB shards 47/48) have the same sha256 as the base
  checkpoint the cluster serves, so they are copied from spark1's local `~/dsv41-model` after a sha256 check.
  Only 199.6 GB comes over the internet.
- **HTTP, not Xet:** spark1's uplink is 1 GbE. Xet's adaptive concurrency buffered ~20 GB in RAM within
  two minutes on a serving node, so the script uses plain HTTP (`HF_HUB_DISABLE_XET=1`, `USE_XET=1` to opt
  back in). A memory guard kills the attempt (never the server) if MemAvailable drops below 8 GB.
  `hf_transfer` is ignored by huggingface_hub ≥ 1.0.

```bash
S=~/dsv41-uncensored-download/download.sh      # on spark1
$S start          # start/resume detached (tmux session dsv41-unc); no-op if already running
$S status         # state, GB landed, throughput, ETA, free space
$S verify         # "complete" or "N of 79 files missing or wrong-sized" (safe any time)
$S verify --deep  # also sha256 every LFS shard against the HF manifest
$S stop           # stop; partial files are kept and resumed by the next start
```

From the Mac: `ssh absolome@100.79.103.61 '~/dsv41-uncensored-download/download.sh status'`.

Each attempt re-verifies sizes against the pinned manifest, deletes wrong-sized files, and requests only
what is missing. HTTP partials (`DEST/.cache/huggingface/download/*.incomplete`) resume at the byte level.
Attempts are retried up to 40 times with backoff (30 s up to 15 min), and the stall watchdog restarts an
attempt after 15 min with no growth. `DONE` in `status` means every file matched its size.
