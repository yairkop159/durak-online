import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

type ReadFile = (path: string) => string | null;

const readOrNull: ReadFile = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * The container's CPU quota in cores (cgroup v2 `cpu.max`, else v1 `cfs_quota_us`), or null when
 * unlimited / not in a cgroup. `os.availableParallelism()` reports the host's cores, so without
 * this a 1-CPU container on a 16-core host would start 15 bot workers.
 */
export function cgroupCpuLimit(read: ReadFile = readOrNull): number | null {
  const v2 = read('/sys/fs/cgroup/cpu.max')?.trim().split(/\s+/);
  if (v2 && v2.length === 2 && v2[0] !== 'max') {
    const quota = Number(v2[0]);
    const period = Number(v2[1]);
    if (quota > 0 && period > 0) return quota / period;
  }
  const quota = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')?.trim());
  const period = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us')?.trim());
  if (quota > 0 && period > 0) return quota / period;
  return null;
}

/** Usable CPUs: the smaller of the visible cores and the cgroup quota (rounded up, at least 1). */
export function usableCpus(cores: number = availableParallelism(), limit: number | null = cgroupCpuLimit()): number {
  const fromLimit = limit === null ? Number.POSITIVE_INFINITY : Math.ceil(limit);
  return Math.max(1, Math.min(cores, fromLimit));
}

/** Upper bound for the default pool: bots think for ≤300 ms per move, more threads only cost memory. */
export const MAX_DEFAULT_BOT_WORKERS = 4;

/**
 * Default bot worker threads: one core stays with the main thread (sockets, timers), at least
 * one worker (a 1-CPU machine shares its core: the OS time-slices the worker and the event loop,
 * so the main thread stays responsive while a bot thinks), at most MAX_DEFAULT_BOT_WORKERS.
 */
export function defaultBotWorkers(cpus: number = usableCpus()): number {
  return Math.max(1, Math.min(cpus - 1, MAX_DEFAULT_BOT_WORKERS));
}
