/**
 * Configuration management for MCP ABAP ADT Proxy
 */

import * as fs from "fs";
import * as path from "path";

export interface ProxyConfig {
  cloudLlmHubUrl: string;
  httpPort: number;
  ssePort: number;
  httpHost: string;
  sseHost: string;
  logLevel: string;
  // Destination overrides from command line
  btpDestination?: string; // Overrides x-btp-destination header
  mcpDestination?: string; // Overrides x-mcp-destination header
  // Session storage mode
  unsafe?: boolean; // If true, use FileSessionStore (persists to disk). If false, use SafeSessionStore (in-memory).
  // Error handling & resilience
  maxRetries?: number;
  retryDelay?: number;
  requestTimeout?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;
}

/**
 * Load configuration from file if exists, otherwise from environment variables
 */
export function loadConfig(configPath?: string): ProxyConfig {
  // Try to load from config file first
  if (configPath || process.env.MCP_PROXY_CONFIG) {
    const filePath = configPath || process.env.MCP_PROXY_CONFIG;
    try {
      if (fs.existsSync(filePath!)) {
        const configContent = fs.readFileSync(filePath!, "utf-8");
        const fileConfig = JSON.parse(configContent);
        return mergeConfig(fileConfig, loadFromEnv());
      }
    } catch (error) {
      console.warn(`Failed to load config from file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Try default config file locations
  const defaultPaths = [
    path.join(process.cwd(), "mcp-proxy-config.json"),
    path.join(process.cwd(), ".mcp-proxy-config.json"),
    path.join(process.env.HOME || process.env.USERPROFILE || "", ".mcp-proxy-config.json"),
  ];

  for (const configPath of defaultPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, "utf-8");
        const fileConfig = JSON.parse(configContent);
        return mergeConfig(fileConfig, loadFromEnv());
      }
    } catch (error) {
      // Continue to next path
    }
  }

  // Fall back to environment variables only
  return loadFromEnv();
}

/**
 * Load configuration from environment variables and command line
 */
function loadFromEnv(): ProxyConfig {
  // Parse command line arguments for --btp, --mcp, and --unsafe
  const btpDestination = getArgValue("--btp");
  const mcpDestination = getArgValue("--mcp");
  const unsafe = hasArg("--unsafe") || process.env.MCP_PROXY_UNSAFE === "true";

  return {
    cloudLlmHubUrl: process.env.CLOUD_LLM_HUB_URL || "",
    httpPort: parseInt(process.env.MCP_HTTP_PORT || "3001", 10),
    ssePort: parseInt(process.env.MCP_SSE_PORT || "3002", 10),
    httpHost: process.env.MCP_HTTP_HOST || "0.0.0.0",
    sseHost: process.env.MCP_SSE_HOST || "0.0.0.0",
    logLevel: process.env.LOG_LEVEL || "info",
    btpDestination,
    mcpDestination,
    unsafe,
    maxRetries: parseInt(process.env.MCP_PROXY_MAX_RETRIES || "3", 10),
    retryDelay: parseInt(process.env.MCP_PROXY_RETRY_DELAY || "1000", 10),
    requestTimeout: parseInt(process.env.MCP_PROXY_REQUEST_TIMEOUT || "60000", 10),
    circuitBreakerThreshold: parseInt(process.env.MCP_PROXY_CIRCUIT_BREAKER_THRESHOLD || "5", 10),
    circuitBreakerTimeout: parseInt(process.env.MCP_PROXY_CIRCUIT_BREAKER_TIMEOUT || "60000", 10),
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
      return args[i].split("=")[1];
    }
  }
  return undefined;
}

/**
 * Check if argument exists in command line
 */
function hasArg(argName: string): boolean {
  const args = process.argv;
  return args.some(arg => arg === argName || arg.startsWith(`${argName}=`));
}

/**
 * Merge file config with environment config (env takes precedence)
 */
function mergeConfig(fileConfig: Partial<ProxyConfig>, envConfig: ProxyConfig): ProxyConfig {
  return {
    cloudLlmHubUrl: envConfig.cloudLlmHubUrl || fileConfig.cloudLlmHubUrl || "",
    httpPort: envConfig.httpPort || fileConfig.httpPort || 3001,
    ssePort: envConfig.ssePort || fileConfig.ssePort || 3002,
    httpHost: envConfig.httpHost || fileConfig.httpHost || "0.0.0.0",
    sseHost: envConfig.sseHost || fileConfig.sseHost || "0.0.0.0",
    logLevel: envConfig.logLevel || fileConfig.logLevel || "info",
    // Command line overrides take precedence
    btpDestination: envConfig.btpDestination ?? fileConfig.btpDestination,
    mcpDestination: envConfig.mcpDestination ?? fileConfig.mcpDestination,
    unsafe: envConfig.unsafe ?? fileConfig.unsafe ?? false,
    maxRetries: envConfig.maxRetries ?? fileConfig.maxRetries ?? 3,
    retryDelay: envConfig.retryDelay ?? fileConfig.retryDelay ?? 1000,
    requestTimeout: envConfig.requestTimeout ?? fileConfig.requestTimeout ?? 60000,
    circuitBreakerThreshold: envConfig.circuitBreakerThreshold ?? fileConfig.circuitBreakerThreshold ?? 5,
    circuitBreakerTimeout: envConfig.circuitBreakerTimeout ?? fileConfig.circuitBreakerTimeout ?? 60000,
  };
}

/**
 * Validate configuration
 */
export function validateConfig(config: ProxyConfig): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Cloud LLM Hub URL is only required if we're using proxy functionality
  // For direct cloud and basic auth, it's not needed
  if (!config.cloudLlmHubUrl) {
    warnings.push("CLOUD_LLM_HUB_URL is not set - proxy to cloud-llm-hub will not work");
  } else {
    try {
      new URL(config.cloudLlmHubUrl);
    } catch {
      errors.push("CLOUD_LLM_HUB_URL must be a valid URL");
    }
  }

  if (config.httpPort < 1 || config.httpPort > 65535) {
    errors.push("MCP_HTTP_PORT must be between 1 and 65535");
  }

  if (config.ssePort < 1 || config.ssePort > 65535) {
    errors.push("MCP_SSE_PORT must be between 1 and 65535");
  }

  if (config.httpPort === config.ssePort) {
    errors.push("MCP_HTTP_PORT and MCP_SSE_PORT must be different");
  }

  if (config.maxRetries && (config.maxRetries < 0 || config.maxRetries > 10)) {
    warnings.push("MCP_PROXY_MAX_RETRIES should be between 0 and 10");
  }

  if (config.retryDelay && (config.retryDelay < 0 || config.retryDelay > 60000)) {
    warnings.push("MCP_PROXY_RETRY_DELAY should be between 0 and 60000ms");
  }

  if (config.requestTimeout && (config.requestTimeout < 1000 || config.requestTimeout > 300000)) {
    warnings.push("MCP_PROXY_REQUEST_TIMEOUT should be between 1000 and 300000ms");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
