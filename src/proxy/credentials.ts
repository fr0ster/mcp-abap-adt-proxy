// src/proxy/credentials.ts
import { TokenAuthProvider } from '@mcp-abap-adt/connection';
import type { ITokenRefresher } from '@mcp-abap-adt/interfaces-auth';

/**
 * What a destination authenticates with, and where its requests go.
 *
 * The credential is the ecosystem's shared one — `TokenAuthProvider` over the
 * broker's `ITokenRefresher`. It is asked for a header per request and renews
 * behind that call, which is why nothing here caches a token, decodes a JWT
 * `exp`, or runs a refresh timer. All three used to live in `BtpProxy` and all
 * three duplicated the broker, the last one by holding a `setTimeout` per
 * destination for the life of the process.
 */
export interface DestinationAccess {
  readonly credential: TokenAuthProvider;
  /** From the service key. `undefined` when it carries none. */
  readonly baseUrl: string | undefined;
}

/**
 * The part of `AuthBroker` this needs, named rather than taken whole.
 *
 * Two methods is the entire seam, so a test states two methods instead of
 * standing up a broker with a service-key store behind it.
 */
export interface CredentialSource {
  createTokenRefresher(destination: string): ITokenRefresher;
  getConnectionConfig(
    destination: string,
  ): Promise<{ serviceUrl?: string } | null>;
}

export type BrokerFor = (destination: string) => Promise<CredentialSource>;

export class DestinationCredentials {
  /**
   * The promise is held, not the result, so concurrent first requests for one
   * destination share a single build instead of racing to make two credentials
   * and two brokers.
   */
  private readonly held = new Map<string, Promise<DestinationAccess>>();

  constructor(private readonly brokerFor: BrokerFor) {}

  get(destination: string): Promise<DestinationAccess> {
    const existing = this.held.get(destination);
    if (existing) return existing;

    const pending = this.build(destination).catch((error) => {
      // A rejected promise left in the map would serve the failure forever: a
      // service key added after the first miss would never be seen.
      this.held.delete(destination);
      throw error;
    });
    this.held.set(destination, pending);
    return pending;
  }

  private async build(destination: string): Promise<DestinationAccess> {
    const broker = await this.brokerFor(destination);
    const credential = new TokenAuthProvider(
      broker.createTokenRefresher(destination),
    );
    const connection = await broker.getConnectionConfig(destination);
    return { credential, baseUrl: connection?.serviceUrl };
  }

  /** Drop everything held. Nothing here outlives a stop. */
  clear(): void {
    this.held.clear();
  }
}
