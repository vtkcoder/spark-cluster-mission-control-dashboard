import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { findModelDir, idToSafeName } from "./model-scan";
import { logEvent, updateEvent } from "./db";

export interface BackupTarget { mountpoint: string; label: string; freeBytes: number }
export interface BackupJob {
  modelId: string;
  target: string;
  startedAt: number;
  percent: number;
  status: "running" | "success" | "failed";
  message: string;
}

const NODE = "spark1";
const ALLOWED_MOUNT_PREFIXES = ["/media", "/mnt", "/run/media"];

// Single in-process job at a time (one external drive, sequential copies).
const g = globalThis as unknown as { __modelBackupJob?: BackupJob | null };
function current(): BackupJob | null { return g.__modelBackupJob ?? null; }

export function getBackupStatus(): BackupJob | null { return current(); }
export function backupInFlightFor(modelId: string): boolean {
  const j = current();
  return !!j && j.status === "running" && j.modelId === modelId;
}

export function parseRsyncProgress(line: string): number | null {
  const m = line.match(/(\d+)%/);
  return m ? parseInt(m[1]) : null;
}

export async function detectTargets(): Promise<BackupTarget[]> {
  let json: { blockdevices?: unknown[] } = {};
  try {
    const out = execSync("lsblk -J -b -o NAME,MOUNTPOINT,SIZE,FSAVAIL,RM,TYPE 2>/dev/null").toString();
    json = JSON.parse(out);
  } catch { return []; }

  const targets: BackupTarget[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes as Array<Record<string, unknown>>) {
      const mp = n.mountpoint as string | null;
      const avail = typeof n.fsavail === "string" ? parseInt(n.fsavail) : (n.fsavail as number | null);
      if (mp && ALLOWED_MOUNT_PREFIXES.some((p) => mp.startsWith(p))) {
        targets.push({ mountpoint: mp, label: String(n.name ?? mp), freeBytes: avail ?? 0 });
      }
      if (Array.isArray(n.children)) walk(n.children as unknown[]);
    }
  };
  walk(json.blockdevices ?? []);
  return targets;
}

export function startBackup(modelId: string, target: string): { error?: string } {
  const existing = current();
  if (existing && existing.status === "running") return { error: "A backup is already running." };
  if (!ALLOWED_MOUNT_PREFIXES.some((p) => target.startsWith(p))) return { error: "Target is not an allowed external mount." };
  if (!existsSync(target)) return { error: "Target mountpoint does not exist." };

  const src = findModelDir(NODE, modelId);
  if (!src || !existsSync(src)) return { error: "Source model dir not found." };

  const destRoot = join(target, "cluster-dash-models");
  const dest = join(destRoot, idToSafeName(modelId));
  try { mkdirSync(dest, { recursive: true }); } catch (e) { return { error: (e as Error).message }; }

  const job: BackupJob = {
    modelId, target, startedAt: Date.now(), percent: 0, status: "running",
    message: "starting rsync",
  };
  g.__modelBackupJob = job;

  // rsync -a preserves the full repo structure (blobs/snapshots/refs). Trailing
  // slash on src copies its *contents* into dest.
  const child = spawn("rsync", ["-a", "--info=progress2", `${src}/`, `${dest}/`], { stdio: ["ignore", "pipe", "pipe"] });

  logEvent(NODE, modelId, "backup", "started", { target: dest }).then((id) => {
    let lastErr = "";
    child.stdout.on("data", (b: Buffer) => {
      for (const line of b.toString().split(/\r|\n/)) {
        const pct = parseRsyncProgress(line);
        if (pct !== null) job.percent = pct;
      }
    });
    child.stderr.on("data", (b: Buffer) => { lastErr = b.toString().slice(-300); });
    child.on("close", (code) => {
      if (code === 0) {
        job.status = "success"; job.percent = 100; job.message = "complete";
        updateEvent(id, "success", { target: dest });
      } else {
        job.status = "failed"; job.message = lastErr || `rsync exited ${code}`;
        updateEvent(id, "failed", { error: job.message });
      }
    });
  });

  return {};
}
