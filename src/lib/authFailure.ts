/**
 * Authentication failures: the one the proxy raises itself, and how any of
 * them is told apart for the message printed before the standalone proxy
 * exits.
 */

import { ValidationError } from '@mcp-abap-adt/auth-providers';
import { getPlatformPaths } from './stores.js';

/**
 * No UAA credentials for a destination in either store.
 *
 * The proxy's own error, thrown before the broker is asked: auth-broker 3
 * hands a provider's failure back unchanged and reports a missing service key
 * only as a missing `serviceUrl`, so matching its message for this case — as
 * the proxy used to — finds nothing any more. Not retried: a key that is not
 * there now will not be there in a second.
 */
export class ServiceKeyNotFoundError extends Error {
  readonly code = 'SERVICE_KEY_NOT_FOUND';

  constructor(
    readonly destination: string,
    readonly searched: string = getPlatformPaths('service-keys')[0],
  ) {
    super(
      [
        `Service key file not found for destination "${destination}".`,
        `Please create service key file: ${destination}.json`,
        'Searched in:',
        `  - ${searched}`,
      ].join('\n'),
    );
    this.name = 'ServiceKeyNotFoundError';
  }
}

export type AuthFailureCategory =
  | 'timeout'
  | 'credentials'
  | 'service-key'
  | 'network'
  | 'other';

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/** The error and every `cause` behind it, nearest first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 10) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function codeOf(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const { code } = error as { code: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Classify an authentication failure into a human-readable reason so the proxy
 * can report *why* it is exiting (timeout vs bad credentials vs network ...).
 *
 * By type and `code` first, through the whole `cause` chain: auth-broker 3
 * passes provider errors on unchanged, so their classes and codes arrive
 * intact. The message is read only where nothing typed says more — a browser
 * login's timeout and a UAA refusal are both a plain message inside their
 * error.
 */
export function classifyAuthFailure(error: unknown): {
  category: AuthFailureCategory;
  reason: string;
} {
  const chain = causeChain(error);
  if (
    chain.some(
      (e) =>
        e instanceof ServiceKeyNotFoundError || e instanceof ValidationError,
    )
  ) {
    return {
      category: 'service-key',
      reason: 'service key missing or incomplete',
    };
  }
  if (chain.some((e) => NETWORK_CODES.has(codeOf(e) ?? ''))) {
    return {
      category: 'network',
      reason: 'network error reaching the authentication server',
    };
  }

  const msg = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(msg)) {
    return {
      category: 'timeout',
      reason: 'the login URL was not completed in time',
    };
  }
  if (/service key|missing required fields/i.test(msg)) {
    return {
      category: 'service-key',
      reason: 'service key missing or incomplete',
    };
  }
  if (/invalid_client|unauthorized|\b401\b|invalid credentials/i.test(msg)) {
    return {
      category: 'credentials',
      reason: 'invalid credentials — UAA rejected the client',
    };
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|ENETUNREACH/i.test(msg)) {
    return {
      category: 'network',
      reason: 'network error reaching the authentication server',
    };
  }
  return { category: 'other', reason: msg };
}
