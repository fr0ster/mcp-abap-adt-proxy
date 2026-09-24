// src/mcp/environments.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { storeDir } from '../lib/stores.js';

/**
 * One environment: a `.env` beside the configs, holding one SAP system's
 * credentials.
 *
 * A config names the service to reach; an environment names the credentials to
 * reach it with. They are separate because several configs commonly point at one
 * system — four of the configs in practice all want `e19` — and one config can
 * be run against different systems.
 */
export interface EnvironmentEntry {
  /** The file name without its extension — what a client asks for. */
  name: string;
  file: string;
  /**
   * Which variables it defines. Names only, never values: this is read to help
   * a client choose, and a value here would be a credential in a tool result.
   */
  variables: string[];
}

/** Where the environments live, beside `proxy/` and `service-keys/`. */
export function environmentDir(): string {
  return storeDir('sessions');
}

/**
 * The environments on disk.
 *
 * One that cannot be read is still listed, with no variables beside it — hiding
 * it would make "no such environment" the answer for a file sitting right there.
 */
export function listEnvironments(
  dir: string = environmentDir(),
): EnvironmentEntry[] {
  if (!existsSync(dir)) return [];

  const entries: EnvironmentEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    // `.env` exactly: this leaves out `e19.env.template`, whose extension is
    // `.template`, along with notes and anything else kept in the folder.
    if (path.extname(name).toLowerCase() !== '.env') continue;
    const file = path.join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }

    const entry: EnvironmentEntry = {
      name: path.basename(name, '.env'),
      file,
      variables: [],
    };
    try {
      for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (match) entry.variables.push(match[1]);
      }
    } catch {
      // Listed with no variables. Whoever starts a proxy with it gets the real
      // failure, against a name the caller chose.
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * The file an environment name refers to.
 *
 * A name, never a path: `sessions/` sits beside `proxy/` and `service-keys/`,
 * and the value comes from a language model.
 */
export function resolveEnvironment(
  name: string,
  dir: string = environmentDir(),
): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(
      `Invalid environment name "${name}": it must be a name from ${dir}, not a path.`,
    );
  }

  const available = listEnvironments(dir);
  const found = available.find(
    (entry) => entry.name === name || path.basename(entry.file) === name,
  );
  if (found) return found.file;

  const known = available.map((entry) => entry.name).join(', ');
  throw new Error(
    known
      ? `No environment named "${name}" in ${dir}. Available: ${known}`
      : `No environments found in ${dir}.`,
  );
}
