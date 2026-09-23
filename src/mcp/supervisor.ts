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
 * Everything here is about letting go. A stopped instance closes its server,
 * clears its idle timer and deletes its record, in that order; a session that
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
      await new Promise<void>((resolve) =>
        target.server.close(() => resolve()),
      );
      // The port is half of it. The broker behind the credential holds cached
      // service-key lookups and, when it was built for a browser login, a
      // callback server — letting go of the listener and keeping those would be
      // releasing the visible resource and holding the rest.
      (target.facade as { dispose?: () => void }).dispose?.();
      this.owned.delete(target.instanceId);
      this.registry.forget(target.port);
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

  private describe(owned: Owned): StartedInstance {
    const {
      server: _server,
      idle: _idle,
      facade: _facade,
      idleTimeoutMs: _idleTimeoutMs,
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
      void this.stop(instanceId);
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
