# TUI Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interactive TUI wizard (`mcp-abap-adt-proxy tui`) that generates a YAML config file matching the existing `docs/mcp-proxy-config.example.yaml` format.

**Architecture:** New `src/tui/` module with wizard logic using `@inquirer/prompts`. The bin entry point intercepts the `tui` subcommand before spawning the server. Service key existence is checked via reuse of `getPlatformPaths()` from `src/lib/stores.ts`.

**Tech Stack:** `@inquirer/prompts` (TUI), `js-yaml` (already a dependency), TypeScript/ESM

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/tui/wizard.ts` | Create | Main wizard flow — questions, validation, YAML generation |
| `src/tui/serviceKeyCheck.ts` | Create | Check service key file existence using platform paths |
| `src/tui/index.ts` | Create | Public entry point — exports `runWizard()` |
| `bin/mcp-abap-adt-proxy.js` | Modify | Intercept `tui` subcommand before server spawn |
| `src/__tests__/tui/serviceKeyCheck.test.ts` | Create | Tests for service key checking |
| `src/__tests__/tui/wizard.test.ts` | Create | Tests for YAML generation logic |

---

### Task 1: Add `@inquirer/prompts` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependency**

```bash
npm install @inquirer/prompts
```

- [ ] **Step 2: Verify build still works**

```bash
npm run build:fast
```
Expected: successful compilation

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @inquirer/prompts for TUI wizard"
```

---

### Task 2: Service key existence checker

**Files:**
- Create: `src/tui/serviceKeyCheck.ts`
- Create: `src/__tests__/tui/serviceKeyCheck.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tui/serviceKeyCheck.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as fs from 'node:fs';

// Mock fs before importing module
jest.unstable_mockModule('node:fs', () => ({
  existsSync: jest.fn(),
}));

// Mock stores to control platform paths
jest.unstable_mockModule('../../lib/stores.js', () => ({
  getPlatformPaths: jest.fn(),
}));

const { checkServiceKeyExists } = await import('../../tui/serviceKeyCheck.js');
const { getPlatformPaths } = await import('../../lib/stores.js');
const mockedFs = await import('node:fs');

describe('checkServiceKeyExists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return found:true when service key file exists', () => {
    (getPlatformPaths as jest.MockedFunction<typeof getPlatformPaths>).mockReturnValue(['/home/user/.config/mcp-abap-adt/service-keys']);
    (mockedFs.existsSync as jest.MockedFunction<typeof mockedFs.existsSync>).mockReturnValue(true);

    const result = checkServiceKeyExists('my-destination');

    expect(result.found).toBe(true);
    expect(result.path).toBe('/home/user/.config/mcp-abap-adt/service-keys/my-destination.json');
  });

  it('should return found:false with searched paths when not found', () => {
    (getPlatformPaths as jest.MockedFunction<typeof getPlatformPaths>).mockReturnValue(['/path1', '/path2']);
    (mockedFs.existsSync as jest.MockedFunction<typeof mockedFs.existsSync>).mockReturnValue(false);

    const result = checkServiceKeyExists('missing');

    expect(result.found).toBe(false);
    expect(result.searchedPaths).toEqual([
      '/path1/missing.json',
      '/path2/missing.json',
    ]);
  });

  it('should return first found path when multiple paths exist', () => {
    (getPlatformPaths as jest.MockedFunction<typeof getPlatformPaths>).mockReturnValue(['/path1', '/path2']);
    (mockedFs.existsSync as jest.MockedFunction<typeof mockedFs.existsSync>)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const result = checkServiceKeyExists('dest');

    expect(result.found).toBe(true);
    expect(result.path).toBe('/path2/dest.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/__tests__/tui/serviceKeyCheck.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/tui/serviceKeyCheck.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPlatformPaths } from '../lib/stores.js';

export interface ServiceKeyCheckResult {
  found: boolean;
  path?: string;
  searchedPaths?: string[];
}

export function checkServiceKeyExists(destination: string): ServiceKeyCheckResult {
  const dirs = getPlatformPaths('service-keys');
  const searchedPaths: string[] = [];

  for (const dir of dirs) {
    const filePath = path.join(dir, `${destination}.json`);
    searchedPaths.push(filePath);
    if (fs.existsSync(filePath)) {
      return { found: true, path: filePath };
    }
  }

  return { found: false, searchedPaths };
}
```

