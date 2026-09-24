// src/mcp/shutdown.ts
import { logger } from '../lib/logger.js';
import type { StartedInstance } from './supervisor.js';

/**
 * How long the whole shutdown gets before the process leaves anyway.
 *
 * Generous next to the per-instance grace, because this is the outer bound: it
 * exists for the case where something below refuses to finish at all, not for
 * the ordinary one.
 */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 10_000;

export interface ShutdownDeps {
  supervisor: { stop(instanceId?: string): Promise<StartedInstance[]> };
  closeServer: () => Promise<void>;
  exit: (code: number) => void;
  deadlineMs?: number;
}

/**
 * The end of the session, which is the last chance to let anything go.
 *
 * Three properties, and each one is here because its absence is a real failure
 * rather than a tidiness concern:
 *
 * **It runs once.** SIGINT, SIGTERM and stdin closing can all arrive, and two
 * shutdowns racing means stopping the same instances twice.
 *
 * **It always reaches the exit.** `process.exit()` used to sit in a `.finally()`
 * after an unbounded await, so anything that hung below it produced a process
 * that ignores SIGTERM and keeps its ports — precisely the orphaned-listener
 * failure that running the proxies in this process was meant to prevent.
 *
 * **It never rejects.** A signal handler has no caller, so a rejection here is
 * an unhandled one, and the default is to end the process on it — which would
 * be the exit happening for the wrong reason, skipping the release.
 */
export function createShutdown(
  deps: ShutdownDeps,
): (why: string) => Promise<void> {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  let started = false;

  return async function shutdown(why: string): Promise<void> {
    if (started) return;
    started = true;

    logger?.info('MCP mode shutting down', { type: 'MCP_MODE_SHUTDOWN', why });

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), deadlineMs);
      timer.unref?.();
    });

    const release = (async () => {
      try {
        const stopped = await deps.supervisor.stop();
        if (stopped.length > 0) {
          logger?.info('Released proxies on shutdown', {
            type: 'MCP_MODE_SHUTDOWN_RELEASED',
            count: stopped.length,
            ports: stopped.map((s) => s.port),
          });
        }
      } catch (error) {
        logger?.error('Failed to release proxies on shutdown', {
          type: 'MCP_MODE_SHUTDOWN_RELEASE_FAILED',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await deps.closeServer();
      } catch {
        /* already gone, or never up */
      }
    })();

    const outcome = await Promise.race([release, deadline]);
    if (timer) clearTimeout(timer);
    if (outcome === 'deadline') {
      logger?.error('Shutdown did not finish in time; leaving anyway', {
        type: 'MCP_MODE_SHUTDOWN_DEADLINE',
        why,
        deadlineMs,
      });
    }

    deps.exit(0);
  };
}
