/**
 * The registry of live proxies, across sessions.
 *
 * A record on disk is a CLAIM, not a fact: the process that wrote it may be
 * gone. Every read therefore checks the process behind each record and deletes
 * the ones whose writer has died — otherwise a crashed session leaves a ghost
 * that makes `proxy_status` lie forever.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InstanceRegistry } from '../../mcp/registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proxy-registry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<Record<string, unknown>> = {}) => ({
  pid: process.pid,
  port: 4001,
  url: 'http://127.0.0.1:4001',
  destination: 'D1',
  startedAt: new Date('2026-09-23T10:00:00Z').toISOString(),
  ...over,
});

describe('InstanceRegistry', () => {
  it('lists back what it recorded', () => {
    const registry = new InstanceRegistry(dir);

    registry.record(entry() as never);

    expect(registry.live()).toEqual([
      expect.objectContaining({ pid: process.pid, port: 4001, destination: 'D1' }),
    ]);
  });

  it('prunes a record whose process is gone, and takes the file with it', () => {
    const registry = new InstanceRegistry(dir, (pid) => pid === process.pid);

    registry.record(entry() as never);
    registry.record(entry({ pid: 999999, port: 4002 }) as never);

    expect(registry.live().map((r) => r.port)).toEqual([4001]);
    // The claim is not merely hidden — it is removed, so it cannot come back.
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('keeps a record whose process is alive', () => {
    const registry = new InstanceRegistry(dir, () => true);

    registry.record(entry({ pid: 999999 }) as never);

    expect(registry.live()).toHaveLength(1);
  });

  it('forgets one record without touching the others', () => {
    const registry = new InstanceRegistry(dir, () => true);
    registry.record(entry() as never);
    registry.record(entry({ port: 4002 }) as never);

    registry.forget(4001);

    expect(registry.live().map((r) => r.port)).toEqual([4002]);
  });

  it('steps over a file it cannot read rather than failing the whole listing', () => {
    const registry = new InstanceRegistry(dir, () => true);
    registry.record(entry() as never);
    writeFileSync(join(dir, 'garbage.json'), 'not json at all');

    expect(registry.live().map((r) => r.port)).toEqual([4001]);
  });

  it('reports nothing, rather than throwing, when the directory does not exist yet', () => {
    const registry = new InstanceRegistry(join(dir, 'not-created'), () => true);

    expect(registry.live()).toEqual([]);
  });
});
