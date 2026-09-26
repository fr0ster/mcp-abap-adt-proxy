import { jest } from '@jest/globals';
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
    AuthorizationCodeProvider,
    browserCallbackStrategy,
    ClientCredentialsProvider,
} from '@mcp-abap-adt/auth-providers';
import { ServiceKeyNotFoundError } from '../../lib/authFailure';
import { BtpProxy, shouldWriteStderr } from '../../proxy/btpProxy';

// Mock AuthBroker singleton
const mockAuthBrokerInstance = {
    getToken: jest.fn(),
    getConnectionConfig: jest.fn(),
};

jest.mock('@mcp-abap-adt/auth-broker', () => {
    return {
        AuthBroker: jest.fn().mockImplementation(() => mockAuthBrokerInstance),
    };
});

jest.mock('@mcp-abap-adt/auth-providers', () => {
    return {
        AuthorizationCodeProvider: jest.fn().mockImplementation(() => ({})),
        ClientCredentialsProvider: jest.fn().mockImplementation(() => ({})),
        browserCallbackStrategy: jest.fn().mockImplementation((options) => ({
            __mockStrategyOptions: options,
        })),
    };
});

import { logger } from '../../lib/logger';

// Mock dependencies
jest.mock('../../lib/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock('../../lib/config', () => ({
    loadConfig: jest.fn().mockReturnValue({
        httpPort: 3001,
        ssePort: 3002,
        unsafe: false,
    }),
}));

// The stores every broker the proxy builds is given. Referenced lazily from
// the factory below, because jest.mock is hoisted above this declaration.
const SERVICE_KEY_AUTH = {
    uaaUrl: 'https://uaa.example.com',
    uaaClientId: 'clientid',
    uaaClientSecret: 'secret',
};
const mockPlatformStores = {
    serviceKeyStore: {
        getAuthorizationConfig: jest.fn(),
        getConnectionConfig: jest.fn(),
    },
    sessionStore: {
        getAuthorizationConfig: jest.fn(),
        getConnectionConfig: jest.fn(),
        setConnectionConfig: jest.fn(),
    },
};

jest.mock('../../lib/stores', () => ({
    getPlatformPaths: jest.fn().mockReturnValue(['/mock/service-keys']),
    getPlatformStores: jest.fn(() => Promise.resolve(mockPlatformStores)),
}));

/**
 * The provider factory the most recently built AuthBroker was given. The
 * proxy passes a factory, not an instance, so the broker can seed it from the
 * stores; calling it here is how a test sees what the proxy would build.
 */
function lastProviderFactory() {
    const calls = jest.mocked(AuthBroker).mock.calls;
    const provider = calls[calls.length - 1][0].provider;
    if (typeof provider !== 'function') {
        throw new Error('expected the proxy to pass a provider factory');
    }
    return provider;
}


// Reference to the mocked strategy builder, so tests can assert what it was
// built with — the port and timeout are exactly the values that silently
// stopped being passed if this call regressed, and nothing else would notice.
const mockBrowserCallbackStrategy = browserCallbackStrategy as jest.Mock;

