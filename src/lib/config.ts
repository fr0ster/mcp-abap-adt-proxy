/**
 * Configuration management for MCP ABAP ADT Proxy
 */

export interface ProxyConfig {
  cloudLlmHubUrl: string;
  httpPort: number;
  ssePort: number;
  httpHost: string;
  sseHost: string;
  logLevel: string;
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(): ProxyConfig {
  return {
    cloudLlmHubUrl: process.env.CLOUD_LLM_HUB_URL || '',
    httpPort: parseInt(process.env.MCP_HTTP_PORT || '3001', 10),
    ssePort: parseInt(process.env.MCP_SSE_PORT || '3002', 10),
    httpHost: process.env.MCP_HTTP_HOST || '0.0.0.0',
    sseHost: process.env.MCP_SSE_HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

/**
 * Validate configuration
 */
export function validateConfig(config: ProxyConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.cloudLlmHubUrl) {
    errors.push('CLOUD_LLM_HUB_URL is required');
  } else {
    try {
      new URL(config.cloudLlmHubUrl);
    } catch {
      errors.push('CLOUD_LLM_HUB_URL must be a valid URL');
    }
  }

  if (config.httpPort < 1 || config.httpPort > 65535) {
    errors.push('MCP_HTTP_PORT must be between 1 and 65535');
  }

  if (config.ssePort < 1 || config.ssePort > 65535) {
    errors.push('MCP_SSE_PORT must be between 1 and 65535');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

