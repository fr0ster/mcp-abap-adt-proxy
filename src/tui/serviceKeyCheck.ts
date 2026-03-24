/**
 * Service key existence checker
 * Checks if a service key file exists for a given BTP destination
 * by searching platform-specific directories.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPlatformPaths } from '../lib/stores.js';

/**
 * Result of a service key existence check
 */
export interface ServiceKeyCheckResult {
  /** Whether the service key file was found */
  found: boolean;
  /** Absolute path to the found service key file (if found) */
  path?: string;
  /** Directories that were searched (when not found) */
  searchedPaths?: string[];
}

/**
 * Check if a service key file exists for the given BTP destination.
 * Searches all platform-specific directories returned by getPlatformPaths('service-keys').
 *
 * @param destination - BTP destination name (without .json extension)
 * @returns ServiceKeyCheckResult indicating whether the key was found and where
 */
export function checkServiceKeyExists(
  destination: string,
): ServiceKeyCheckResult {
  const searchDirs = getPlatformPaths('service-keys');
  const fileName = `${destination}.json`;

  for (const dir of searchDirs) {
    const filePath = path.join(dir, fileName);
    if (fs.existsSync(filePath)) {
      return { found: true, path: filePath };
    }
  }

  return { found: false, searchedPaths: searchDirs };
}
