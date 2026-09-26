import {
  BrowserAuthError,
  ValidationError,
} from '@mcp-abap-adt/auth-providers';
import {
  classifyAuthFailure,
  ServiceKeyNotFoundError,
} from '../../lib/authFailure';

/** The shape `BtpProxy.getAuthorizationHeader` rethrows: message kept, original as `cause`. */
function asRethrown(error: Error): Error {
  return new Error(error.message, { cause: error });
}

describe('ServiceKeyNotFoundError', () => {
  it('names the file to create and where it was looked for', () => {
    const error = new ServiceKeyNotFoundError('D1', '/keys');

    expect(error.message).toContain(
      'Service key file not found for destination "D1"',
    );
    expect(error.message).toContain('D1.json');
    expect(error.message).toContain('  - /keys');
    expect(error.code).toBe('SERVICE_KEY_NOT_FOUND');
  });
});

describe('classifyAuthFailure', () => {
  it('knows a missing service key by its class, through the cause', () => {
    expect(
      classifyAuthFailure(asRethrown(new ServiceKeyNotFoundError('D1', '/k')))
        .category,
    ).toBe('service-key');
  });

  it("knows an incomplete service key by the provider's ValidationError", () => {
    const incomplete = new ValidationError('uaaUrl is required', ['uaaUrl']);

    expect(classifyAuthFailure(asRethrown(incomplete)).category).toBe(
      'service-key',
    );
  });

  it('knows a network failure by its code, whatever the message says', () => {
    const refused = Object.assign(new Error('connect failed'), {
      code: 'ECONNREFUSED',
    });

    expect(classifyAuthFailure(asRethrown(refused)).category).toBe('network');
  });

  it('reads a browser login timeout from its message', () => {
    const timedOut = new BrowserAuthError(
      'Authentication timeout after 300 seconds. Please try again.',
    );

    expect(classifyAuthFailure(asRethrown(timedOut)).category).toBe('timeout');
  });

  it('reads a UAA refusal from its message', () => {
    expect(
      classifyAuthFailure(new Error('Request failed: invalid_client')).category,
    ).toBe('credentials');
  });

  it('answers anything else with its own message', () => {
    expect(classifyAuthFailure(new Error('something odd'))).toEqual({
      category: 'other',
      reason: 'something odd',
    });
  });
});
