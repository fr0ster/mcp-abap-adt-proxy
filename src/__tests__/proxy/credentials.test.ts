/**
 * The credential a destination authenticates with, and where its requests go.
 *
 * What this replaces is a token cache, a JWT `exp` decoder and a refresh timer
 * per destination, all of which duplicated what the broker already does. So the
 * tests here are about the seam, not about tokens: that one credential is built
 * per destination and kept, that asking it for a header reaches the broker every
 * time rather than a cache of our own, and that nothing is left running.
 */

import { describe, expect, it } from '@jest/globals';
import { DestinationCredentials } from '../../proxy/credentials.js';

type Refresher = { getToken(): Promise<string>; refreshToken(): Promise<string> };

/** Enough of an AuthBroker for this seam, and nothing more. */
function fakeBroker(options: { serviceUrl?: string; token?: string } = {}) {
  const calls = { getToken: 0, connectionConfig: 0 };
  const broker = {
    calls,
    createTokenRefresher(_destination: string): Refresher {
      return {
        async getToken() {
          calls.getToken += 1;
          return options.token ?? 'a-token';
        },
        async refreshToken() {
          return options.token ?? 'a-token';
        },
      };
    },
    async getConnectionConfig(_destination: string) {
      calls.connectionConfig += 1;
      return options.serviceUrl ? { serviceUrl: options.serviceUrl } : null;
    },
  };
  return broker;
}

describe('DestinationCredentials', () => {
  it('builds one credential per destination and keeps it', async () => {
    let brokersBuilt = 0;
    const credentials = new DestinationCredentials(async () => {
      brokersBuilt += 1;
      return fakeBroker({ serviceUrl: 'https://one.example' }) as never;
    });

    const first = await credentials.get('D1');
    const second = await credentials.get('D1');

    expect(second.credential).toBe(first.credential);
    expect(brokersBuilt).toBe(1);
  });

  it('keeps destinations apart', async () => {
    const credentials = new DestinationCredentials(async (destination) =>
      fakeBroker({ serviceUrl: `https://${destination}.example` }) as never,
    );

    const one = await credentials.get('D1');
    const two = await credentials.get('D2');

    expect(two.credential).not.toBe(one.credential);
    expect(one.baseUrl).toBe('https://D1.example');
    expect(two.baseUrl).toBe('https://D2.example');
  });

  it('asks the broker for a token on every header, holding no cache of its own', async () => {
    const broker = fakeBroker({ serviceUrl: 'https://one.example', token: 't' });
    const credentials = new DestinationCredentials(async () => broker as never);

    const { credential } = await credentials.get('D1');
    await credential.authorizationHeader();
    await credential.authorizationHeader();
    await credential.authorizationHeader();

    // The broker caches and knows expiry. A cache here would serve a stale
    // token and hide the refresh the broker exists to do.
    expect(broker.calls.getToken).toBe(3);
  });

  it("gives the header the broker's token, spelled as a header", async () => {
    const credentials = new DestinationCredentials(async () =>
      fakeBroker({ serviceUrl: 'https://one.example', token: 'abc123' }) as never,
    );

    const { credential } = await credentials.get('D1');

    expect(await credential.authorizationHeader()).toBe('Bearer abc123');
  });

  it('reports no base url when the service key carries none', async () => {
    const credentials = new DestinationCredentials(
      async () => fakeBroker() as never,
    );

    const { baseUrl } = await credentials.get('D1');

    expect(baseUrl).toBeUndefined();
  });

  it('drops what it holds when cleared, so nothing outlives a stop', async () => {
    let brokersBuilt = 0;
    const credentials = new DestinationCredentials(async () => {
      brokersBuilt += 1;
      return fakeBroker({ serviceUrl: 'https://one.example' }) as never;
    });

    await credentials.get('D1');
    credentials.clear();
    await credentials.get('D1');

    expect(brokersBuilt).toBe(2);
  });

  it('does not leave a failed lookup cached', async () => {
    let attempt = 0;
    const credentials = new DestinationCredentials(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('service key not found');
      return fakeBroker({ serviceUrl: 'https://one.example' }) as never;
    });

    await expect(credentials.get('D1')).rejects.toThrow('service key not found');
    const recovered = await credentials.get('D1');

    expect(recovered.baseUrl).toBe('https://one.example');
  });
});
