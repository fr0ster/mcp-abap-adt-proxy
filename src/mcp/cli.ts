// src/mcp/cli.ts
import { loadConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { runMcpMode } from './server.js';

/**
 * What `bin/mcp-abap-adt-proxy-mcp.js` loads.
 *
 * Nothing but wiring: the bin parses `--help`/`--version` and then requires
 * this, in the same process, so the listeners the tools start die with the
 * session that asked for them.
 */
runMcpMode(loadConfig()).catch((error: unknown) => {
  logger?.error('MCP mode failed to start', {
    type: 'MCP_MODE_START_FAILED',
    error: error instanceof Error ? error.message : String(error),
  });
  process.stderr.write(
    `[MCP Proxy] ✗ ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
