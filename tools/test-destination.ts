#!/usr/bin/env node

/**
 * Verify a BTP destination the way the proxy uses it: its service key is
 * found, a token is obtained (from the stored session, a refresh, or a login
 * in the browser) and the target URL resolves.
 *
 * It goes through `BtpProxy` itself rather than wiring its own broker, so what
 * it checks is the proxy's path and not a copy of it. No token is printed —
 * only its length.
 *
 * Usage:
 *   npm run test-destination -- <destination> [--target-url <url>] [--browser <browser>]
 */

import { BtpProxy } from '../src/proxy/btpProxy.js';

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const destination = args[0];
  if (!destination || destination.startsWith('--')) {
    process.stderr.write(
      'Usage: npm run test-destination -- <destination> [--target-url <url>] [--browser <browser>]\n',
    );
    process.exit(1);
  }

  const targetUrl = argValue(args, '--target-url');
  const browser = argValue(args, '--browser') as
    | 'system'
    | 'headless'
    | 'chrome'
    | 'edge'
    | 'firefox'
    | 'none'
    | undefined;

  const proxy = await BtpProxy.create({
    btpDestination: destination,
    ...(targetUrl ? { targetUrl } : {}),
    ...(browser ? { browser } : {}),
  });

  say(`Destination: ${destination}`);
  try {
    const header = await proxy.getAuthorizationHeader(destination);
    say(
      header
        ? `Authorization header obtained (${header.length} chars)`
        : 'The credential is not a header (null)',
    );
    say(`Target URL: ${await proxy.getTargetUrl(destination)}`);
  } finally {
    proxy.dispose();
  }
}

main().catch((error) => {
  process.stderr.write(
    `Failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
