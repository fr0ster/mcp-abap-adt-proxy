// src/mcp/registry.ts
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * One live proxy, as claimed by the process that started it.
 */
export interface InstanceRecord {
  pid: number;
  port: number;
  url: string;
  destination: string;
  startedAt: string;
}

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
  const home = os.homedir();
  return process.platform === 'win32'
    ? path.join(home, 'Documents', 'mcp-abap-adt', 'runtime')
    : path.join(home, '.config', 'mcp-abap-adt', 'runtime');
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
    writeFileSync(this.fileFor(entry.port), JSON.stringify(entry, null, 2));
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
      if (this.isAlive(record.pid)) {
        records.push(record);
      } else {
        rmSync(file, { force: true });
      }
    }
    return records.sort((a, b) => a.port - b.port);
  }
}
