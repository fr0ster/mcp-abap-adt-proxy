// src/mcp/registry.ts
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeDir } from '../lib/stores.js';

/**
 * One live proxy, as claimed by the process that started it.
 */
export interface InstanceRecord {
  pid: number;
  port: number;
  url: string;
  destination: string;
  /** Which proxy config was started. */
  config: string;
  startedAt: string;
  /**
   * When the machine this was written on last booted.
   *
   * A pid is only unique within a boot. After a restart the same number can
   * belong to an unrelated live process, and `process.kill(pid, 0)` then says
   * "alive" forever — a record that outlives its writer permanently, reported by
   * `proxy_status` as another session's proxy with no way to clear it but
   * deleting the file by hand.
   */
  bootedAt: number;
}

/**
 * When this machine booted, to the nearest millisecond it can manage.
 *
 * `os.uptime()` is seconds since boot on every platform, so this drifts by a few
 * milliseconds between calls — which is why records are compared with a
 * tolerance rather than for equality.
 */
export function bootedAt(): number {
  return Math.round(Date.now() - os.uptime() * 1000);
}

/** How far apart two readings of the boot time may be and still mean one boot. */
const BOOT_TOLERANCE_MS = 5000;

/** Does this process still exist? */
export type IsAlive = (pid: number) => boolean;

/**
 * Signal 0 checks for the process without delivering anything. `EPERM` means it
 * exists and belongs to someone else — still alive, so still holding its port.
 */
const processExists: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Where instance records live, following the convention `src/lib/stores.ts`
 * uses for service keys and sessions.
 */
export function defaultRuntimeDir(): string {
  return storeDir('runtime');
}

/**
 * The live proxies on this machine, this session's and everyone else's.
 *
 * A record is a claim, not a fact — the process that wrote it may have crashed
 * without cleaning up. So every read checks the process behind each record and
 * DELETES the ones whose writer is gone, rather than merely hiding them: a
 * ghost that survives the read comes back on the next one, and `proxy_status`
 * goes on reporting a proxy that stopped holding its port days ago.
 */
export class InstanceRegistry {
  constructor(
    private readonly dir: string = defaultRuntimeDir(),
    private readonly isAlive: IsAlive = processExists,
  ) {}

  private fileFor(port: number): string {
    return path.join(this.dir, `${process.pid}-${port}.json`);
  }

  record(entry: InstanceRecord): void {
    mkdirSync(this.dir, { recursive: true });
    // Written beside the target and renamed over it. `writeFileSync` truncates
    // first, so a reader arriving mid-write sees a partial file; a rename is
    // atomic, so it sees either the whole record or no file.
    const file = this.fileFor(entry.port);
    const partial = `${file}.tmp-${process.pid}`;
    writeFileSync(partial, JSON.stringify(entry, null, 2));
    renameSync(partial, file);
  }

  /** Drop this process's record for a port. Missing is not an error. */
  forget(port: number): void {
    rmSync(this.fileFor(port), { force: true });
  }

  live(): InstanceRecord[] {
    if (!existsSync(this.dir)) return [];

    const records: InstanceRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);

      let record: InstanceRecord;
      try {
        record = JSON.parse(readFileSync(file, 'utf-8')) as InstanceRecord;
      } catch {
        // Unreadable or half-written. One bad file must not cost the caller
        // the whole listing — which is the difference between a degraded
        // answer and no answer at all.
        continue;
      }

      if (typeof record?.pid !== 'number') continue;

      // A pid means nothing across a reboot, so a record from an earlier boot is
      // gone whatever its pid now answers. A record with no boot time at all was
      // written by an older version and cannot be judged, which is the same
      // answer.
      const sameBoot =
        typeof record.bootedAt === 'number' &&
        Math.abs(record.bootedAt - bootedAt()) <= BOOT_TOLERANCE_MS;

      if (sameBoot && this.isAlive(record.pid)) {
        records.push(record);
      } else {
        rmSync(file, { force: true });
      }
    }
    return records.sort((a, b) => a.port - b.port);
  }
}
