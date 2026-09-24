// src/mcp/configs.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { loadRawConfigFile } from '../lib/config.js';
import { storeDir } from '../lib/stores.js';

const EXTENSIONS = ['.yaml', '.yml', '.json'];

export interface ProxyConfigEntry {
  /** The file name without its extension — what a client asks for. */
  name: string;
  file: string;
  /** From the config, when it could be read. Listing is best-effort. */
  destination?: string;
  targetUrl?: string;
}

/**
 * Where a user keeps proxy configs, beside the service keys and sessions the
 * rest of the toolchain already uses.
 */
export function proxyConfigDir(): string {
  return storeDir('proxy');
}

/**
 * The configs on disk.
 *
 * A file that cannot be parsed is still LISTED, with no destination beside it.
 * Hiding it would make "no such config" the error a user gets for a file
 * sitting right there in the directory they are looking at.
 */
export function listProxyConfigs(
  dir: string = proxyConfigDir(),
): ProxyConfigEntry[] {
  if (!existsSync(dir)) return [];

  const entries: ProxyConfigEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const extension = path.extname(name).toLowerCase();
    if (!EXTENSIONS.includes(extension)) continue;
    try {
      // `statSync` follows symlinks and throws on a dangling one, or on a file
      // removed between the readdir and here. One bad entry costs that entry.
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }

    const entry: ProxyConfigEntry = {
      name: path.basename(name, path.extname(name)),
      file,
    };
    try {
      const raw = loadRawConfigFile(file) as Record<string, unknown>;
      if (typeof raw?.btpDestination === 'string') {
        entry.destination = raw.btpDestination;
      }
      if (typeof raw?.targetUrl === 'string') entry.targetUrl = raw.targetUrl;
    } catch {
      // Listed without a destination. The failure belongs to whoever tries to
      // START it, where it can be reported against a name the user chose.
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * The file a name refers to.
 *
 * Accepts either the bare name or the file name as written. A name that would
 * leave the directory is refused rather than resolved: the value comes from a
 * language model, and `../sessions/nvcr.env` is a real path in a real
 * neighbouring folder full of credentials.
 */
export function resolveProxyConfig(
  name: string,
  dir: string = proxyConfigDir(),
): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(
      `Invalid proxy config name "${name}": it must be a name from ${dir}, not a path.`,
    );
  }

  const available = listProxyConfigs(dir);

  // An exact file name is never ambiguous, so it is tried first and wins.
  const exact = available.find((entry) => path.basename(entry.file) === name);
  if (exact) return exact.file;

  // A bare name can be answered by more than one file — `prod.yaml` and
  // `prod.json` are both "prod". Taking the first in sorted order would point
  // requests at a different destination than the caller meant and say nothing,
  // so it is refused with both names instead.
  const byName = available.filter((entry) => entry.name === name);
  if (byName.length > 1) {
    const files = byName.map((entry) => path.basename(entry.file)).join(', ');
    throw new Error(
      `Ambiguous proxy config name "${name}" in ${dir}: ${files}. Name the file exactly.`,
    );
  }
  if (byName.length === 1) return byName[0].file;

  const known = available.map((entry) => entry.name).join(', ');
  throw new Error(
    known
      ? `No proxy config named "${name}" in ${dir}. Available: ${known}`
      : `No proxy configs found in ${dir}.`,
  );
}

/** Read a config's own comment header, for a listing a human can recognise. */
export function describeConfig(entry: ProxyConfigEntry): string {
  try {
    const first = readFileSync(entry.file, 'utf-8')
      .split('\n')
      .find((line) => line.trimStart().startsWith('#'));
    return first ? first.replace(/^\s*#\s?/, '').trim() : '';
  } catch {
    return '';
  }
}
