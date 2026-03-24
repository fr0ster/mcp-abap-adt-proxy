/**
 * TUI wizard for interactive proxy configuration
 */

import * as fs from 'node:fs';
import { checkServiceKeyExists } from './serviceKeyCheck.js';

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
 * Print a service key check result to the console.
 */
function printServiceKeyCheck(destination: string): void {
  const result = checkServiceKeyExists(destination);
  if (result.found) {
    console.log(`  Found: ${result.path}`);
  } else {
    console.log(
      `  Warning: Service key file not found for "${destination}".`,
    );
    console.log(
      `  Searched: ${result.searchedPaths?.join(', ') ?? '(none)'}`,
    );
  }
}

/**
 * Run the interactive configuration wizard
 */
export async function runWizard(): Promise<WizardAnswers> {
  try {
    const { select, input, confirm, number } = await import(
      '@inquirer/prompts'
    );

    console.log('\n  MCP ABAP ADT Proxy — Configuration Wizard\n');

    // 1. Scenario
    const scenario = await select<'btp' | 'direct'>({
      message: 'Select scenario:',
      choices: [
        {
          name: 'BTP service (XSUAA auth via service key)',
          value: 'btp',
        },
        {
          name: 'Direct MCP server URL (no auth)',
          value: 'direct',
        },
      ],
    });

    const answers: Partial<WizardAnswers> = { scenario };

    // 2. Scenario-specific questions
    if (scenario === 'btp') {
      const btpDestination = await input({
        message: 'BTP destination name:',
        required: true,
      });
      answers.btpDestination = btpDestination;
      printServiceKeyCheck(btpDestination);

      const addMcpDest = await confirm({
        message:
          'Add MCP destination (for ABAP connection params on Cloud)?',
        default: false,
      });

      if (addMcpDest) {
        const mcpDestination = await input({
          message: 'MCP destination name:',
          required: true,
        });
        answers.mcpDestination = mcpDestination;
        printServiceKeyCheck(mcpDestination);
      }
    } else {
      const mcpUrl = await input({
        message: 'MCP server URL:',
        required: true,
      });
      answers.mcpUrl = mcpUrl;
    }

    // 3. Transport
    const transport = await select<'stdio' | 'http' | 'sse'>({
      message: 'Select transport:',
      choices: [
        { name: 'stdio', value: 'stdio' },
        { name: 'streamable-http', value: 'http' },
        { name: 'sse', value: 'sse' },
      ],
    });
    answers.transport = transport;

    // 4. Transport-specific settings
    if (transport !== 'stdio') {
      answers.httpHost = await input({
        message: 'HTTP host:',
        default: '0.0.0.0',
      });
      answers.httpPort = await number({
        message: 'HTTP port:',
        default: 3001,
        min: 1,
        max: 65535,
      });

      if (transport === 'sse') {
        answers.sseHost = await input({
          message: 'SSE host:',
          default: '0.0.0.0',
        });
        answers.ssePort = await number({
          message: 'SSE port:',
          default: 3002,
          min: 1,
          max: 65535,
        });
      }
    }

    // 5. Browser
    answers.browser = await select<WizardAnswers['browser']>({
      message: 'Select browser for OAuth2 login:',
      choices: [
        { name: 'system (default browser)', value: 'system' },
        { name: 'chrome', value: 'chrome' },
        { name: 'edge', value: 'edge' },
        { name: 'firefox', value: 'firefox' },
        { name: 'headless', value: 'headless' },
        { name: 'none (disable)', value: 'none' },
      ],
    });

    // 6. OAuth2 callback port
    answers.browserAuthPort = await number({
      message: 'OAuth2 callback port:',
      default: 3333,
    });

    // 7. Unsafe mode
    answers.unsafe = await confirm({
      message: 'Unsafe mode (persist tokens to disk)?',
      default: false,
    });

    // 8. Log level
    answers.logLevel = await select({
      message: 'Log level:',
      choices: [
        { name: 'debug', value: 'debug' },
        { name: 'info', value: 'info' },
        { name: 'warn', value: 'warn' },
        { name: 'error', value: 'error' },
      ],
      default: 'info',
    });

    // 9. Advanced settings
    const configureAdvanced = await confirm({
      message: 'Configure advanced settings?',
      default: false,
    });

    if (configureAdvanced) {
      answers.maxRetries = await number({
        message: 'Max retries:',
        default: DEFAULTS.maxRetries,
      });
      answers.retryDelay = await number({
        message: 'Retry delay (ms):',
        default: DEFAULTS.retryDelay,
      });
      answers.requestTimeout = await number({
        message: 'Request timeout (ms):',
        default: DEFAULTS.requestTimeout,
      });
      answers.circuitBreakerThreshold = await number({
        message: 'Circuit breaker threshold:',
        default: DEFAULTS.circuitBreakerThreshold,
      });
      answers.circuitBreakerTimeout = await number({
        message: 'Circuit breaker timeout (ms):',
        default: DEFAULTS.circuitBreakerTimeout,
      });

      const setCloudUrl = await confirm({
        message: 'Set Cloud LLM Hub URL?',
        default: false,
      });

      if (setCloudUrl) {
        answers.cloudLlmHubUrl = await input({
          message: 'Cloud LLM Hub URL:',
          required: true,
        });
      }
    }

    // 10. Output file
    const outputPath = await input({
      message: 'Output file path:',
      default: './mcp-proxy-config.yaml',
    });

    // Generate and write config
    const fullAnswers = answers as WizardAnswers;
    const yaml = generateConfigYaml(fullAnswers);
    fs.writeFileSync(outputPath, yaml, 'utf-8');

    console.log(`\nConfig saved to: ${outputPath}`);
    console.log(`Run with: mcp-abap-adt-proxy --config ${outputPath}`);

    return fullAnswers;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === 'ExitPromptError'
    ) {
      process.exit(0);
    }
    throw error;
  }
}
