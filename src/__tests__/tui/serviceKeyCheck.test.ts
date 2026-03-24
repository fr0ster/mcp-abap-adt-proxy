/**
 * Unit tests for serviceKeyCheck
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkServiceKeyExists } from '../../tui/serviceKeyCheck.js';
import { getPlatformPaths } from '../../lib/stores.js';

jest.mock('node:fs');
jest.mock('../../lib/stores.js', () => ({
  ...jest.requireActual('../../lib/stores.js'),
  getPlatformPaths: jest.fn(),
}));

const mockedFs = jest.mocked(fs);
const mockedGetPlatformPaths = jest.mocked(getPlatformPaths);

describe('serviceKeyCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('checkServiceKeyExists', () => {
    it('should return found path when service key exists in first directory', () => {
      const searchDirs = ['/home/user/.config/mcp-abap-adt/service-keys'];
      mockedGetPlatformPaths.mockReturnValue(searchDirs);
      const expectedPath = path.join(searchDirs[0], 'my-destination.json');
      mockedFs.existsSync.mockReturnValue(true);

      const result = checkServiceKeyExists('my-destination');

      expect(result.found).toBe(true);
      expect(result.path).toBe(expectedPath);
      expect(mockedGetPlatformPaths).toHaveBeenCalledWith('service-keys');
      expect(mockedFs.existsSync).toHaveBeenCalledWith(expectedPath);
    });

    it('should search multiple directories and return the first match', () => {
      const searchDirs = [
        '/home/user/.config/mcp-abap-adt/service-keys',
        '/home/user/projects',
      ];
      mockedGetPlatformPaths.mockReturnValue(searchDirs);
      mockedFs.existsSync.mockImplementation((filePath) => {
        return filePath === path.join(searchDirs[1], 'my-dest.json');
      });

      const result = checkServiceKeyExists('my-dest');

      expect(result.found).toBe(true);
      expect(result.path).toBe(path.join(searchDirs[1], 'my-dest.json'));
    });

    it('should return not found when service key does not exist in any directory', () => {
      const searchDirs = [
        '/home/user/.config/mcp-abap-adt/service-keys',
        '/home/user/projects',
      ];
      mockedGetPlatformPaths.mockReturnValue(searchDirs);
      mockedFs.existsSync.mockReturnValue(false);

      const result = checkServiceKeyExists('missing-dest');

      expect(result.found).toBe(false);
      expect(result.path).toBeUndefined();
      expect(result.searchedPaths).toEqual(searchDirs);
    });

    it('should return searched paths when key is not found', () => {
      const searchDirs = ['/dir1', '/dir2', '/dir3'];
      mockedGetPlatformPaths.mockReturnValue(searchDirs);
      mockedFs.existsSync.mockReturnValue(false);

      const result = checkServiceKeyExists('nonexistent');

      expect(result.found).toBe(false);
      expect(result.searchedPaths).toEqual(searchDirs);
      expect(mockedFs.existsSync).toHaveBeenCalledTimes(3);
    });

    it('should append .json extension to destination name', () => {
      const searchDirs = ['/some/path'];
      mockedGetPlatformPaths.mockReturnValue(searchDirs);
      mockedFs.existsSync.mockReturnValue(true);

      checkServiceKeyExists('my-btp-dest');

      expect(mockedFs.existsSync).toHaveBeenCalledWith(
        path.join('/some/path', 'my-btp-dest.json'),
      );
    });
  });
});
