/**
 * BTP Proxy - Proxies requests to MCP servers with JWT authentication
 *
 * For requests with x-sap-destination, proxies to target MCP server
 * with JWT token from auth-broker (XSUAA/BTP)
 */

import { AuthBroker, type ILogger } from '@mcp-abap-adt/auth-broker';
import {
  AuthorizationCodeProvider,
  type AuthorizationCodeProviderConfig,
  browserCallbackStrategy,
} from '@mcp-abap-adt/auth-providers';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import {
  HEADER_ACCEPT,
  HEADER_AUTHORIZATION,
  HEADER_CONTENT_TYPE,
  HEADER_SAP_CLIENT,
  HEADER_SAP_DESTINATION,
  HEADER_SAP_DESTINATION_SERVICE,
} from '@mcp-abap-adt/interfaces-network';
import { loadConfig, type ProxyConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { getPlatformPaths, getPlatformStores } from '../lib/stores.js';
import type { RoutingDecision } from '../router/headerAnalyzer.js';
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

import {
  CircuitBreaker,
  createErrorResponse,
  isTokenExpirationError,
  type RetryOptions,
  retryWithBackoff,
} from '../lib/errorHandler.js';

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
  private circuitBreaker: CircuitBreaker;
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

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold || 5,
      this.config.circuitBreakerTimeout || 60000,
    );
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
    targetUrl?: string,
  ): Promise<AuthBroker> {
    // If no destination, use default broker
    if (!destination) {
      return this.defaultBtpAuthBroker;
    }

    // Check if broker exists in map
    let broker = this.btpAuthBrokers.get(destination);
    if (broker) {
      return broker;
    }

    // Create new broker for this destination
    logger?.info('Creating new BTP auth broker for destination', {
      type: 'BTP_BROKER_CREATE',
      destination,
    });

    const { serviceKeyStore, sessionStore } = await getPlatformStores(
      this.unsafe,
    );

    // We must manually load the credentials because AuthorizationCodeProvider validates them in constructor
    let authConfig: IAuthorizationConfig | null = null;
    try {
      // Try service key store first
      if (serviceKeyStore) {
        authConfig = await serviceKeyStore.getAuthorizationConfig(destination);
      }
      // If not found, try session store (though less likely for initial setup)
      if (!authConfig) {
        authConfig = await sessionStore.getAuthorizationConfig(destination);
      }
    } catch (error) {
      logger?.warn('Failed to load auth config for provider initialization', {
        error: error instanceof Error ? error.message : String(error),
        destination,
      });
    }

    if (!authConfig) {
      const serviceKeyDir = getPlatformPaths('service-keys')[0];
      logger?.error('Service key not found for destination', {
        destination,
        hint: `Ensure service key file "${destination}.json" exists in ${serviceKeyDir} (override the base dir with AUTH_BROKER_PATH)`,
      });
      // We cannot proceed without config, but we'll let it fail with a clear message
      // Or we could throw here.
      // If we don't provide config, provider will throw "Missing required fields".
    }

    // Always use AuthorizationCodeProvider (enforced)
    // Map IAuthorizationConfig (uaaClientId) to ProviderConfig (clientId)
    // How the login is conducted is now a strategy the provider config
    // carries under `authorization`; the callback port lives inside it.
    //
    // uaaUrl/clientId/clientSecret fall back to '' rather than being omitted
    // when authConfig is missing: AuthorizationCodeProviderConfig declares
    // them required, and the provider's own constructor already treats an
    // empty string the same as absent, throwing its "Missing required
    // fields" ValidationError — which is the clear failure this was always
    // meant to produce.
    const providerConfig: AuthorizationCodeProviderConfig = {
      authorization: browserCallbackStrategy({
        browser: this.config.browser,
        port: this.config.browserAuthPort || DEFAULT_BROWSER_AUTH_PORT,
        timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS,
      }),
      // Pass a logger so the callback strategy can surface the "Open this
      // URL" prompt in 'none'/'headless' mode. Without it, the callback
      // server gets a null logger and silently drops the authorization URL.
      logger: loggerAdapter,
      uaaUrl: authConfig?.uaaUrl ?? '',
      clientId: authConfig?.uaaClientId ?? '',
      clientSecret: authConfig?.uaaClientSecret ?? '',
    };

    const tokenProvider = new AuthorizationCodeProvider(providerConfig);

    broker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider,
      },
      this.config.browser, // Pass configured browser (default: 'system')
      logger,
    );

    this.btpAuthBrokers.set(destination, broker);

    return this.ensureSessionServiceUrl(broker, destination, targetUrl);
  }

  /**
   * Helper to ensure valid serviceUrl in session if override provided
   */
  private async ensureSessionServiceUrl(
    broker: AuthBroker,
    destination: string,
    targetUrl?: string,
  ): Promise<AuthBroker> {
    const activeTargetUrl = targetUrl || this.config.targetUrl;

    if (!activeTargetUrl) {
      return broker;
    }

    try {
      // Check if current connection config exists
      const currentConn = await broker.getConnectionConfig(destination);

      // We need to ensure we have a valid session with BOTH serviceUrl AND auth config.
      // Even if serviceUrl matches, the auth config might be missing from the session
      // (which causes ClientCredentialsProvider to fail if initialized with empty config).

      // Cast to any to access potentially private methods if interface restricted
      // biome-ignore lint/suspicious/noExplicitAny: Accessing internal methods for safe injection
      const brokerAny = broker as any;

      let authConfig = await broker.getAuthorizationConfig(destination);
      if (!authConfig) {
        try {
          if (
            typeof brokerAny.getAuthorizationConfigFromServiceKey === 'function'
          ) {
            authConfig =
              await brokerAny.getAuthorizationConfigFromServiceKey(destination);
          }
        } catch (e) {
          logger?.debug('Could not find auth config for session update', {
            error: String(e),
          });
        }
      }

      if (!authConfig) {
        authConfig = {
          uaaUrl: 'https://placeholder.authentication.sap.hana.ondemand.com',
          uaaClientId: 'placeholder',
          uaaClientSecret: 'placeholder',
        } as any;
        logger?.info('Using placeholder auth config for session injection', {
          type: 'BTP_SESSION_PLACEHOLDER',
          destination,
          targetUrl: activeTargetUrl,
        });
      }

      if (authConfig) {
        const newConn = {
          ...(currentConn || {}),
          serviceUrl: activeTargetUrl,
          authType: 'jwt' as any,
          // Map XSUAA keys to ClientCredentialsProvider keys
          clientId: authConfig.uaaClientId,
          clientSecret: authConfig.uaaClientSecret,
          uaaUrl: authConfig.uaaUrl,
        };

        if (typeof brokerAny.saveTokenToSession === 'function') {
          await brokerAny.saveTokenToSession(destination, newConn, authConfig);
          logger?.info('Injected targetUrl and auth config into BTP session', {
            type: 'BTP_SESSION_INJECTION',
            destination,
            url: activeTargetUrl,
            hasClientId: !!newConn.clientId,
          });
        } else {
          logger?.error('saveTokenToSession is not a function on broker', {
            type: 'BTP_SESSION_METHOD_MISSING',
            keys: Object.keys(brokerAny),
          });
        }
      }
    } catch (error) {
      logger?.error('Failed to inject targetUrl into session', {
        type: 'BTP_SESSION_INJECTION_ERROR',
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return broker;
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
   */
  async getAuthorizationHeader(destination: string): Promise<string | null> {
    logger?.debug('Asking the credential for a header', {
      type: 'CREDENTIAL_HEADER_GET',
      destination,
    });
    const { credential } = await this.credentials.get(destination);
    return credential.authorizationHeader();
  }

  /**
   * Let go of everything held. Call on shutdown.
   *
   * There are no timers to cancel any more: the refresh timer per destination
   * went with the token cache it existed to top up. What is left is memory —
   * the credentials and the brokers behind them.
   */
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
   * Helper function to extract string value from header (handles arrays)
   */
  private getHeaderValue(
    headerValue: string | string[] | undefined,
  ): string | undefined {
    if (!headerValue) return undefined;
    if (Array.isArray(headerValue)) {
      return headerValue[0]?.trim();
    }
    return typeof headerValue === 'string' ? headerValue.trim() : undefined;
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
        tokenProvider: new AuthorizationCodeProvider({
          uaaUrl: 'https://placeholder.authentication.sap.hana.ondemand.com',
          clientId: 'placeholder',
          clientSecret: 'placeholder',
          authorization: browserCallbackStrategy({
            browser: loadedConfig.browser,
            // This call site never had its own fallback: it passed
            // `redirectPort` straight through and relied on
            // auth-providers@1.2.0 defaulting an omitted value to 3001
            // internally — which is this proxy's own default `httpPort`
            // (src/lib/config.ts). An omitted `browserAuthPort` therefore
            // told the callback server to bind the port the proxy already
            // listens on, failing every such login with "Port 3001 is
            // already in use". Both call sites now share the one documented
            // default instead of leaving this one to an invisible, colliding
            // number.
            port: loadedConfig.browserAuthPort || DEFAULT_BROWSER_AUTH_PORT,
            timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS,
          }),
          logger: loggerAdapter,
        }),
      },
      'none',
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
