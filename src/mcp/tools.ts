// src/mcp/tools.ts
import { z } from 'zod';
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

export function createProxyTools(supervisor: ProxySupervisor): ProxyTool[] {
  return [
    {
      name: 'proxy_start',
      title: 'Start an authenticating proxy',
      description:
        'Start a local proxy that authenticates against a SAP BTP destination ' +
        'and forwards requests to it. Returns the URL to point a client at. ' +
        'The proxy takes a free port, so several may run at once without ' +
        `colliding. ${SHUTDOWN_REMINDER}`,
      inputSchema: {
        destination: z
          .string()
          .describe('BTP destination name, as its service key is filed'),
        targetUrl: z
          .string()
          .optional()
          .describe(
            'Override the target URL. Authentication still comes from the destination.',
          ),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Default headers added to every forwarded request. Client headers win.',
          ),
        idleTimeoutMs: z
          .number()
          .optional()
          .describe(
            `Stop the proxy after this long with no request. Defaults to ${DEFAULT_IDLE_TIMEOUT_MS} ms; 0 disables it. This is a backstop, not a substitute for proxy_stop.`,
          ),
      },
      handler: async (args) => {
        const started = await supervisor.start({
          destination: String(args.destination),
          targetUrl: args.targetUrl as string | undefined,
          headers: args.headers as Record<string, string> | undefined,
          idleTimeoutMs: args.idleTimeoutMs as number | undefined,
        });
        return text(
          [
            `Proxy running at ${started.url}`,
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
              (s) => `  ${s.url} (${s.destination}) — port ${s.port} released`,
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
              `  ${m.url} — ${m.destination} — instanceId ${m.instanceId}`,
            );
          }
          lines.push('', SHUTDOWN_REMINDER);
        } else {
          lines.push('This session has no proxies running.');
        }

        if (others.length > 0) {
          lines.push('', 'Started by another session (not yours to stop):');
          for (const o of others) {
            lines.push(`  ${o.url} — ${o.destination} — pid ${o.pid}`);
          }
        }
        return text(lines.join('\n'));
      },
    },
  ];
}
