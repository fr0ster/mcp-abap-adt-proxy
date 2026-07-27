# Launcher Signal Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `mcp-abap-adt-proxy` from leaving an orphaned server process that holds the HTTP port and the OAuth callback port after the launcher is killed.

**Architecture:** `bin/mcp-abap-adt-proxy.js` currently spawns `dist/index.js` as a child process and forwards only SIGINT, so SIGTERM kills the launcher and orphans the server. The server already has a correct SIGINT/SIGTERM shutdown handler that releases every port — it just never receives the signal. Removing the spawn and loading the server in-process makes signals reach the existing handler, and removes the possibility of an orphan entirely.

**Tech Stack:** Node.js (CommonJS bin, `package.json` has no `type` field), TypeScript compiled to `dist/`, Jest with ts-jest, Biome.

## Global Constraints

- The spec for this work is `docs/superpowers/specs/2026-07-26-orphaned-server-and-callback-port-design.md`. This plan implements **change #1 and the SIGHUP addition only**.
- Change #2 (`CallbackServer` in `@mcp-abap-adt/auth-providers`) is **out of scope for this repository** — it lives in another package with its own release cycle and needs its own plan there. Do not vendor, link, or patch `node_modules/@mcp-abap-adt/auth-providers` in this repo.
- `bin/mcp-abap-adt-proxy.js` is CommonJS and must stay CommonJS — it is the published `bin` entry.
- Keep `--help` and `--version` handled in the bin, before the server is loaded. `src/__tests__/bin/entrypoint.test.ts` asserts their exact output and must keep passing.
- Do not change `engines.node` in this plan. The `>=18.2.0` raise belongs to the `auth-providers` release (change #2).
- Tests that exercise the built binary require `npm run build` first. Gate them so a clean checkout without `dist/` skips rather than fails.

---

### Task 1: Remove the launcher's child process

**Files:**
- Create: `src/__tests__/bin/signalHandling.test.ts`
- Modify: `bin/mcp-abap-adt-proxy.js:147-223`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the test helpers `portIsFree(port: number): Promise<boolean>`, `waitFor(fn: () => Promise<boolean>, timeoutMs?: number): Promise<boolean>`, `descendantsOf(pid: number): number[]` and `isAlive(pid: number): boolean`, all defined inside `signalHandling.test.ts` and reused by Task 2.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/bin/signalHandling.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const bin = path.resolve(__dirname, '../../../bin/mcp-abap-adt-proxy.js');
const dist = path.resolve(__dirname, '../../../dist/index.js');

// These tests drive the built binary. Without dist/ there is nothing to test.
const describeBuilt = fs.existsSync(dist) ? describe : describe.skip;

const HTTP_PORT = 3099;
const CALLBACK_PORT = 7899;

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 20000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Descendants must be collected BEFORE the parent dies: an orphan is
// re-parented to init/systemd, so afterwards it is no longer reachable
// by walking down from the launcher pid.
function descendantsOf(pid: number): number[] {
  const out = execFileSync('ps', ['-eo', 'pid,ppid'], { encoding: 'utf-8' });
  const byParent = new Map<number, number[]>();
  for (const line of out.trim().split('\n').slice(1)) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(p) || !Number.isFinite(pp)) continue;
    if (!byParent.has(pp)) byParent.set(pp, []);
    byParent.get(pp)?.push(p);
  }
  const found: number[] = [];
  const stack = [pid];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    for (const child of byParent.get(cur) ?? []) {
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

// A destination whose UAA host is never contacted: with browser 'none' the
// proxy binds the callback port, prints the URL and waits. That is a stable
// "up and holding ports" state, reachable with no network and no real key.
function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-signals-'));
  fs.mkdirSync(path.join(dir, 'service-keys'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'service-keys', 'signaltest.json'),
    JSON.stringify({
      credentials: {
        url: 'http://127.0.0.1:9',
        clientid: 'test-client',
        clientsecret: 'test-secret',
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    [
      'transport: http',
      `httpPort: ${HTTP_PORT}`,
      'httpHost: "127.0.0.1"',
      'btpDestination: "signaltest"',
      'targetUrl: "http://127.0.0.1:9"',
      'browser: "none"',
      `browserAuthPort: ${CALLBACK_PORT}`,
      'logLevel: "info"',
      '',
    ].join('\n'),
  );
  return dir;
}

describeBuilt('bin signal handling', () => {
  let dir: string;
  let child: ChildProcess | undefined;

  beforeAll(() => {
    dir = makeFixture();
  });

  afterEach(() => {
    // Belt and braces: never leave a test server behind holding a port.
    if (child?.pid && isAlive(child.pid)) {
      for (const pid of descendantsOf(child.pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    child = undefined;
  });

  it('SIGTERM releases the callback port and leaves no surviving process', async () => {
    child = spawn('node', [bin, '--config', path.join(dir, 'config.yaml')], {
      env: { ...process.env, AUTH_BROKER_PATH: dir },
      stdio: 'ignore',
    });
    const launcherPid = child.pid as number;

    const bound = await waitFor(async () => !(await portIsFree(CALLBACK_PORT)));
    expect(bound).toBe(true);

    const before = descendantsOf(launcherPid);

    const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    process.kill(launcherPid, 'SIGTERM');
    await exited;

    const released = await waitFor(() => portIsFree(CALLBACK_PORT), 10000);
    expect(released).toBe(true);
    expect(before.filter(isAlive)).toEqual([]);
  }, 60000);
});
```

- [ ] **Step 2: Build, then run the test to verify it fails**

Run:
```bash
npm run build && npx jest src/__tests__/bin/signalHandling.test.ts -v
```
Expected: FAIL. `expect(released).toBe(true)` receives `false`, and `before.filter(isAlive)` returns one pid — the orphaned `dist/index.js` still holding port 7899.

If the suite reports as skipped instead, `dist/index.js` is missing: run `npm run build` on its own and retry.

- [ ] **Step 3: Replace the spawn with an in-process load**

In `bin/mcp-abap-adt-proxy.js`, replace everything from the `// Pass all arguments to server` comment (line 161) through the end of `main()` (line 223) with:

```js
  // The server is loaded in this process, not spawned as a child. A child
  // would be orphaned by any signal the launcher does not forward — SIGTERM
  // from `kill`/`pkill`, SIGHUP from a closing terminal, or an MCP client
  // stopping the server — and would keep holding the HTTP and OAuth callback
  // ports. In-process, signals reach the server's own handler directly.
  require(serverPath);
}
```

Delete, as part of the same edit:
- the `const { spawn } = require('child_process');` import on line 16 — nothing else uses it;
- the second `fs.existsSync(resolvedServerPath)` block (lines 166-175), which duplicates the check on lines 150-159;
- the now-unused `serverArgs`, `nodeExecPath`, `resolvedServerPath` and `serverEnv` bindings;
- the Windows-only spawn debug logging (lines 182-185).

Keep the `--help` / `--version` handling and the first `fs.existsSync(serverPath)` check exactly as they are — the message about running `npm run build` is the one a user sees on a broken install.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm run build && npx jest src/__tests__/bin/signalHandling.test.ts -v
```
Expected: PASS. The port is released and `before` is now an empty array, because the launcher no longer has any child.

- [ ] **Step 5: Verify the existing bin tests still pass**

Run:
```bash
npx jest src/__tests__/bin/ -v
```
Expected: PASS, including `--version prints a semver without crashing` and `--help renders ${VAR} placeholders literally`. Both run the bin as a subprocess and exit before the server loads, so the change must not affect them. If `--help` now prints the server's help instead of the launcher's, the `--help` early-exit was removed by mistake — restore it.

- [ ] **Step 6: Run the full suite and the linter**

Run:
```bash
npm test && npm run lint:check
```
Expected: PASS on both. Biome flags unused bindings, so a leftover `spawn` or `serverEnv` fails here rather than in review.

- [ ] **Step 7: Commit**

```bash
git add bin/mcp-abap-adt-proxy.js src/__tests__/bin/signalHandling.test.ts
git commit -m "fix: run server in-process so SIGTERM releases ports instead of orphaning it

The bin spawned dist/index.js and forwarded only SIGINT. SIGTERM killed the
launcher and left the server running, re-parented to init, holding the HTTP
port and the OAuth callback port until it was killed by hand. The server
already handles SIGTERM correctly; it just never received it."
```

---

### Task 2: Shut down cleanly on SIGHUP

**Files:**
- Modify: `src/index.ts:896-897`
- Test: `src/__tests__/bin/signalHandling.test.ts`

**Interfaces:**
- Consumes: `portIsFree`, `waitFor`, `isAlive`, `descendantsOf` and `makeFixture` from Task 1's test file.
- Produces: nothing consumed by later tasks.

**What this buys — corrected after measurement.** This paragraph originally claimed that SIGHUP already terminates the process, so the task only bought tidiness. That is wrong during an in-flight login, and the correction matters.

`node_modules/@mcp-abap-adt/auth-providers/dist/auth/browserAuth.js:275` registers `process.once('SIGHUP', cleanup)` while the OAuth callback server is listening. Registering any listener for a signal suppresses Node's default action for it. So during a login, SIGHUP does **not** kill the proxy: the browserAuth cleanup runs, the process stays alive, and it lingers until the 30-second authentication timeout exits it with code 1 — still holding its ports for that whole window. Closing a terminal mid-login therefore leaves a proxy running for another half minute.

With this task's handler registered, SIGHUP runs the same graceful shutdown as SIGINT and SIGTERM and the process exits promptly with code 0. That is a real port-release improvement in the login window, not only a tidier exit.

That difference is observable in how the process ends, which is what the test asserts. Killed by the default action, a process reports `code: null, signal: 'SIGHUP'`; run through `onSignal`, it reports `code: 0, signal: null` because the handler ends with `process.exit(0)`. Asserting on the exit status rather than on a log line keeps the test independent of where the logger happens to write.

- [ ] **Step 1: Write the failing test**

Append inside the `describeBuilt('bin signal handling', ...)` block in `src/__tests__/bin/signalHandling.test.ts`:

```ts
  it('SIGHUP shuts down gracefully rather than dropping the process', async () => {
    child = spawn('node', [bin, '--config', path.join(dir, 'config.yaml')], {
      env: { ...process.env, AUTH_BROKER_PATH: dir },
      stdio: 'ignore',
    });
    const launcherPid = child.pid as number;

    const bound = await waitFor(async () => !(await portIsFree(CALLBACK_PORT)));
    expect(bound).toBe(true);

    const ended = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child?.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    process.kill(launcherPid, 'SIGHUP');
    const { code, signal } = await ended;

    // Graceful: the handler ran and exited deliberately.
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(await portIsFree(CALLBACK_PORT)).toBe(true);
  }, 60000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm run build && npx jest src/__tests__/bin/signalHandling.test.ts -t 'SIGHUP' -v
```
Expected: FAIL with `expect(signal).toBeNull()` receiving `'SIGHUP'` — the process is killed by the default action without ever running `onSignal`. Note the port assertion on its own would already pass, since a dead process releases its ports either way; the exit status is what distinguishes graceful shutdown from being dropped.

- [ ] **Step 3: Register the handler**

In `src/index.ts`, extend the signal registration at lines 896-897:

```ts
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // A closing terminal should release the OAuth callback port and the HTTP
  // listener the same way an explicit stop does.
  process.on('SIGHUP', onSignal);
```

`onSignal` is already idempotent via its `shuttingDown` flag, so a terminal that delivers SIGHUP followed by SIGTERM still shuts down once.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm run build && npx jest src/__tests__/bin/signalHandling.test.ts -v
```
Expected: PASS, both the SIGTERM and the SIGHUP test.

- [ ] **Step 5: Run the full suite and the linter**

Run:
```bash
npm test && npm run lint:check
```
Expected: PASS on both.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/__tests__/bin/signalHandling.test.ts
git commit -m "fix: shut down gracefully on SIGHUP

A closing terminal previously dropped the process on the default SIGHUP
action, skipping the shutdown path that closes the MCP server and the HTTP
listener."
```

---

### Task 3: Document the process model

**Files:**
- Modify: `CLAUDE.md` — the "Key Components" list under "Architecture"

**Interfaces:**
- Consumes: the behaviour established in Tasks 1 and 2.
- Produces: nothing.

- [ ] **Step 1: Add the bin to the component list**

In `CLAUDE.md`, under `### Key Components`, add as the first entry:

```markdown
- **bin/mcp-abap-adt-proxy.js** - CLI entry point. Handles `--help`/`--version`, then loads `dist/index.js` **in-process** (`require`, not `spawn`). It must stay that way: a spawned child is orphaned by any signal the launcher does not forward and keeps holding the HTTP and OAuth callback ports.
```

- [ ] **Step 2: Verify the file still reads correctly**

Run:
```bash
git diff CLAUDE.md
```
Expected: one added bullet, no other changes.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record that the bin loads the server in-process"
```

---

## After this plan

Change #2 from the spec — the single-owner `CallbackServer` in `@mcp-abap-adt/auth-providers` — still stands. It needs its own plan in that repository, and follows the cross-package order: issue, branch, PR with unit tests, publish, then bump the dependency here. It fixes a leak that survives inside a *living* proxy process (`/callback` without a `code`, and the 100 ms window after a failed exchange); this plan fixes the leak that survives the proxy being *stopped*. Neither substitutes for the other.

Once this plan and change #2 are both merged, delete this file and the spec — per `CLAUDE.md`, these directories hold only work in progress.
