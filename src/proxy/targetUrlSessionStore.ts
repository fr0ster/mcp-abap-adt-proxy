/**
 * A session store that tells the broker the proxy's `targetUrl` without
 * writing it over the destination's own URL.
 *
 * auth-broker 3 refuses a destination whose session and service key both lack
 * a `serviceUrl`, and an XSUAA service key for a BTP-hosted MCP server usually
 * carries none: the target URL is what the proxy is told instead. The proxy
 * used to write it into the session before building the broker — and, with
 * `unsafe`, that session is the file `mcp-auth` writes too, so its `SAP_URL`
 * was replaced by the MCP server's URL.
 *
 * Reads answer the target URL as the `serviceUrl`. Writes keep the URL the
 * session already holds; only a session that does not exist yet is created
 * with the target URL, since a store cannot create one without a URL.
 * Everything else passes through to the store it wraps.
 */

import type {
  IAuthorizationConfig,
  IConfig,
  IConnectionConfig,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-sap';

export class TargetUrlSessionStore implements ISessionStore {
  constructor(
    private readonly inner: ISessionStore,
    private readonly targetUrl: string,
  ) {}

  async loadSession(destination: string): Promise<IConfig | null> {
    const session = await this.inner.loadSession(destination);
    return session ? { ...session, serviceUrl: this.targetUrl } : null;
  }

  async getConnectionConfig(
    destination: string,
  ): Promise<IConnectionConfig | null> {
    const connection = await this.inner.getConnectionConfig(destination);
    return { ...(connection ?? {}), serviceUrl: this.targetUrl };
  }

  getAuthorizationConfig(
    destination: string,
  ): Promise<IAuthorizationConfig | null> {
    return this.inner.getAuthorizationConfig(destination);
  }

  setAuthorizationConfig(
    destination: string,
    config: IAuthorizationConfig,
  ): Promise<void> {
    return this.inner.setAuthorizationConfig(destination, config);
  }

  async setConnectionConfig(
    destination: string,
    config: IConnectionConfig,
  ): Promise<void> {
    await this.inner.setConnectionConfig(destination, {
      ...config,
      serviceUrl: await this.ownServiceUrl(destination),
    });
  }

  async saveSession(
    destination: string,
    config: IConfig | unknown,
  ): Promise<void> {
    await this.inner.saveSession(destination, {
      ...(config as IConfig),
      serviceUrl: await this.ownServiceUrl(destination),
    });
  }

  async deleteSession(destination: string): Promise<void> {
    await this.inner.deleteSession?.(destination);
  }

  /** The URL the session holds, or the target URL for a session not yet written. */
  private async ownServiceUrl(destination: string): Promise<string> {
    const stored = await this.inner.getConnectionConfig(destination);
    return stored?.serviceUrl ?? this.targetUrl;
  }
}
