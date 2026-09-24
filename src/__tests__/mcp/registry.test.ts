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
import { bootedAt, InstanceRegistry } from '../../mcp/registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proxy-registry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<Record<string, unknown>> = {}) => ({
  pid: process.pid,
  bootedAt: bootedAt(),
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

  it('prunes a record written before this boot, whose pid now belongs to someone else', () => {
    const registry = new InstanceRegistry(dir, () => true);
    // A pid is only unique within a boot. After a restart the number can belong
    // to an unrelated live process, and `process.kill(pid, 0)` says "alive"
    // forever — a ghost with no way to clear it but deleting the file by hand.
    writeFileSync(
      join(dir, '4242-4001.json'),
      JSON.stringify({ ...entry(), pid: 4242, bootedAt: 1 }),
    );

    expect(registry.live()).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('keeps a record from this boot', () => {
    const registry = new InstanceRegistry(dir, () => true);

    registry.record(entry() as never);

    expect(registry.live()).toHaveLength(1);
  });

  it('prunes a record with no boot time at all, being from an older version', () => {
    const registry = new InstanceRegistry(dir, () => true);
    const { bootedAt: _drop, ...old } = { ...entry(), bootedAt: undefined };
    writeFileSync(join(dir, '1-4001.json'), JSON.stringify(old));

    expect(registry.live()).toEqual([]);
  });

  it('leaves no half-written file for a reader to trip over', () => {
    const registry = new InstanceRegistry(dir, () => true);

    registry.record(entry() as never);

    // Written to a temp name and renamed: a reader either sees the whole record
    // or no file, never a truncated one.
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => !f.endsWith('.json'))).toEqual([]);
  });

  it('reports nothing, rather than throwing, when the directory does not exist yet', () => {
    const registry = new InstanceRegistry(join(dir, 'not-created'), () => true);

    expect(registry.live()).toEqual([]);
  });
});