- [ ] **Step 4: Create barrel export**

```typescript
// src/tui/index.ts
export { runWizard } from './wizard.js';
export { checkServiceKeyExists } from './serviceKeyCheck.js';
```

Note: `wizard.ts` doesn't exist yet — this will cause a compile error but the test can still run. Create a placeholder:

```typescript
// src/tui/wizard.ts (placeholder)
export async function runWizard(): Promise<void> {
  throw new Error('Not implemented');
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx jest src/__tests__/tui/serviceKeyCheck.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tui/ src/__tests__/tui/
git commit -m "feat(tui): add service key existence checker"
```

---

### Task 3: YAML generation logic

**Files:**
- Create: `src/__tests__/tui/wizard.test.ts`
- Modify: `src/tui/wizard.ts`

- [ ] **Step 1: Write the failing test for YAML generation**

```typescript
// src/__tests__/tui/wizard.test.ts
import { describe, it, expect } from '@jest/globals';
import { generateConfigYaml, type WizardAnswers } from '../../tui/wizard.js';

describe('generateConfigYaml', () => {
  it('should generate YAML for BTP scenario with all fields', () => {
    const answers: WizardAnswers = {
      scenario: 'btp',
      btpDestination: 'my-service',
      mcpDestination: 'mcp',
      transport: 'http',
      httpHost: '0.0.0.0',
      httpPort: 3001,
      browser: 'system',
      browserAuthPort: 3333,
      unsafe: false,
      logLevel: 'info',
    };

    const yaml = generateConfigYaml(answers);

    expect(yaml).toContain('btpDestination: "my-service"');
    expect(yaml).toContain('mcpDestination: "mcp"');
    expect(yaml).toContain('transport: http');
    expect(yaml).toContain('# mcpUrl:');
    expect(yaml).not.toContain('\nmcpUrl:');
  });

  it('should generate YAML for direct URL scenario', () => {
    const answers: WizardAnswers = {
      scenario: 'direct',
      mcpUrl: 'https://my-server.com/mcp',
      transport: 'stdio',
      browser: 'system',
      browserAuthPort: 3333,
      unsafe: false,
      logLevel: 'info',
    };

    const yaml = generateConfigYaml(answers);

    expect(yaml).toContain('mcpUrl: "https://my-server.com/mcp"');
    expect(yaml).toContain('# btpDestination:');
    expect(yaml).toContain('# mcpDestination:');
    expect(yaml).toContain('transport: stdio');
  });

  it('should include advanced settings when provided', () => {
    const answers: WizardAnswers = {
      scenario: 'btp',
      btpDestination: 'svc',
      transport: 'http',
      httpHost: '0.0.0.0',
      httpPort: 3001,
      browser: 'chrome',
      browserAuthPort: 4000,
      unsafe: true,
      logLevel: 'debug',
      maxRetries: 5,
      retryDelay: 2000,
      requestTimeout: 30000,
      circuitBreakerThreshold: 3,
      circuitBreakerTimeout: 30000,
      cloudLlmHubUrl: 'https://hub.example.com',
    };

    const yaml = generateConfigYaml(answers);

    expect(yaml).toContain('unsafe: true');
    expect(yaml).toContain('maxRetries: 5');
    expect(yaml).toContain('retryDelay: 2000');
    expect(yaml).toContain('requestTimeout: 30000');
    expect(yaml).toContain('circuitBreakerThreshold: 3');
    expect(yaml).toContain('circuitBreakerTimeout: 30000');
    expect(yaml).toContain('cloudLlmHubUrl: "https://hub.example.com"');
    expect(yaml).toContain('browser: chrome');
    expect(yaml).toContain('browserAuthPort: 4000');
    expect(yaml).toContain('logLevel: "debug"');
  });

  it('should include SSE config when transport is sse', () => {
    const answers: WizardAnswers = {
      scenario: 'btp',
      btpDestination: 'svc',
      transport: 'sse',
      httpHost: '0.0.0.0',
      httpPort: 3001,
      sseHost: '127.0.0.1',
      ssePort: 3002,
      browser: 'system',
      browserAuthPort: 3333,
      unsafe: false,
      logLevel: 'info',
    };

    const yaml = generateConfigYaml(answers);

    expect(yaml).toContain('ssePort: 3002');
    expect(yaml).toContain('sseHost: "127.0.0.1"');
  });

  it('should not include port/host for stdio transport', () => {
    const answers: WizardAnswers = {
      scenario: 'btp',
      btpDestination: 'svc',
      transport: 'stdio',
      browser: 'system',
      browserAuthPort: 3333,
      unsafe: false,
      logLevel: 'info',
    };

    const yaml = generateConfigYaml(answers);

    expect(yaml).toContain('transport: stdio');
    expect(yaml).not.toContain('httpPort:');
    expect(yaml).not.toContain('httpHost:');
    expect(yaml).not.toContain('ssePort:');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/__tests__/tui/wizard.test.ts
```
Expected: FAIL — `generateConfigYaml` not exported / not implemented

