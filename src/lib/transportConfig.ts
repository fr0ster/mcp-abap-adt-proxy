/**
 * Transport Configuration - Parse and manage transport settings
 */

export type TransportType = 'stdio' | 'streamable-http' | 'sse';

export interface TransportConfig {
  type: TransportType;
  host?: string;
  port?: number;
  enableJsonResponse?: boolean;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  enableDnsRebindingProtection?: boolean;
}

/**
 * File-based config overrides for transport settings (from YAML/JSON config file)
 */
export interface FileTransportOverrides {
  transport?: string;
  httpPort?: number;
  httpHost?: string;
  ssePort?: number;
  sseHost?: string;
}

/**
 * Normalize transport value to TransportType
 */
function normalizeTransport(value: string): TransportType | null {
  const v = value.toLowerCase();
  if (v === 'stdio' || v === 'streamable-http' || v === 'http' || v === 'sse') {
    return v === 'http' ? 'streamable-http' : (v as TransportType);
  }
  return null;
}

/**
 * Parse transport configuration from command line arguments, environment variables,
 * and optional file-based config overrides.
 *
 * Priority: CLI args > file config > env vars > auto-detect > defaults
 */
export function parseTransportConfig(
  fileOverrides?: FileTransportOverrides,
): TransportConfig {
  const args = process.argv;

  // Check for explicit transport type from CLI
  let transportType: TransportType | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--transport=')) {
      transportType = normalizeTransport(arg.split('=')[1]);
    }
    if (arg === '--transport' && i + 1 < args.length) {
      transportType = normalizeTransport(args[i + 1]);
    }
    if (arg === '--http') transportType = 'streamable-http';
    if (arg === '--stdio') transportType = 'stdio';
    if (arg === '--sse') transportType = 'sse';
  }

  // Check file config overrides
  if (!transportType && fileOverrides?.transport) {
    transportType = normalizeTransport(fileOverrides.transport);
  }

  // Check environment variable
  if (!transportType && process.env.MCP_TRANSPORT) {
    transportType = normalizeTransport(process.env.MCP_TRANSPORT);
  }

  // Auto-detect stdio mode: if stdin is not a TTY, we're likely in stdio mode
  if (!transportType && !process.stdin.isTTY) {
    transportType = 'stdio';
  }

  // Default to streamable-http if not specified
  if (!transportType) {
    transportType = 'streamable-http';
  }

  // Parse SSE config
  if (transportType === 'sse') {
    const port = parseInt(
      getArgValue('--sse-port') ||
        (fileOverrides?.ssePort != null ? String(fileOverrides.ssePort) : '') ||
        process.env.MCP_SSE_PORT ||
        '3002',
      10,
    );
    const host =
      getArgValue('--sse-host') ||
      fileOverrides?.sseHost ||
      process.env.MCP_SSE_HOST ||
      '0.0.0.0';

    return {
      type: 'sse',
      host,
      port,
      allowedOrigins: parseListOption(
        '--sse-allowed-origins',
        'MCP_SSE_ALLOWED_ORIGINS',
      ),
      allowedHosts: parseListOption(
        '--sse-allowed-hosts',
        'MCP_SSE_ALLOWED_HOSTS',
      ),
      enableDnsRebindingProtection: parseBooleanOption(
        '--sse-enable-dns-protection',
        'MCP_SSE_ENABLE_DNS_PROTECTION',
        false,
      ),
    };
  }

  // Parse HTTP/streamable-http config
  if (transportType === 'streamable-http') {
    const port = parseInt(
      getArgValue('--http-port') ||
        (fileOverrides?.httpPort != null
          ? String(fileOverrides.httpPort)
          : '') ||
        process.env.MCP_HTTP_PORT ||
        '3001',
      10,
    );
    const host =
      getArgValue('--http-host') ||
      fileOverrides?.httpHost ||
      process.env.MCP_HTTP_HOST ||
      '0.0.0.0';

    return {
      type: 'streamable-http',
      host,
      port,
      enableJsonResponse: parseBooleanOption(
        '--http-json-response',
        'MCP_HTTP_ENABLE_JSON_RESPONSE',
        false,
      ),
      allowedOrigins: parseListOption(
        '--http-allowed-origins',
        'MCP_HTTP_ALLOWED_ORIGINS',
      ),
      allowedHosts: parseListOption(
        '--http-allowed-hosts',
        'MCP_HTTP_ALLOWED_HOSTS',
      ),
      enableDnsRebindingProtection: parseBooleanOption(
        '--http-enable-dns-protection',
        'MCP_HTTP_ENABLE_DNS_PROTECTION',
        false,
      ),
    };
  }

  // Stdio config (no additional options)
  return {
    type: 'stdio',
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
 * Parse boolean option from command line or environment
 */
function parseBooleanOption(
  argName: string,
  envName: string,
  defaultValue: boolean,
): boolean {
  const argValue = getArgValue(argName);
  if (argValue !== undefined) {
    return argValue.toLowerCase() === 'true' || argValue === '1';
  }
  const envValue = process.env[envName];
  if (envValue !== undefined) {
    return envValue.toLowerCase() === 'true' || envValue === '1';
  }
  return defaultValue;
}

/**
 * Parse list option from command line or environment
 */
function parseListOption(
  argName: string,
  envName: string,
): string[] | undefined {
  const argValue = getArgValue(argName);
  if (argValue) {
    return argValue
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const envValue = process.env[envName];
  if (envValue) {
    return envValue
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}
