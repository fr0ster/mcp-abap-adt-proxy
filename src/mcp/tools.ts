// src/mcp/tools.ts
import { z } from 'zod';
import { loadConfig } from '../lib/config.js';
import {
  describeConfig,
  listProxyConfigs,
  proxyConfigDir,
  resolveProxyConfig,
} from './configs.js';
import { DEFAULT_IDLE_TIMEOUT_MS, type ProxySupervisor } from './supervisor.js';

/**
 * The thing the client has to keep being told.
 *
 * A running proxy holds a TCP port and a live credential for the destination.
 * The client here is a language model reading tool descriptions selectively,
 * so this appears in the description of `proxy_start`, in the text that comes
 * back with the URL, and in the server's own instructions. Three places for one
 * sentence is not redundancy — it is the difference between a reminder that is
 * read when the work starts and one that is read when the work finishes.
 */
export const SHUTDOWN_REMINDER =
  'When you are finished with this proxy, call proxy_stop. ' +
  'A running proxy holds a TCP port and a live credential for its destination ' +
  'until it is stopped or the session ends.';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
}

export interface ProxyTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const text = (body: string): ToolResult => ({
  content: [{ type: 'text', text: body }],
});

export function createProxyTools(
  supervisor: ProxySupervisor,
  configDir: string = proxyConfigDir(),
): ProxyTool[] {
  return [
    {
      name: 'proxy_configs',
      title: 'List the proxy configs available',
      description:
        'List the proxy configurations on this machine, by the name ' +
        'proxy_start takes. Each one already carries its destination, target ' +
        'URL, default headers and timeouts, so starting a proxy is choosing a ' +
        'name — not assembling settings. Call this first; the names cannot be ' +
        'guessed.',
      inputSchema: {},
      handler: async () => {
        const configs = listProxyConfigs(configDir);
        if (configs.length === 0) {
          return text(`No proxy configs found in ${configDir}.`);
        }
        return text(
          [
            `Proxy configs in ${configDir}:`,
            ...configs.map((c) => {
              const about = describeConfig(c);
              const where = c.destination
                ? ` — destination ${c.destination}`
                : '';
              return `  ${c.name}${where}${about ? `\n      ${about}` : ''}`;
            }),
            '',
            'Start one with proxy_start { "config": "<name>" }.',
          ].join('\n'),
        );
      },
    },

    {
      name: 'proxy_start',
      title: 'Start an authenticating proxy',
      description:
        'Start a local proxy from one of the configs proxy_configs lists. The ' +
        'config supplies the destination, target URL, default headers and ' +
        'timeouts — including any credentials, which stay in the config and ' +
        'are never passed through here. The port is NOT taken from the config: ' +
        'a free one is bound instead, so several proxies can run at once, and ' +
        `the URL that comes back is the one actually bound. ${SHUTDOWN_REMINDER}`,
      inputSchema: {
        config: z
          .string()
          .describe(
            'Name of a proxy config, as proxy_configs lists it (for example "nvcr_d24").',
          ),
        idleTimeoutMs: z
          .number()
          .optional()
          .describe(
            `Stop the proxy after this long with no request. Defaults to ${DEFAULT_IDLE_TIMEOUT_MS} ms; 0 disables it. This is a backstop, not a substitute for proxy_stop.`,
          ),
      },
      handler: async (args) => {
        const name = String(args.config);
        const file = resolveProxyConfig(name, configDir);
        const started = await supervisor.start({
          name,
          config: loadConfig(file),
          idleTimeoutMs: args.idleTimeoutMs as number | undefined,
        });
        return text(
          [
            `Proxy running at ${started.url}`,
            `  config:      ${started.name}`,
            `  instanceId:  ${started.instanceId}`,
            `  destination: ${started.destination}`,
            '',
            SHUTDOWN_REMINDER,
          ].join('\n'),
        );
      },
    },

    {
      name: 'proxy_stop',
      title: 'Stop a proxy this session started',
      description:
        'Stop a proxy started in this session, freeing its port and releasing ' +
        'its credential. With no instanceId, stops every proxy this session ' +
        'started. Proxies belonging to other sessions are never touched — ' +
        'proxy_status shows them, and they are theirs to stop.',
      inputSchema: {
        instanceId: z
          .string()
          .optional()
          .describe('Which proxy to stop. Omit to stop all of this session’s.'),
      },
      handler: async (args) => {
        const stopped = await supervisor.stop(
          args.instanceId as string | undefined,
        );
        if (stopped.length === 0) {
          return text(
            args.instanceId
              ? `Nothing stopped: this session does not own a proxy with instanceId ${args.instanceId}. Use proxy_status to see what is running.`
              : 'Nothing stopped: this session has no proxies running.',
          );
        }
        return text(
          [
            `Stopped ${stopped.length} ${stopped.length === 1 ? 'proxy' : 'proxies'}:`,
            ...stopped.map(
              (s) => `  ${s.url} — config ${s.name} — port ${s.port} released`,
            ),
          ].join('\n'),
        );
      },
    },

    {
      name: 'proxy_status',
      title: 'List running proxies',
      description:
        'List the proxies this session started, and any started by other ' +
        'sessions on this machine. Records whose process has died are pruned ' +
        'when this is read, so what it reports is what is actually running.',
      inputSchema: {},
      handler: async () => {
        const mine = supervisor.mine();
        const others = supervisor.others();

        if (mine.length === 0 && others.length === 0) {
          return text('No proxies are running on this machine.');
        }

        const lines: string[] = [];
        if (mine.length > 0) {
          lines.push('Started by this session:');
          for (const m of mine) {
            lines.push(
              `  ${m.url} — config ${m.name} (destination ${m.destination}) — instanceId ${m.instanceId}`,
            );
          }
          lines.push('', SHUTDOWN_REMINDER);
        } else {
          lines.push('This session has no proxies running.');
        }

        if (others.length > 0) {
          lines.push('', 'Started by another session (not yours to stop):');
          for (const o of others) {
            lines.push(
              `  ${o.url} — config ${o.config} (destination ${o.destination}) — pid ${o.pid}`,
            );
          }
        }
        return text(lines.join('\n'));
      },
    },
  ];
}