- [ ] **Step 3: Implement `generateConfigYaml` and `WizardAnswers` type**

Replace `src/tui/wizard.ts` placeholder with actual implementation. The function builds a YAML string matching the `docs/mcp-proxy-config.example.yaml` template format — with comment headers, commented-out unused fields, and active values.

```typescript
// src/tui/wizard.ts
export interface WizardAnswers {
  scenario: 'btp' | 'direct';
  btpDestination?: string;
  mcpDestination?: string;
  mcpUrl?: string;
  transport: 'stdio' | 'http' | 'sse';
  httpHost?: string;
  httpPort?: number;
  sseHost?: string;
  ssePort?: number;
  browser: 'system' | 'headless' | 'chrome' | 'edge' | 'firefox' | 'none';
  browserAuthPort: number;
  unsafe: boolean;
  logLevel: string;
  maxRetries?: number;
  retryDelay?: number;
  requestTimeout?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;
  cloudLlmHubUrl?: string;
}

export function generateConfigYaml(answers: WizardAnswers): string {
  const lines: string[] = [
    '# MCP ABAP ADT Proxy Configuration',
    '# Generated by: mcp-abap-adt-proxy tui',
    '',
    '# Transport configuration',
    `transport: ${answers.transport}`,
  ];

  if (answers.transport !== 'stdio') {
    lines.push(`httpPort: ${answers.httpPort ?? 3001}`);
    lines.push(`httpHost: "${answers.httpHost ?? '0.0.0.0'}"`);
  }

  if (answers.transport === 'sse') {
    lines.push(`ssePort: ${answers.ssePort ?? 3002}`);
    lines.push(`sseHost: "${answers.sseHost ?? '0.0.0.0'}"`);
  }

  lines.push('');
  lines.push('# Destination overrides');

  // BTP destination
  if (answers.scenario === 'btp' && answers.btpDestination) {
    lines.push(`btpDestination: "${answers.btpDestination}"`);
  } else {
    lines.push('# btpDestination: "btp"');
  }

  lines.push('');

  // MCP destination
  if (answers.scenario === 'btp' && answers.mcpDestination) {
    lines.push(`mcpDestination: "${answers.mcpDestination}"`);
  } else {
    lines.push('# mcpDestination: "mcp"');
  }

  lines.push('');

  // Direct MCP URL
  if (answers.scenario === 'direct' && answers.mcpUrl) {
    lines.push(`mcpUrl: "${answers.mcpUrl}"`);
  } else {
    lines.push('# mcpUrl: "https://your-mcp-server.com/mcp/stream/http"');
  }

  lines.push('');
  lines.push('# Authentication');
  lines.push(`browser: ${answers.browser}`);
  lines.push(`browserAuthPort: ${answers.browserAuthPort}`);

  lines.push('');
  lines.push('# Session storage mode');
  lines.push(`unsafe: ${answers.unsafe}`);

  lines.push('');
  lines.push('# Error handling & resilience');
  lines.push(`maxRetries: ${answers.maxRetries ?? 3}`);
  lines.push(`retryDelay: ${answers.retryDelay ?? 1000}`);
  lines.push(`requestTimeout: ${answers.requestTimeout ?? 60000}`);
  lines.push(`circuitBreakerThreshold: ${answers.circuitBreakerThreshold ?? 5}`);
  lines.push(`circuitBreakerTimeout: ${answers.circuitBreakerTimeout ?? 60000}`);

  lines.push('');
  lines.push('# Logging');
  lines.push(`logLevel: "${answers.logLevel}"`);

  if (answers.cloudLlmHubUrl) {
    lines.push('');
    lines.push('# Cloud LLM Hub URL');
    lines.push(`cloudLlmHubUrl: "${answers.cloudLlmHubUrl}"`);
  }

  lines.push('');
  return lines.join('\n');
}

export async function runWizard(): Promise<void> {
  throw new Error('Not implemented yet');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/__tests__/tui/wizard.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/wizard.ts src/__tests__/tui/wizard.test.ts
git commit -m "feat(tui): add YAML config generation from wizard answers"
```

