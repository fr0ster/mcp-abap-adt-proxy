/**
 * TUI wizard for interactive proxy configuration
 * Placeholder — will be implemented in a later task.
 */

/**
 * Answers collected by the wizard
 */
export interface WizardAnswers {
  scenario: 'btp' | 'direct';
  btpDestination?: string;
  mcpDestination?: string;
  mcpUrl?: string;
  transport: 'stdio' | 'http' | 'sse';
  httpHost?: string;
  httpPort?: number;
  sseHost?: string;
  ssePort?: number;
  browser: 'system' | 'headless' | 'chrome' | 'edge' | 'firefox' | 'none';
  browserAuthPort: number;
  unsafe: boolean;
  logLevel: string;
  maxRetries?: number;
  retryDelay?: number;
  requestTimeout?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;
  cloudLlmHubUrl?: string;
}

/** Default values for advanced settings */
const DEFAULTS = {
  maxRetries: 3,
  retryDelay: 1000,
  requestTimeout: 60000,
  circuitBreakerThreshold: 5,
  circuitBreakerTimeout: 60000,
};

/**
 * Generate a YAML configuration string from wizard answers.
 * The output follows the structure of docs/mcp-proxy-config.example.yaml.
 */
export function generateConfigYaml(answers: WizardAnswers): string {
  const lines: string[] = [];

  lines.push('# MCP ABAP ADT Proxy Configuration');
  lines.push('');

  // Transport configuration
  lines.push('# Transport configuration');
  lines.push(`transport: ${answers.transport}  # stdio | http | sse`);

  if (answers.transport === 'http' || answers.transport === 'sse') {
    lines.push(`httpPort: ${answers.httpPort ?? 3001}`);
    lines.push(`httpHost: "${answers.httpHost ?? '0.0.0.0'}"`);
  }

  if (answers.transport === 'sse') {
    lines.push(`ssePort: ${answers.ssePort ?? 3002}`);
    lines.push(`sseHost: "${answers.sseHost ?? '0.0.0.0'}"`);
  }

  lines.push('');

  // Destination overrides
  lines.push('# Destination overrides');

  if (answers.scenario === 'btp') {
    if (answers.btpDestination) {
      lines.push(`btpDestination: "${answers.btpDestination}"`);
    }
    if (answers.mcpDestination) {
      lines.push(`mcpDestination: "${answers.mcpDestination}"`);
    }
    if (answers.mcpUrl) {
      lines.push(`# mcpUrl: "${answers.mcpUrl}"`);
    } else {
      lines.push('# mcpUrl:');
    }
  } else {
    lines.push('# btpDestination:');
    lines.push('# mcpDestination:');
    if (answers.mcpUrl) {
      lines.push(`mcpUrl: "${answers.mcpUrl}"`);
    }
  }

  lines.push('');

  // Browser authentication
  lines.push('# Browser authentication');
  lines.push(`browser: "${answers.browser}"`);
  lines.push(`browserAuthPort: ${answers.browserAuthPort}`);

  lines.push('');

  // Session storage mode
  lines.push('# Session storage mode');
  lines.push(`unsafe: ${answers.unsafe}  # If true, persists tokens to disk`);

  lines.push('');

  // Error handling & resilience
  lines.push('# Error handling & resilience');
  lines.push(`maxRetries: ${answers.maxRetries ?? DEFAULTS.maxRetries}`);
  lines.push(
    `retryDelay: ${answers.retryDelay ?? DEFAULTS.retryDelay}  # milliseconds`,
  );
  lines.push(
    `requestTimeout: ${answers.requestTimeout ?? DEFAULTS.requestTimeout}  # milliseconds`,
  );
  lines.push(
    `circuitBreakerThreshold: ${answers.circuitBreakerThreshold ?? DEFAULTS.circuitBreakerThreshold}`,
  );
  lines.push(
    `circuitBreakerTimeout: ${answers.circuitBreakerTimeout ?? DEFAULTS.circuitBreakerTimeout}  # milliseconds`,
  );

  lines.push('');

  // Logging
  lines.push('# Logging');
  lines.push(`logLevel: "${answers.logLevel}"  # debug | info | warn | error`);

  // Cloud LLM Hub URL
  if (answers.cloudLlmHubUrl) {
    lines.push('');
    lines.push('# Cloud LLM Hub URL');
    lines.push(`cloudLlmHubUrl: "${answers.cloudLlmHubUrl}"`);
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Run the interactive configuration wizard
 * Stub — not yet implemented.
 */
export async function runWizard(): Promise<WizardAnswers> {
  throw new Error('Not implemented yet');
}
