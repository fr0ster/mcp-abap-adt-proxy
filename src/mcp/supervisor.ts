// src/mcp/supervisor.ts
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { ProxyConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import {
  type CredentialFacade,
  createProxyRequestHandler,
} from '../proxy/requestHandler.js';
import { listenOnFreePort } from './ports.js';
import { type InstanceRecord, InstanceRegistry } from './registry.js';

/** Thirty minutes with no forwarded request. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long a stop waits for requests in flight before cutting them.
 *
 * `server.close()` alone is not enough and cannot be: it waits for ACTIVE
 * connections, and a response that streams never becomes inactive. Measured on
 * Node 26.7.0, the close callback had not fired 1500ms after a single open
 * event stream. Waiting forever would mean `proxy_stop` never returning and —
 * because the shutdown path awaits the same call — SIGINT, SIGTERM and stdin
 * close all hanging with the port still held, which is precisely the
 * orphaned-port failure running in-process was meant to prevent.
 *
 * So an ordinary request gets this long to finish, and then the socket goes.
 */
export const DEFAULT_STOP_GRACE_MS = 2000;

export interface StartOptions {
  /**
   * The config's name, as it is filed in the proxy config directory. This is
   * the unit, not the destination: four configs on disk name the same
   * `btpDestination` and differ in target and headers, so a destination cannot
   * identify one.
   */
  name: string;
  /**
   * The loaded config. Its `httpPort` is deliberately IGNORED — four of the
   * configs on disk say 3001, which is exactly the collision this mode exists
   * to end. The port comes from the OS.
   */
  config: ProxyConfig;
  /** `0` turns the backstop off. */
  idleTimeoutMs?: number;
  /** How long a stop waits for requests in flight. See DEFAULT_STOP_GRACE_MS. */
  stopGraceMs?: number;
}

export interface StartedInstance {
  instanceId: string;
  /** The config that was started. */
  name: string;
  url: string;
  port: number;
  destination: string;
  startedAt: string;
}

interface Owned extends StartedInstance {
  server: Server;
  /** Released on stop, alongside the port. */
  facade: CredentialFacade;
  idle?: NodeJS.Timeout;
  /** Kept so a request can re-arm the countdown with the same length. */
  idleTimeoutMs: number;
  stopGraceMs: number;
}

export interface SupervisorOptions {
  registry?: InstanceRegistry;
  /** Builds or reuses the credential facade for a destination's config. */
  proxyFor: (options: StartOptions) => Promise<CredentialFacade>;
  host?: string;
}

/**
 * The listeners this process owns.
 *
 * They run HERE, in the MCP server's own process, and that is not a
 * convenience. A spawned child is orphaned by any signal its parent does not
 * forward and goes on holding the HTTP and OAuth callback ports — the reason
 * `bin/mcp-abap-adt-proxy.js` loads the server in-process instead of spawning
 * it. In-process, a listener dies when the stdio session dies and its port
 * goes with it.
 *
 * Everything here is about letting go. A stopped instance clears its idle
 * timer, closes its listener, releases its credential and deletes its record,
 * in that order; a session that
 * ends stops all of them; and an instance nobody has used for a while stops
 * itself, because an agent that finished and forgot is the case this mode has
 * to survive.
 */
export class ProxySupervisor {
  private readonly owned = new Map<string, Owned>();
  private readonly registry: InstanceRegistry;
  private readonly host: string;

  constructor(private readonly options: SupervisorOptions) {
    this.registry = options.registry ?? new InstanceRegistry();
    this.host = options.host ?? '127.0.0.1';
  }

  async start(options: StartOptions): Promise<StartedInstance> {
    const facade = await this.options.proxyFor(options);
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const instanceId = randomUUID();

    const handle = createProxyRequestHandler({
      config: {
        btpDestination: options.config.btpDestination,
        targetUrl: options.config.targetUrl,
        defaultHeaders: options.config.defaultHeaders,
      },
      proxy: async () => facade,
      // Deliberately no policy: an authentication failure answers the request
      // and the process lives. Exiting here would take the MCP server down and
      // the client's session with it.
    });

    const server = createServer((req, res) => {
      this.touch(instanceId);
      handle(req, res).catch((error) => {
        logger?.error('Proxy request failed inside the MCP mode', {
          type: 'MCP_MODE_REQUEST_ERROR',
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    const port = await listenOnFreePort(server, this.host);
    const started: Owned = {
      instanceId,
      name: options.name,
      port,
      url: `http://${this.host}:${port}`,
      destination: options.config.btpDestination ?? '(none)',
      startedAt: new Date().toISOString(),
      server,
      facade,
      idleTimeoutMs,
      stopGraceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    };
    this.owned.set(instanceId, started);
    this.registry.record({
      pid: process.pid,
      port,
      url: started.url,
      destination: started.destination,
      config: started.name,
      startedAt: started.startedAt,
    });

    if (idleTimeoutMs > 0) {
      started.idle = this.armIdle(instanceId, idleTimeoutMs);
    }

    logger?.info('Proxy started by the MCP mode', {
      type: 'MCP_MODE_PROXY_STARTED',
      instanceId,
      name: options.name,
      port,
      destination: started.destination,
    });
    return this.describe(started);
  }

  /** Stop one instance, or every one this process owns. */
  async stop(instanceId?: string): Promise<StartedInstance[]> {
    const targets =
      instanceId === undefined
        ? [...this.owned.values()]
        : ([this.owned.get(instanceId)].filter(Boolean) as Owned[]);

    const stopped: StartedInstance[] = [];
    for (const target of targets) {
      if (target.idle) clearTimeout(target.idle);
      await this.closeListener(target);

      // The port is half of it. The broker behind the credential holds cached
      // service-key lookups, so letting go of the listener and keeping those
      // would be releasing the visible resource and holding the rest.
      //
      // Guarded, and so is forgetting the record: a credential that throws on
      // the way out used to abort this loop between closing the server and
      // deleting the record, leaving both the instance and its file behind —
      // and rejecting on top of it, which from the idle timer means an
      // unhandled rejection and a dead MCP session.
      try {
        (target.facade as { dispose?: () => void }).dispose?.();
      } catch (error) {
        logger?.error('A credential threw while being released', {
          type: 'MCP_MODE_DISPOSE_FAILED',
          instanceId: target.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.owned.delete(target.instanceId);
      try {
        this.registry.forget(target.port);
      } catch (error) {
        logger?.error('Could not delete the instance record', {
          type: 'MCP_MODE_FORGET_FAILED',
          port: target.port,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      stopped.push(this.describe(target));
      logger?.info('Proxy stopped by the MCP mode', {
        type: 'MCP_MODE_PROXY_STOPPED',
        instanceId: target.instanceId,
        port: target.port,
      });
    }
    return stopped;
  }

  /** What this process is running. */
  mine(): StartedInstance[] {
    return [...this.owned.values()].map((owned) => this.describe(owned));
  }

  /** Live proxies started by other sessions. Dead claims are pruned on read. */
  others(): InstanceRecord[] {
    return this.registry
      .live()
      .filter(
        (record) =>
          record.pid !== process.pid ||
          ![...this.owned.values()].some((o) => o.port === record.port),
      );
  }

  /**
   * Close the listener and make sure the port is actually free afterwards.
   *
   * Idle keep-alive sockets go immediately — they are holding the port for
   * nothing. Anything still carrying a request gets `stopGraceMs`, and then
   * goes too, because a stream will not end on its own and the caller asked
   * for this port back.
   */
  private async closeListener(target: Owned): Promise<void> {
    const closed = new Promise<void>((resolve) =>
      target.server.close(() => resolve()),
    );
    target.server.closeIdleConnections?.();

    let forced: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => {
      forced = setTimeout(() => {
        logger?.info('Cutting requests still in flight to free the port', {
          type: 'MCP_MODE_STOP_FORCED',
          instanceId: target.instanceId,
          port: target.port,
          stopGraceMs: target.stopGraceMs,
        });
        target.server.closeAllConnections?.();
        resolve();
      }, target.stopGraceMs);
      forced.unref?.();
    });

    await Promise.race([closed, grace]);
    if (forced) clearTimeout(forced);
    // After closeAllConnections the close callback fires; wait for it so the
    // port is demonstrably free when this returns rather than probably free.
    await closed;
  }

  private describe(owned: Owned): StartedInstance {
    const {
      server: _server,
      idle: _idle,
      facade: _facade,
      idleTimeoutMs: _idleTimeoutMs,
      stopGraceMs: _stopGraceMs,
      ...rest
    } = owned;
    return rest;
  }

  /**
   * Restart the countdown. `unref` so a pending timer never keeps the process
   * alive on its own — the backstop exists to release things, not to hold one.
   */
  private armIdle(instanceId: string, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      logger?.info('Proxy stopped after sitting idle', {
        type: 'MCP_MODE_PROXY_IDLE_STOP',
        instanceId,
        idleTimeoutMs: ms,
      });
      // Caught, not floated: `stop()` can reject, and an unhandled rejection
      // from a timer ends the process — taking the client's MCP session with a
      // proxy that merely sat unused.
      void this.stop(instanceId).catch((error) => {
        logger?.error('Failed to stop an idle proxy', {
          type: 'MCP_MODE_IDLE_STOP_FAILED',
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, ms);
    timer.unref?.();
    return timer;
  }

  private touch(instanceId: string): void {
    const owned = this.owned.get(instanceId);
    if (!owned?.idle) return;
    clearTimeout(owned.idle);
    owned.idle = this.armIdle(instanceId, owned.idleTimeoutMs);
  }
}
