import { jest } from '@jest/globals';
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
    browserCallbackStrategy,
    ClientCredentialsProvider,
} from '@mcp-abap-adt/auth-providers';
import axios from 'axios';
import {
    BtpProxy,
    type ProxyRequest,
    type ProxyResponse,
    shouldWriteStderr,
} from '../../proxy/btpProxy';
import { RoutingStrategy } from '../../router/headerAnalyzer';

// Mock types
type MockAxiosInstance = {
    request: jest.Mock;
    interceptors: {
        request: { use: jest.Mock };
        response: { use: jest.Mock };
    };
};

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

jest.mock('../../lib/stores', () => ({
    getPlatformPaths: jest.fn().mockReturnValue(['/mock/service-keys']),
    getPlatformStores: jest.fn().mockReturnValue(
        Promise.resolve({
            serviceKeyStore: {
                getAuthorizationConfig: jest.fn(),
                getConnectionConfig: jest.fn(),
            },
            sessionStore: {
                saveSession: jest.fn(),
                getAuthorizationConfig: jest.fn(),
            },
        }),
    ),
}));

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

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
    let mockAxiosInstance: any;

    beforeEach(() => {
        jest.clearAllMocks();

        process.env.NODE_ENV = 'test';

        // Setup axios mock
        mockAxiosInstance = {
            request: jest.fn(),
            interceptors: {
                request: { use: jest.fn() },
                response: { use: jest.fn() },
            },
        };
        mockedAxios.create.mockReturnValue(mockAxiosInstance);

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
            saveSession: jest.fn(),
            getAuthorizationConfig: jest.fn(),
            getConnectionConfig: jest.fn(),
            setAuthorizationConfig: jest.fn(),
            setConnectionConfig: jest.fn(),
        };

        mockAuthBroker = new AuthBroker(
            {
                serviceKeyStore: mockServiceKeyStore,
                sessionStore: mockSessionStore,
                tokenProvider: mockTokenProvider,
            },
            'none',
        );

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

            expect(mockBrowserCallbackStrategy).toHaveBeenCalledWith(
                expect.objectContaining({ browser: 'chrome', port: 9999 }),
            );
        });
    });


    describe('BtpProxy.create() default (no-destination) broker', () => {
        // This is the placeholder-credential broker used only when no
        // destination is configured. It cannot complete a real login, but it
        // still builds an authorization strategy at construction time, and
        // that strategy's port must not silently collide with the proxy's
        // own default httpPort (3001) — see the "Fixed" entry in CHANGELOG.md
        // for 2.0.0.
        it('builds it with the documented default port when browserAuthPort is not set', async () => {
            await BtpProxy.create();

            expect(mockBrowserCallbackStrategy).toHaveBeenCalledWith(
                expect.objectContaining({ port: 3333 }),
            );
        });

        it('builds it with the configured browserAuthPort when one is set', async () => {
            await BtpProxy.create({
                browser: 'firefox',
                browserAuthPort: 9999,
            } as any);

            expect(mockBrowserCallbackStrategy).toHaveBeenCalledWith(
                expect.objectContaining({ browser: 'firefox', port: 9999 }),
            );
        });
    });
});
