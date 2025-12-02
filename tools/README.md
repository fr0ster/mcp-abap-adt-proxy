# Testing Tools

This directory contains utility scripts for testing and development.

## start-servers.js

Starts both `mcp-abap-adt` and `mcp-abap-adt-proxy` servers simultaneously for testing purposes.

### Usage

```bash
# Using npm script (from project root)
npm run test:servers

# Direct execution
node tools/start-servers.js

# With custom ports
node tools/start-servers.js --adt-port=3000 --proxy-port=3001

# With MCP URL for local testing
node tools/start-servers.js --mcp-url=http://localhost:3000/mcp

# With MCP destination (local testing without BTP)
node tools/start-servers.js --mcp=trial --mcp-url=http://localhost:3000/mcp

# With BTP destination
node tools/start-servers.js --btp=ai --mcp=trial

# With custom .env file for ADT server
node tools/start-servers.js --adt-env=./.env.test
```

### Options

- `--adt-port=<port>` - ADT server port (default: 3000)
- `--proxy-port=<port>` - Proxy server port (default: 3001)
- `--adt-host=<host>` - ADT server host (default: 0.0.0.0)
- `--proxy-host=<host>` - Proxy server host (default: 0.0.0.0)
- `--mcp-url=<url>` - MCP server URL for proxy (e.g., `http://localhost:3000/mcp`)
- `--mcp=<destination>` - MCP destination name for proxy
- `--btp=<destination>` - BTP destination name for proxy
- `--adt-env=<path>` - Path to .env file for ADT server
- `--proxy-unsafe` - Enable unsafe (file-based) session storage for proxy
- `--help, -h` - Show help message

### Examples

**Basic usage (default ports):**
```bash
npm run test:servers
```

**Local testing without BTP authentication:**
```bash
node tools/start-servers.js \
  --adt-port=3000 \
  --proxy-port=3001 \
  --mcp=trial \
  --mcp-url=http://localhost:3000/mcp
```

**With BTP authentication:**
```bash
node tools/start-servers.js \
  --btp=ai \
  --mcp=trial \
  --adt-port=3000 \
  --proxy-port=3001
```

**Custom configuration:**
```bash
node tools/start-servers.js \
  --adt-port=8080 \
  --proxy-port=8081 \
  --adt-host=127.0.0.1 \
  --proxy-host=127.0.0.1 \
  --mcp-url=http://127.0.0.1:8080/mcp \
  --adt-env=./.env.test \
  --proxy-unsafe
```

### Requirements

Both servers must be installed:
- `mcp-abap-adt` - can be installed globally: `npm install -g @mcp-abap-adt/server`
- `mcp-abap-adt-proxy` - can be installed globally: `npm install -g @mcp-abap-adt/proxy`

Or they should be available in `node_modules/.bin` if installed locally.

### Stopping Servers

Press `Ctrl+C` to stop both servers gracefully. The script will:
1. Send SIGTERM to both processes
2. Wait up to 5 seconds for graceful shutdown
3. Force kill if processes don't exit

### Output

The script prefixes all output with `[ADT]` or `[PROXY]` to distinguish between the two servers:

```
[ADT] Starting mcp-abap-adt on 0.0.0.0:3000...
[PROXY] Starting mcp-abap-adt-proxy on 0.0.0.0:3001...
```