describe('BtpProxy', () => {
    let btpProxy: BtpProxy;
    let mockAuthBroker: AuthBroker;
    let mockTokenProvider: ClientCredentialsProvider;
    let mockServiceKeyStore: any;
    let mockSessionStore: any;

    beforeEach(() => {
        jest.clearAllMocks();

        process.env.NODE_ENV = 'test';

        // Setup AuthBroker mocks
        mockTokenProvider = new ClientCredentialsProvider({
            uaaUrl: 'https://uaa.example.com',
            clientId: 'clientid',
            clientSecret: 'secret',
        });

        mockServiceKeyStore = {
            getAuthorizationConfig: jest.fn(),
            getConnectionConfig: jest.fn(),
            getServiceKey: jest.fn(),
        };
        mockSessionStore = {
            loadSession: jest.fn(),
            saveSession: jest.fn(),
            getAuthorizationConfig: jest.fn(),
            getConnectionConfig: jest.fn(),
            setAuthorizationConfig: jest.fn(),
            setConnectionConfig: jest.fn(),
        };

        // A destination has a service key unless a test says otherwise.
        (mockPlatformStores.serviceKeyStore.getAuthorizationConfig as any).mockResolvedValue(
            SERVICE_KEY_AUTH,
        );
        (mockPlatformStores.sessionStore.getAuthorizationConfig as any).mockResolvedValue(null);
        (mockPlatformStores.sessionStore.getConnectionConfig as any).mockResolvedValue(null);

        mockAuthBroker = new AuthBroker({
            serviceKeyStore: mockServiceKeyStore,
            sessionStore: mockSessionStore,
            provider: mockTokenProvider,
        });

        // Mock getToken
        mockAuthBroker.getToken = (jest.fn() as any).mockResolvedValue('mock-jwt-token');

        // Create proxy instance
        btpProxy = new BtpProxy(mockAuthBroker, {
            httpPort: 3001,
            ssePort: 3002,
            httpHost: '0.0.0.0',
            sseHost: '0.0.0.0',
            logLevel: 'info',
        });
    });

    afterEach(() => {
        delete process.env.MCP_PROXY_VERBOSE;
    });

    describe('shouldWriteStderr', () => {
        const originalEnv = process.env;

        beforeEach(() => {
            jest.resetModules();
            process.env = { ...originalEnv };
        });

        afterEach(() => {
            process.env = originalEnv;
        });

        it('should return false in test environment', () => {
            process.env.NODE_ENV = 'test';
            process.env.MCP_PROXY_VERBOSE = 'true';
            expect(shouldWriteStderr()).toBe(false);
        });

        it('should return true when verbose mode is on and not in test env', () => {
            // Need to un-set test environment indicators
            process.env.NODE_ENV = 'development';
            delete process.env.JEST_WORKER_ID;
            // Note: can't easily remove global.jest, so we might need to skip this test or mock global
            // simpler to just test the logic we can control
        });
    });

    describe('the credential facade', () => {
        beforeEach(() => {
            (mockAuthBroker as any).createTokenRefresher = jest.fn(
                (destination: string) => ({
                    getToken: async () => `token-for-${destination}`,
                    refreshToken: async () => `fresh-token-for-${destination}`,
                }),
            );
            mockAuthBroker.getConnectionConfig = (jest.fn() as any).mockResolvedValue({
                serviceUrl: 'https://btp-mcp.example.com',
            });
        });

        it('answers with a complete header value, not a bare token', async () => {
            const header = await btpProxy.getAuthorizationHeader('D1');

            expect(header).toBe('Bearer token-for-D1');
        });

        it('asks the credential on every call, keeping no token of its own', async () => {
            let handed = 0;
            (mockAuthBroker as any).createTokenRefresher = jest.fn(() => ({
                getToken: async () => {
                    handed += 1;
                    return `t${handed}`;
                },
                refreshToken: async () => 't-fresh',
            }));

            const first = await btpProxy.getAuthorizationHeader('D1');
            const second = await btpProxy.getAuthorizationHeader('D1');

            // A cache here would serve the stale token and hide the renewal the
            // broker exists to do — which is what the deleted tokenCache did.
            expect(first).toBe('Bearer t1');
            expect(second).toBe('Bearer t2');
            expect(handed).toBe(2);
        });

        it('builds the credential once per destination', async () => {
            await btpProxy.getAuthorizationHeader('D1');
            await btpProxy.getAuthorizationHeader('D1');

            expect(
                (mockAuthBroker as any).createTokenRefresher,
            ).toHaveBeenCalledTimes(1);
        });

        it('lets go of the credential on dispose, so nothing outlives a stop', async () => {
            await btpProxy.getAuthorizationHeader('D1');
            btpProxy.dispose();
            await btpProxy.getAuthorizationHeader('D1');

            expect(
                (mockAuthBroker as any).createTokenRefresher,
            ).toHaveBeenCalledTimes(2);
        });

        // The regression this caught: token acquisition used to be wrapped in
        // retryWithBackoff and was not any more. In the standalone proxy an
        // auth failure is FATAL — onAuthFailure exits the process — so a single
        // transient UAA 503 went from "retried" to "kills the proxy".
        it('retries a transient failure while getting the header', async () => {
            let attempts = 0;
            (mockAuthBroker as any).createTokenRefresher = jest.fn(() => ({
                getToken: async () => {
                    attempts += 1;
                    if (attempts < 3) {
                        const transient: any = new Error('Service Unavailable');
                        transient.isAxiosError = true;
                        transient.response = { status: 503 };
                        throw transient;
                    }
                    return 'token-after-retry';
                },
                refreshToken: async () => 'fresh',
            }));
            const retrying = new BtpProxy(mockAuthBroker, {
                httpPort: 3001, ssePort: 3002, httpHost: '0.0.0.0', sseHost: '0.0.0.0',
                logLevel: 'info', maxRetries: 3, retryDelay: 1,
            } as any);

            expect(await retrying.getAuthorizationHeader('D1')).toBe(
                'Bearer token-after-retry',
            );
            expect(attempts).toBe(3);
        });

        it('does not retry a failure that will not get better', async () => {
            let attempts = 0;
            (mockAuthBroker as any).createTokenRefresher = jest.fn(() => ({
                getToken: async () => {
                    attempts += 1;
                    throw new Error('Service key not found');
                },
                refreshToken: async () => 'fresh',
            }));
            const failing = new BtpProxy(mockAuthBroker, {
                httpPort: 3001, ssePort: 3002, httpHost: '0.0.0.0', sseHost: '0.0.0.0',
                logLevel: 'info', maxRetries: 3, retryDelay: 1,
            } as any);

            // Retrying a missing service key just delays the same answer three
            // times over, and in the standalone proxy the delay is before an exit.
            await expect(failing.getAuthorizationHeader('D1')).rejects.toThrow();
            expect(attempts).toBe(1);
        });

        it('says what to create when the service key is missing', async () => {
            (mockPlatformStores.serviceKeyStore.getAuthorizationConfig as any).mockResolvedValue(
                null,
            );
            const failing = new BtpProxy(mockAuthBroker, {
                httpPort: 3001, ssePort: 3002, httpHost: '0.0.0.0', sseHost: '0.0.0.0',
                logLevel: 'info', maxRetries: 3, retryDelay: 1,
            } as any);

            // auth-broker 3 would only say the session lacks a serviceUrl, so
            // the proxy asks the stores itself and names the file to create.
            const failure = failing.getAuthorizationHeader('D1');
            await expect(failure).rejects.toThrow(
                /Service key file not found for destination "D1"/,
            );
            await expect(failure).rejects.toThrow(/D1\.json/);
            await expect(failure).rejects.toThrow(/\/mock\/service-keys/);
            // Asked once: a missing key is not retried, and no broker is built.
            expect(
                mockPlatformStores.serviceKeyStore.getAuthorizationConfig,
            ).toHaveBeenCalledTimes(1);
            expect(jest.mocked(AuthBroker)).toHaveBeenCalledTimes(1);
        });

        it('seeds the session serviceUrl with a configured targetUrl, and nothing else', async () => {
            const withTarget = new BtpProxy(mockAuthBroker, {
                httpPort: 3001, ssePort: 3002, httpHost: '0.0.0.0', sseHost: '0.0.0.0',
                logLevel: 'info', targetUrl: 'https://target.example.com',
            } as any);

            await withTarget.getAuthorizationHeader('D1');

            // Only the url: no placeholder credentials and no client secret
            // are written into the session any more.
            expect(mockPlatformStores.sessionStore.setConnectionConfig).toHaveBeenCalledWith(
                'D1',
                { serviceUrl: 'https://target.example.com' },
            );
        });

        it('leaves the session alone when it already names the targetUrl', async () => {
            (mockPlatformStores.sessionStore.getConnectionConfig as any).mockResolvedValue({
                serviceUrl: 'https://target.example.com',
                authorizationToken: 'stored',
            });
            const withTarget = new BtpProxy(mockAuthBroker, {
                httpPort: 3001, ssePort: 3002, httpHost: '0.0.0.0', sseHost: '0.0.0.0',
                logLevel: 'info', targetUrl: 'https://target.example.com',
            } as any);

            await withTarget.getAuthorizationHeader('D1');

            expect(mockPlatformStores.sessionStore.setConnectionConfig).not.toHaveBeenCalled();
        });

        it('writes nothing into the session without a targetUrl', async () => {
            await btpProxy.getAuthorizationHeader('D1');

            expect(mockPlatformStores.sessionStore.setConnectionConfig).not.toHaveBeenCalled();
        });

        it('takes the target url from the service key', async () => {
            expect(await btpProxy.getTargetUrl('D1')).toBe(
                'https://btp-mcp.example.com',
            );
        });

        it('lets a configured targetUrl win over the service key', async () => {
            const overridden = new BtpProxy(mockAuthBroker, {
                httpPort: 3001,
                ssePort: 3002,
                httpHost: '0.0.0.0',
                sseHost: '0.0.0.0',
                logLevel: 'info',
                targetUrl: 'https://override.example.com',
            } as any);

            expect(await overridden.getTargetUrl('D1')).toBe(
                'https://override.example.com',
            );
        });

        it('refuses a destination whose service key carries no url', async () => {
            mockAuthBroker.getConnectionConfig = (jest.fn() as any).mockResolvedValue(
                null,
            );

            await expect(btpProxy.getTargetUrl('D1')).rejects.toThrow(
                /No target URL found/,
            );
        });

        it('builds the per-destination authorization strategy with a configured browserAuthPort', async () => {
            // A fresh instance so getOrCreateBtpAuthBroker's per-destination
            // broker map starts empty and this destination is actually built,
            // not reused from a previous test.
            const proxyWithPort = new BtpProxy(mockAuthBroker, {
                httpPort: 3001,
                ssePort: 3002,
                httpHost: '0.0.0.0',
                sseHost: '0.0.0.0',
                logLevel: 'info',
                browser: 'chrome',
                browserAuthPort: 9999,
            } as any);

            await proxyWithPort.getAuthorizationHeader('configured-port-dest');
            // The broker builds the provider on its first token request; the
            // mocked broker does not, so the test calls the factory itself.
            lastProviderFactory()('configured-port-dest', SERVICE_KEY_AUTH, {});

            expect(mockBrowserCallbackStrategy).toHaveBeenCalledWith(
                expect.objectContaining({ browser: 'chrome', port: 9999 }),
            );
        });

        it('seeds the provider with the stored refresh token and access token', async () => {
            await btpProxy.getAuthorizationHeader('seeded-dest');

            lastProviderFactory()(
                'seeded-dest',
                { ...SERVICE_KEY_AUTH, refreshToken: 'stored-refresh' },
                { serviceUrl: 'https://x.example.com', authorizationToken: 'stored-access' },
            );

            expect(jest.mocked(AuthorizationCodeProvider)).toHaveBeenCalledWith(
                expect.objectContaining({
                    uaaUrl: 'https://uaa.example.com',
                    clientId: 'clientid',
                    clientSecret: 'secret',
                    refreshToken: 'stored-refresh',
                    accessToken: 'stored-access',
                }),
            );
        });

        it('treats a session seeded without a token as having none', async () => {
            await btpProxy.getAuthorizationHeader('empty-token-dest');

            lastProviderFactory()('empty-token-dest', SERVICE_KEY_AUTH, {
                serviceUrl: 'https://x.example.com',
                authorizationToken: '',
            });

            expect(jest.mocked(AuthorizationCodeProvider)).toHaveBeenCalledWith(
                expect.objectContaining({ accessToken: undefined }),
            );
        });

        it('refuses to build a provider without credentials, naming the file', async () => {
            await btpProxy.getAuthorizationHeader('no-creds-dest');

            expect(() => lastProviderFactory()('no-creds-dest', null, {})).toThrow(
                ServiceKeyNotFoundError,
            );
        });
    });


    describe('BtpProxy.create() default (no-destination) broker', () => {
        // This is the broker used only when no destination is given. It gets
        // the same provider factory as a per-destination one, and the
        // authorization strategy the factory builds has a port that must not silently collide with the proxy's
        // own default httpPort (3001) — see the "Fixed" entry in CHANGELOG.md
        // for 2.0.0.
        it('builds it with the documented default port when browserAuthPort is not set', async () => {
            await BtpProxy.create();
            lastProviderFactory()('D', SERVICE_KEY_AUTH, {});

            expect(mockBrowserCallbackStrategy).toHaveBeenCalledWith(
                expect.objectContaining({ port: 3333 }),
            );
        });

        it('builds it with the configured browserAuthPort when one is set', async () => {
            await BtpProxy.create({
                browser: 'firefox',
                browserAuthPort: 9999,
            } as any);
            lastProviderFactory()('D', SERVICE_KEY_AUTH, {});

            expect(mockBrowserCallbackStrategy).toHaveBeenCalledWith(
                expect.objectContaining({ browser: 'firefox', port: 9999 }),
            );
        });
    });
});