---

### Task 4: Interactive wizard flow

**Files:**
- Modify: `src/tui/wizard.ts`

- [ ] **Step 1: Implement `runWizard()` with `@inquirer/prompts`**

Replace the placeholder `runWizard()` in `src/tui/wizard.ts` with the full interactive flow:

```typescript
import { select, input, confirm, number } from '@inquirer/prompts';
import * as fs from 'node:fs';
import { checkServiceKeyExists } from './serviceKeyCheck.js';

export async function runWizard(): Promise<void> {
  console.log('\n  MCP ABAP ADT Proxy — Configuration Wizard\n');

  const answers: Partial<WizardAnswers> = {};

  // 1. Scenario
  answers.scenario = await select({
    message: 'Usage scenario',
    choices: [
      { name: 'BTP service (XSUAA auth via service key)', value: 'btp' as const },
      { name: 'Direct MCP server URL (no auth)', value: 'direct' as const },
    ],
  });

  // 2. Scenario-specific
  if (answers.scenario === 'btp') {
    answers.btpDestination = await input({
      message: 'BTP destination name (service key name)',
      required: true,
    });

    const btpCheck = checkServiceKeyExists(answers.btpDestination);
    if (!btpCheck.found) {
      console.warn(`\n  Warning: Service key not found for "${answers.btpDestination}"`);
      console.warn(`  Searched: ${btpCheck.searchedPaths?.join(', ')}\n`);
    } else {
      console.log(`  Found: ${btpCheck.path}\n`);
    }

    const hasMcp = await confirm({
      message: 'Add MCP destination (for ABAP connection params on Cloud)?',
      default: false,
    });

    if (hasMcp) {
      answers.mcpDestination = await input({
        message: 'MCP destination name',
        required: true,
      });

      const mcpCheck = checkServiceKeyExists(answers.mcpDestination);
      if (!mcpCheck.found) {
        console.warn(`\n  Warning: Service key not found for "${answers.mcpDestination}"`);
        console.warn(`  Searched: ${mcpCheck.searchedPaths?.join(', ')}\n`);
      } else {
        console.log(`  Found: ${mcpCheck.path}\n`);
      }
    }
  } else {
    answers.mcpUrl = await input({
      message: 'MCP server URL',
      required: true,
    });
  }

  // 3. Transport
  answers.transport = await select({
    message: 'Transport',
    choices: [
      { name: 'stdio', value: 'stdio' as const },
      { name: 'streamable-http', value: 'http' as const },
      { name: 'sse', value: 'sse' as const },
    ],
  });

  // 4. Ports/hosts
  if (answers.transport !== 'stdio') {
    answers.httpHost = await input({ message: 'HTTP host', default: '0.0.0.0' });
    answers.httpPort = await number({ message: 'HTTP port', default: 3001, min: 1, max: 65535 });

    if (answers.transport === 'sse') {
      answers.sseHost = await input({ message: 'SSE host', default: '0.0.0.0' });
      answers.ssePort = await number({ message: 'SSE port', default: 3002, min: 1, max: 65535 });
    }
  }

  // 5. Browser
  answers.browser = await select({
    message: 'Browser for OAuth2 login',
    choices: [
      { name: 'system (default browser)', value: 'system' as const },
      { name: 'chrome', value: 'chrome' as const },
      { name: 'edge', value: 'edge' as const },
      { name: 'firefox', value: 'firefox' as const },
      { name: 'headless', value: 'headless' as const },
      { name: 'none (disable)', value: 'none' as const },
    ],
  });

  // 6. Browser auth port
  answers.browserAuthPort = await number({ message: 'OAuth2 callback port', default: 3333, min: 1, max: 65535 });

  // 7. Unsafe mode
  answers.unsafe = await confirm({ message: 'Unsafe mode (persist tokens to disk)?', default: false });

  // 8. Log level
  answers.logLevel = await select({
    message: 'Log level',
    choices: [
      { value: 'debug' },
      { value: 'info' },
      { value: 'warn' },
      { value: 'error' },
    ],
    default: 'info',
  });

  // 9. Advanced
  const advanced = await confirm({ message: 'Configure advanced settings?', default: false });
  if (advanced) {
    answers.maxRetries = await number({ message: 'Max retries', default: 3, min: 0, max: 10 });
    answers.retryDelay = await number({ message: 'Retry delay (ms)', default: 1000, min: 0, max: 60000 });
    answers.requestTimeout = await number({ message: 'Request timeout (ms)', default: 60000, min: 1000, max: 300000 });
    answers.circuitBreakerThreshold = await number({ message: 'Circuit breaker threshold', default: 5, min: 1, max: 100 });
    answers.circuitBreakerTimeout = await number({ message: 'Circuit breaker timeout (ms)', default: 60000, min: 1000, max: 300000 });

    const hasHub = await confirm({ message: 'Set Cloud LLM Hub URL?', default: false });
    if (hasHub) {
      answers.cloudLlmHubUrl = await input({ message: 'Cloud LLM Hub URL', required: true });
    }
  }

  // 10. Output
  const outputPath = await input({ message: 'Output file path', default: './mcp-proxy-config.yaml' });

  const yamlContent = generateConfigYaml(answers as WizardAnswers);
  fs.writeFileSync(outputPath, yamlContent, 'utf-8');
  console.log(`\n  Config saved to: ${outputPath}`);
  console.log(`  Run with: mcp-abap-adt-proxy --config ${outputPath}\n`);
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:fast
```
Expected: successful compilation

