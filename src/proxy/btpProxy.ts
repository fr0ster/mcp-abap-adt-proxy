/**
 * BTP Proxy - Proxies requests to MCP servers with JWT authentication
 *
 * For requests with x-sap-destination, proxies to target MCP server
 * with JWT token from auth-broker (XSUAA/BTP)
 */

import {
  AuthBroker,
  type ILogger,
  type IServiceKeyStore,
  type ISessionStore,
  type TokenProviderFactory,
} from '@mcp-abap-adt/auth-broker';
import {
  AuthorizationCodeProvider,
  browserCallbackStrategy,
} from '@mcp-abap-adt/auth-providers';
import { ServiceKeyNotFoundError } from '../lib/authFailure.js';
import { loadConfig, type ProxyConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { getPlatformStores } from '../lib/stores.js';
import { DestinationCredentials } from './credentials.js';

/**
 * Default port for the local OAuth2 callback server, kept away from the
 * proxy's own default HTTP port (3001). auth-providers@2.0.0's own default
 * (61001) is deliberately not inherited here: this port is documented as
 * `--browser-auth-port` and may be registered with the identity provider, so
 * silently moving it would break every proxy already relying on 3333.
 */
const DEFAULT_BROWSER_AUTH_PORT = 3333;

/**
 * auth-providers@2.0.0's `browserCallbackStrategy` defaults `timeoutMs` to 30
 * seconds — sized for an unattended caller. Here the login is driven by a
 * person: a browser tab has to open, and they may need to type credentials or
 * complete MFA before the redirect lands. Five minutes gives them room to do
 * that without the callback server tearing itself down mid-login.
 */
const INTERACTIVE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Adapter to convert proxy Logger to ILogger interface expected by AuthBroker
 */
const loggerAdapter: ILogger = {
  debug: (message: string, meta?: unknown) =>
    logger?.debug(
      message,
      meta && typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)
        : undefined,
    ),
  info: (message: string, meta?: unknown) =>
    logger?.info(
      message,
      meta && typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)
        : undefined,
    ),
  warn: (message: string, meta?: unknown) =>
    logger?.warn(
      message,
      meta && typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)
        : undefined,
    ),
  error: (message: string, meta?: unknown) =>
    logger?.error(
      message,
      meta && typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)
        : undefined,
    ),
};

import { type RetryOptions, retryWithBackoff } from '../lib/errorHandler.js';

/**
 * A store read answered as absent when it fails, as auth-broker reads them: a
 * store signals a missing file by throwing, and absence is what the callers
 * here decide on. Logged, so an unreadable key is not mistaken for a missing
 * one without a trace.
 */
