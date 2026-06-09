import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, existsSync } from "fs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

const TASKS_SCRIPT = "/tmp/spark_tasks.py";
const TASKS_SRC = `
import subprocess, json

def get_processes(n=18):
    try:
        out = subprocess.check_output(
            ['ps', '-eo', 'pid,user,pcpu,pmem,rss,stat,comm', '--sort=-pcpu', '--no-headers'],
            text=True
        ).strip().split('\\n')
        procs = []
        for line in out[:n]:
            parts = line.split(None, 6)
            if len(parts) >= 7:
                procs.append({
                    'pid': int(parts[0]),
                    'user': parts[1][:12],
                    'cpu': float(parts[2]),
                    'mem': float(parts[3]),
                    'rss': int(parts[4]),
                    'stat': parts[5],
                    'comm': parts[6].strip()[:28]
                })
        return procs
    except:
        return []

def get_containers():
    try:
        out = subprocess.check_output(
            ['docker', 'ps', '-a', '--format', '{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}'],
            text=True
        ).strip()
        if not out:
            return []
        containers = []
        for line in out.split('\\n'):
            if '|' not in line:
                continue
            parts = line.split('|', 3)
            img = parts[2].split('/')[-1] if len(parts) > 2 else ''
            status = parts[1] if len(parts) > 1 else ''
            state = 'running' if status.startswith('Up') else \\
                    'exited' if 'Exited' in status else \\
                    'created' if status == 'Created' else 'unknown'
            containers.append({
                'name': parts[0],
                'status': status[:42],
                'state': state,
                'image': img[:40],
                'ports': parts[3][:60] if len(parts) > 3 else ''
            })
        return containers
    except:
        return []

def get_services(n=22):
    try:
        out = subprocess.check_output(
            ['systemctl', 'list-units', '--type=service', '--state=running',
             '--no-legend', '--plain', '--no-pager'],
            text=True
        ).strip().split('\\n')
        services = []
        for line in out[:n]:
            if not line.strip():
                continue
            parts = line.split(None, 4)
            if len(parts) >= 4:
                services.append({
                    'name': parts[0].replace('.service', ''),
                    'sub': parts[2],
                    'desc': (' '.join(parts[4:])).strip() if len(parts) > 4 else ''
                })
        return services
    except:
        return []

print(json.dumps({
    'processes': get_processes(),
    'containers': get_containers(),
    'services': get_services()
}))
`.trim();

if (!existsSync(TASKS_SCRIPT)) {
  writeFileSync(TASKS_SCRIPT, TASKS_SRC, { mode: 0o644 });
}

async function getNodeTasks(host?: string) {
  try {
    const cmd = host
      ? `ssh -o ConnectTimeout=3 -o BatchMode=yes ${host} python3 /dev/stdin < ${TASKS_SCRIPT}`
      : `python3 ${TASKS_SCRIPT}`;
    const { stdout } = await execAsync(cmd, { timeout: 8000 });
    return { online: true, ...JSON.parse(stdout.trim()) };
  } catch {
    return { online: false, processes: [], containers: [], services: [] };
  }
}

export async function GET() {
  const [spark1, spark2, spark3, spark4] = await Promise.all([
    getNodeTasks(),
    getNodeTasks("spark2"),
    getNodeTasks("spark3"),
    getNodeTasks("spark4"),
  ]);
  return NextResponse.json({ ts: Date.now(), spark1, spark2, spark3, spark4 });
}