- [ ] **Step 3: Commit**

```bash
git add src/tui/wizard.ts
git commit -m "feat(tui): implement interactive wizard flow with @inquirer/prompts"
```

---

### Task 5: Wire up `tui` subcommand in bin entry point

**Files:**
- Modify: `bin/mcp-abap-adt-proxy.js`

- [ ] **Step 1: Add `tui` subcommand handling**

In `bin/mcp-abap-adt-proxy.js`, before the server spawn logic, add:

```javascript
// Handle 'tui' subcommand
if (process.argv[2] === 'tui') {
  import('../dist/tui/index.js').then(({ runWizard }) => {
    runWizard().catch((err) => {
      if (err.name !== 'ExitPromptError') {
        console.error('Wizard error:', err.message);
      }
      process.exit(1);
    });
  });
  return; // Don't spawn the server
}
```

Note: `ExitPromptError` is thrown by `@inquirer/prompts` when user presses Ctrl+C — handle gracefully.

- [ ] **Step 2: Build and test manually**

```bash
npm run build:fast
node bin/mcp-abap-adt-proxy.js tui
```
Expected: interactive wizard starts, Ctrl+C exits cleanly

- [ ] **Step 3: Commit**

```bash
git add bin/mcp-abap-adt-proxy.js
git commit -m "feat(tui): wire up tui subcommand in CLI entry point"
```

---

### Task 6: Run all tests and full build

- [ ] **Step 1: Full build with linting**

```bash
npm run build
```
Expected: PASS

- [ ] **Step 2: Run all tests**

```bash
npm test
```
Expected: all tests pass (existing + new)

- [ ] **Step 3: Manual end-to-end test**

```bash
node bin/mcp-abap-adt-proxy.js tui
```

Walk through wizard, generate YAML, then verify proxy starts with it:

```bash
node bin/mcp-abap-adt-proxy.js --config ./mcp-proxy-config.yaml --transport http
```

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "feat(tui): finalize wizard implementation"
```