async function readOrNull<T>(
  what: string,
  read: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    logger?.warn(`Failed to read ${what}`, {
      type: 'BTP_STORE_READ_ERROR',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function requireCredentials(
  destination: string,
  serviceKeyStore: IServiceKeyStore,
  sessionStore: ISessionStore,
): Promise<void> {
  const found =
    (await readOrNull(`service key for ${destination}`, () =>
      serviceKeyStore.getAuthorizationConfig(destination),
    )) ??
    (await readOrNull(`session credentials for ${destination}`, () =>
      sessionStore.getAuthorizationConfig(destination),
    ));
  if (!found) {
    throw new ServiceKeyNotFoundError(destination);
  }
}

/**
 * The provider auth-broker builds per destination: an
 * `AuthorizationCodeProvider` seeded with what the stores hold — the UAA
 * credentials with the stored refresh token, and the stored access token — so
 * a session that is still valid, or can be refreshed, needs no browser.
 *
 * How the login is conducted is the provider's authorization strategy; the
 * broker has no say in it any more (its `browser` argument is gone).
 */
export function authorizationCodeProviderFactory(
  config: Partial<ProxyConfig>,
): TokenProviderFactory {
  return (destination, authConfig, connConfig) => {
    if (!authConfig) {
      throw new ServiceKeyNotFoundError(destination);
    }
    return new AuthorizationCodeProvider({
      authorization: browserCallbackStrategy({
        browser: config.browser,
        port: config.browserAuthPort || DEFAULT_BROWSER_AUTH_PORT,
        timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS,
      }),
      // Pass a logger so the callback strategy can surface the "Open this
      // URL" prompt in 'none'/'headless' mode. Without it, the callback
      // server gets a null logger and silently drops the authorization URL.
      logger: loggerAdapter,
      uaaUrl: authConfig.uaaUrl,
      clientId: authConfig.uaaClientId,
      clientSecret: authConfig.uaaClientSecret,
      refreshToken: authConfig.refreshToken,
      // An empty string is how a session seeded without a token says "none".
      accessToken: connConfig.authorizationToken || undefined,
    });
  };
}

/**
 * Check if error messages should be written to stderr
 * Only output in verbose mode and not in test environment
 */
export function shouldWriteStderr(): boolean {
  const verboseMode =
    process.env.MCP_PROXY_VERBOSE === 'true' ||
    process.env.DEBUG === 'true' ||
    process.env.DEBUG?.includes('mcp-proxy') === true;
  const isTestEnv =
    process.env.NODE_ENV === 'test' ||
    process.env.JEST_WORKER_ID !== undefined ||
    typeof (globalThis as { jest?: unknown }).jest !== 'undefined';
  return verboseMode && !isTestEnv;
}

/**
 * BTP Proxy Client
 */
export class BtpProxy {
  private defaultBtpAuthBroker: AuthBroker;
  private btpAuthBrokers: Map<string, AuthBroker> = new Map();
  private readonly credentials: DestinationCredentials;
  private config: ProxyConfig;
  private unsafe: boolean;

  constructor(defaultBtpAuthBroker: AuthBroker, config?: Partial<ProxyConfig>) {
    this.defaultBtpAuthBroker = defaultBtpAuthBroker;
    this.unsafe = config?.unsafe ?? false;

    // Use provided config if available (from YAML or CLI/ENV, already loaded in index.ts)
    // If no config provided, load from CLI/ENV as fallback
    if (config) {
      this.config = config as ProxyConfig;
      logger?.debug('Using provided config in BtpProxy constructor', {
        type: 'CONFIG_PROVIDED',
        btpDestination: this.config.btpDestination,
        configKeys: Object.keys(this.config),
      });
    } else {
      // Fallback: load from CLI/ENV (should not happen if called from index.ts)
      this.config = loadConfig();
      logger?.info(
        'Using fallback config from CLI/ENV in BtpProxy constructor',
        {
          type: 'CONFIG_FALLBACK',
        },
      );
    }

    // One credential per destination, over the brokers this class already
    // caches. The lookup is passed rather than the broker itself so a
    // destination that has never been seen still gets one built.
    this.credentials = new DestinationCredentials((destination) =>
      this.getOrCreateBtpAuthBroker(destination),
    );

    // No circuit breaker. It only ever guarded the buffered axios forward that
    // M2 deleted, and the streaming path has nowhere to put one without
    // buffering the response again. `circuitBreakerThreshold` and
    // `circuitBreakerTimeout` are still accepted so existing configs load, and
    // are documented as inert.
  }

  /**
   * Initialize authentication for destination (eager auth)
   * This triggers the browser authentication flow immediately if needed.
   */
  public async initialize(destination: string): Promise<void> {
    logger?.info('Initializing BTP proxy authentication', {
      type: 'BTP_PROXY_INIT',
      destination,
    });
    try {
      // Just getting the token will trigger authentication
      await this.getAuthorizationHeader(destination);
      logger?.info('BTP proxy authentication initialized successfully', {
        type: 'BTP_PROXY_INIT_SUCCESS',
        destination,
      });
    } catch (error) {
      logger?.error('Failed to initialize BTP proxy authentication', {
        type: 'BTP_PROXY_INIT_ERROR',
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
      // Re-throw so the server can decide to exit (auth requested but not
      // completed) instead of running in a permanently unauthenticated state.
      throw error;
    }
  }

  /**
   * Get or create BTP auth broker for specific destination
   * If destination is not provided, returns default broker
   * If broker doesn't exist in map, creates new one and stores it
   */
  private async getOrCreateBtpAuthBroker(
    destination?: string,
  ): Promise<AuthBroker> {
    // If no destination, use default broker
    if (!destination) {
      return this.defaultBtpAuthBroker;
    }

    // Check if broker exists in map
    const existing = this.btpAuthBrokers.get(destination);
    if (existing) {
      return existing;
    }

    // Create new broker for this destination
    logger?.info('Creating new BTP auth broker for destination', {
      type: 'BTP_BROKER_CREATE',
      destination,
    });

    const { serviceKeyStore, sessionStore } = await getPlatformStores(
      this.unsafe,
    );

    // auth-broker reports a missing service key only as a missing
    // `serviceUrl` — and not at all once a targetUrl is seeded below — so the
    // proxy asks the stores itself, before anything is written, and fails
    // with its own error naming the file to create.
    await requireCredentials(destination, serviceKeyStore, sessionStore);
    await this.seedSessionServiceUrl(destination, sessionStore);

    const broker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        provider: authorizationCodeProviderFactory(this.config),
      },
      loggerAdapter,
    );

    this.btpAuthBrokers.set(destination, broker);
    return broker;
  }

  /**
   * Put a configured `targetUrl` into the destination's session as its
   * `serviceUrl`.
   *
   * auth-broker 3 refuses a destination whose session and service key both
   * lack a `serviceUrl`, and an XSUAA service key for a BTP-hosted MCP server
   * usually carries none: the target URL is what the proxy is told instead.
   * Only `serviceUrl` is written, through the session store's public
   * `setConnectionConfig` — no placeholder credentials and no client secret,
   * which the broker reads from the service key and no longer copies into
   * the session.
   */
  private async seedSessionServiceUrl(
    destination: string,
    sessionStore: ISessionStore,
  ): Promise<void> {
    const targetUrl = this.config.targetUrl;
    if (!targetUrl) {
      return;
    }
    const current = await readOrNull(`session for ${destination}`, () =>
      sessionStore.getConnectionConfig(destination),
    );
    if (current?.serviceUrl === targetUrl) {
      return;
    }
    await sessionStore.setConnectionConfig(destination, {
      serviceUrl: targetUrl,
    });
    logger?.debug(
      'Seeded the session serviceUrl with the configured targetUrl',
      {
        type: 'BTP_SESSION_SERVICE_URL',
        destination,
        url: targetUrl,
      },
    );
  }

  /**
   * The `Authorization` header value for a destination, or `null` when this
   * credential is not a header at all.
   *
   * A complete header value, not a token: the caller puts it on the request as
   * it stands. The credential is asked every time because it renews behind this
   * call — a cache here would serve the stale token and hide the renewal the
   * broker exists to do, which is precisely what the token cache, the JWT `exp`
   * decoder and the per-destination refresh timer that used to live here did.
   *
   * Retried, because a refusal here is not always an answer. In the standalone
   * proxy an authentication failure is FATAL — it exits so something can start
   * it again — so without this a single transient UAA 503 kills a proxy that
   * used to ride it out. Only failures that can get better are retried;
   * `isRetryableError` says which, and a missing service key is not one of
   * them, so it fails on the first attempt instead of three times slower.
   */
  async getAuthorizationHeader(destination: string): Promise<string | null> {
    logger?.debug('Asking the credential for a header', {
      type: 'CREDENTIAL_HEADER_GET',
      destination,
    });

    const retryOptions: RetryOptions = {
      maxRetries: this.config.maxRetries || 3,
      retryDelay: this.config.retryDelay || 1000,
      retryableStatusCodes: [500, 502, 503, 504],
    };

    try {
      return await retryWithBackoff(async () => {
        const { credential } = await this.credentials.get(destination);
        return credential.authorizationHeader();
      }, retryOptions);
    } catch (error) {
      // Passed on as it stands: auth-broker 3 no longer rewords a provider's
      // failure, and a missing service key is already this proxy's own
      // ServiceKeyNotFoundError, which names the file to create.
      const message = error instanceof Error ? error.message : String(error);
      logger?.error('Failed to get an authorization header', {
        type: 'CREDENTIAL_HEADER_ERROR',
        destination,
        error: message,
      });
      if (shouldWriteStderr()) {
        process.stderr.write(`[MCP Proxy] ✗ ${message}\n`);
      }
      throw new Error(message, { cause: error });
    }
  }

  public dispose(): void {
    this.credentials.clear();
    this.btpAuthBrokers.clear();
  }

  /**
   * Get the target service URL for a destination.
   * Priority: config.targetUrl > service key's serviceUrl
   */
  async getTargetUrl(destination: string): Promise<string> {
    if (this.config.targetUrl) {
      return this.config.targetUrl;
    }
    const broker = await this.getOrCreateBtpAuthBroker(destination);
    const connConfig = await broker.getConnectionConfig(destination);
    if (connConfig?.serviceUrl) {
      return connConfig.serviceUrl;
    }
    throw new Error(
      `No target URL found for destination "${destination}". ` +
        `Set targetUrl in config or ensure service key contains abap.url.`,
    );
  }

  /**
   * Create a new BtpProxy instance
   */
  public static async create(config?: Partial<ProxyConfig>): Promise<BtpProxy> {
    const loadedConfig = config ? { ...loadConfig(), ...config } : loadConfig();
    const unsafeIndex = loadedConfig.unsafe ?? false;

    const { serviceKeyStore, sessionStore } =
      await getPlatformStores(unsafeIndex);

    const defaultBtpAuthBroker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        provider: authorizationCodeProviderFactory(loadedConfig),
      },
      loggerAdapter,
    );

    return new BtpProxy(defaultBtpAuthBroker, loadedConfig);
  }
}

/**
 * Factory function to create BtpProxy
 */
export async function createBtpProxy(
  config?: Partial<ProxyConfig>,
): Promise<BtpProxy> {
  return BtpProxy.create(config);
}
