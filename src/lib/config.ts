/**
 * Configuration management for MCP ABAP ADT Proxy
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export interface ProxyConfig {
  httpPort: number;
  ssePort: number;
  httpHost: string;
  sseHost: string;
  logLevel: string;
  // Destination overrides from command line
  btpDestination?: string; // Overrides x-btp-destination header

  // Session storage mode
  unsafe?: boolean; // If true, use XsuaaSessionStore (persists to disk). If false, use SafeXsuaaSessionStore (in-memory).
  // Error handling & resilience
  maxRetries?: number;
  retryDelay?: number;
  requestTimeout?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;
}

/**
 * Load configuration from file if --config is provided, otherwise from environment variables and command line
 * Supports both JSON and YAML formats
 *
 * IMPORTANT: YAML config and command line parameters are mutually exclusive:
 * - If --config is provided, load ONLY from that file
 * - If --config is NOT provided, load ONLY from command line parameters and environment variables
 */
export function loadConfig(configPath?: string): ProxyConfig {
  // Get config path from parameter or command line (--config/-c)
  // Do NOT use environment variable MCP_PROXY_CONFIG - only explicit --config parameter
  const finalConfigPath = configPath || getConfigPath();

  // If --config is provided, load ONLY from that file (no merge with command line params)
  if (finalConfigPath) {
    // Warn if other CLI parameters are also provided (they will be ignored)
    const conflictingParams = ['--btp', '--unsafe'].filter((param) =>
      hasArg(param),
    );

    if (conflictingParams.length > 0) {
      console.warn(
        `Warning: --config is specified, but the following CLI parameters will be ignored: ${conflictingParams.join(', ')}. ` +
          `Configuration will be loaded ONLY from ${finalConfigPath}. ` +
          `To use CLI parameters, do not specify --config.`,
      );
    }

    try {
      if (fs.existsSync(finalConfigPath)) {
        const fileConfig = loadConfigFile(finalConfigPath);
        // Apply defaults for missing values in file config
        return applyDefaults(fileConfig);
      } else {
        throw new Error(`Config file not found: ${finalConfigPath}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to load config from file ${finalConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // No --config provided: load ONLY from command line parameters and environment variables
  return loadFromEnv();
}

/**
 * Load configuration from file (supports JSON and YAML)
 */
function loadConfigFile(filePath: string): Partial<ProxyConfig> {
  const configContent = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(configContent) as Partial<ProxyConfig>;
  } else {
    return JSON.parse(configContent);
  }
}

/**
 * Apply default values to partial config (used when loading from file)
 */
function applyDefaults(fileConfig: Partial<ProxyConfig>): ProxyConfig {
  const result: ProxyConfig = {
    httpPort: fileConfig.httpPort ?? 3001,
    ssePort: fileConfig.ssePort ?? 3002,
    httpHost: fileConfig.httpHost || '0.0.0.0',
    sseHost: fileConfig.sseHost || '0.0.0.0',
    logLevel: fileConfig.logLevel || 'info',
    btpDestination: fileConfig.btpDestination,

    unsafe: fileConfig.unsafe ?? false,
    maxRetries: fileConfig.maxRetries ?? 3,
    retryDelay: fileConfig.retryDelay ?? 1000,
    requestTimeout: fileConfig.requestTimeout ?? 60000,
    circuitBreakerThreshold: fileConfig.circuitBreakerThreshold ?? 5,
    circuitBreakerTimeout: fileConfig.circuitBreakerTimeout ?? 60000,
  };

  return result;
}

/**
 * Load configuration from environment variables and command line
 */
function loadFromEnv(): ProxyConfig {
  // Parse command line arguments for --btp, --mcp-url, and --unsafe
  const btpDestination = getArgValue('--btp');

  const unsafe = hasArg('--unsafe') || process.env.MCP_PROXY_UNSAFE === 'true';

  return {
    httpPort: parseInt(process.env.MCP_HTTP_PORT || '3001', 10),
    ssePort: parseInt(process.env.MCP_SSE_PORT || '3002', 10),
    httpHost: process.env.MCP_HTTP_HOST || '0.0.0.0',
    sseHost: process.env.MCP_SSE_HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info',
    btpDestination,

    unsafe,
    maxRetries: parseInt(process.env.MCP_PROXY_MAX_RETRIES || '3', 10),
    retryDelay: parseInt(process.env.MCP_PROXY_RETRY_DELAY || '1000', 10),
    requestTimeout: parseInt(
      process.env.MCP_PROXY_REQUEST_TIMEOUT || '60000',
      10,
    ),
    circuitBreakerThreshold: parseInt(
      process.env.MCP_PROXY_CIRCUIT_BREAKER_THRESHOLD || '5',
      10,
    ),
    circuitBreakerTimeout: parseInt(
      process.env.MCP_PROXY_CIRCUIT_BREAKER_TIMEOUT || '60000',
      10,
    ),
  };
}

/**
 * Get argument value from command line
 */
function getArgValue(argName: string): string | undefined {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === argName && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i].startsWith(`${argName}=`)) {
      return args[i].split('=')[1];
    }
  }
  return undefined;
}

/**
 * Get config file path from command line (--config or -c)
 */
export function getConfigPath(): string | undefined {
  return getArgValue('--config') || getArgValue('-c');
}

/**
 * Check if argument exists in command line
 */
function hasArg(argName: string): boolean {
  const args = process.argv;
  return args.some((arg) => arg === argName || arg.startsWith(`${argName}=`));
}

/**
 * Validate configuration
 */
export function validateConfig(config: ProxyConfig): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // mcpUrl is required (either from yaml config via --config or --mcp-url parameter)

  // Check if BTP destination is provided
  const hasDestination = config.btpDestination;

  if (!hasDestination) {
    warnings.push(
      'No BTP destination provided (--btp). Proxy will not work unless requests include x-btp-destination header.',
    );
  }

  if (config.httpPort < 1 || config.httpPort > 65535) {
    errors.push('MCP_HTTP_PORT must be between 1 and 65535');
  }

  if (config.ssePort < 1 || config.ssePort > 65535) {
    errors.push('MCP_SSE_PORT must be between 1 and 65535');
  }

  if (config.httpPort === config.ssePort) {
    errors.push('MCP_HTTP_PORT and MCP_SSE_PORT must be different');
  }

  if (config.maxRetries && (config.maxRetries < 0 || config.maxRetries > 10)) {
    warnings.push('MCP_PROXY_MAX_RETRIES should be between 0 and 10');
  }

  if (
    config.retryDelay &&
    (config.retryDelay < 0 || config.retryDelay > 60000)
  ) {
    warnings.push('MCP_PROXY_RETRY_DELAY should be between 0 and 60000ms');
  }

  if (
    config.requestTimeout &&
    (config.requestTimeout < 1000 || config.requestTimeout > 300000)
  ) {
    warnings.push(
      'MCP_PROXY_REQUEST_TIMEOUT should be between 1000 and 300000ms',
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
