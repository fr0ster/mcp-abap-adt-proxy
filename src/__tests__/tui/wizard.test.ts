/**
 * Unit tests for generateConfigYaml
 */

import {
  generateConfigYaml,
  type WizardAnswers,
} from '../../tui/wizard.js';

/** Minimal BTP answers for reuse */
function btpAnswers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    scenario: 'btp',
    btpDestination: 'my-btp',
    mcpDestination: 'my-mcp',
    transport: 'http',
    httpHost: '127.0.0.1',
    httpPort: 4000,
    browser: 'system',
    browserAuthPort: 8080,
    unsafe: false,
    logLevel: 'info',
    ...overrides,
  };
}

/** Minimal direct answers for reuse */
function directAnswers(
  overrides: Partial<WizardAnswers> = {},
): WizardAnswers {
  return {
    scenario: 'direct',
    mcpUrl: 'https://my-mcp-server.com/mcp',
    transport: 'http',
    httpHost: '0.0.0.0',
    httpPort: 3001,
    browser: 'none',
    browserAuthPort: 8080,
    unsafe: false,
    logLevel: 'info',
    ...overrides,
  };
}

describe('generateConfigYaml', () => {
  describe('BTP scenario with all fields', () => {
    it('should include btpDestination and mcpDestination as active, mcpUrl commented out', () => {
      const yaml = generateConfigYaml(
        btpAnswers({ cloudLlmHubUrl: 'https://llm-hub.example.com' }),
      );

      expect(yaml).toContain('btpDestination: "my-btp"');
      expect(yaml).toContain('mcpDestination: "my-mcp"');
      expect(yaml).toMatch(/^# mcpUrl:/m);
      expect(yaml).toContain('transport: http');
      expect(yaml).toContain('httpPort: 4000');
      expect(yaml).toContain('httpHost: "127.0.0.1"');
      expect(yaml).toContain('browser: "system"');
      expect(yaml).toContain('browserAuthPort: 8080');
      expect(yaml).toContain('unsafe: false');
      expect(yaml).toContain('logLevel: "info"');
      expect(yaml).toContain('cloudLlmHubUrl: "https://llm-hub.example.com"');
    });

    it('should comment out mcpUrl with its value when provided in BTP scenario', () => {
      const yaml = generateConfigYaml(
        btpAnswers({ mcpUrl: 'https://fallback.example.com' }),
      );

      expect(yaml).toContain('# mcpUrl: "https://fallback.example.com"');
    });
  });

  describe('Direct URL scenario', () => {
    it('should include mcpUrl as active, btpDestination and mcpDestination commented out', () => {
      const yaml = generateConfigYaml(directAnswers());

      expect(yaml).toContain('mcpUrl: "https://my-mcp-server.com/mcp"');
      expect(yaml).toMatch(/^# btpDestination:/m);
      expect(yaml).toMatch(/^# mcpDestination:/m);
      // Ensure they are truly commented, not active
      expect(yaml).not.toMatch(/^btpDestination:/m);
      expect(yaml).not.toMatch(/^mcpDestination:/m);
    });
  });

  describe('Advanced settings', () => {
    it('should use provided values when set', () => {
      const yaml = generateConfigYaml(
        btpAnswers({
          maxRetries: 5,
          retryDelay: 2000,
          requestTimeout: 120000,
          circuitBreakerThreshold: 10,
          circuitBreakerTimeout: 90000,
        }),
      );

      expect(yaml).toContain('maxRetries: 5');
      expect(yaml).toContain('retryDelay: 2000');
      expect(yaml).toContain('requestTimeout: 120000');
      expect(yaml).toContain('circuitBreakerThreshold: 10');
      expect(yaml).toContain('circuitBreakerTimeout: 90000');
    });

    it('should use defaults when advanced settings are not provided', () => {
      const yaml = generateConfigYaml(btpAnswers());

      expect(yaml).toContain('maxRetries: 3');
      expect(yaml).toContain('retryDelay: 1000');
      expect(yaml).toContain('requestTimeout: 60000');
      expect(yaml).toContain('circuitBreakerThreshold: 5');
      expect(yaml).toContain('circuitBreakerTimeout: 60000');
    });
  });

  describe('SSE transport', () => {
    it('should include both http and sse port/host fields', () => {
      const yaml = generateConfigYaml(
        btpAnswers({
          transport: 'sse',
          httpPort: 3001,
          httpHost: '0.0.0.0',
          ssePort: 3002,
          sseHost: '0.0.0.0',
        }),
      );

      expect(yaml).toContain('transport: sse');
      expect(yaml).toContain('httpPort: 3001');
      expect(yaml).toContain('httpHost: "0.0.0.0"');
      expect(yaml).toContain('ssePort: 3002');
      expect(yaml).toContain('sseHost: "0.0.0.0"');
    });
  });

  describe('stdio transport', () => {
    it('should exclude port and host fields', () => {
      const yaml = generateConfigYaml(
        btpAnswers({ transport: 'stdio' }),
      );

      expect(yaml).toContain('transport: stdio');
      expect(yaml).not.toContain('httpPort');
      expect(yaml).not.toContain('httpHost');
      expect(yaml).not.toContain('ssePort');
      expect(yaml).not.toContain('sseHost');
    });
  });

  describe('YAML formatting', () => {
    it('should quote string values, leave numbers and booleans unquoted', () => {
      const yaml = generateConfigYaml(
        btpAnswers({ maxRetries: 3, unsafe: true }),
      );

      // String values are quoted
      expect(yaml).toContain('btpDestination: "my-btp"');
      expect(yaml).toContain('logLevel: "info"');
      // Numbers are unquoted
      expect(yaml).toContain('maxRetries: 3');
      expect(yaml).toContain('browserAuthPort: 8080');
      // Booleans are unquoted
      expect(yaml).toContain('unsafe: true');
    });
  });
});
