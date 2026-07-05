import { mocked } from 'jest-mock';
import type { IModuleState } from '../../../lib/loading/ModuleStateBuilder';
import { ModuleStateCache } from '../../../lib/loading/ModuleStateCache';

const fs = require('node:fs').promises;

// eslint-disable-next-line jest/no-untyped-mock-factory
jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    rename: jest.fn(),
  },
}));

describe('ModuleStateCache', () => {
  let logger: any;
  let files: Record<string, { mtimeMs: number; size: number }>;
  let fileContents: Record<string, string>;
  let written: Record<string, string>;
  let moduleState: IModuleState;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = { info: jest.fn(), warn: jest.fn() };
    files = {
      '/main/package.json': { mtimeMs: 1_000, size: 10 },
      '/main/yarn.lock': { mtimeMs: 2_000, size: 20 },
      '/main/node_modules': { mtimeMs: 3_000, size: 30 },
    };
    fileContents = {};
    written = {};
    moduleState = <any> {
      mainModulePath: '/main',
      nodeModulePaths: [ '/main' ],
      packageJsons: { '/main': { name: 'main' }},
    };
    mocked(fs.stat).mockImplementation(<any> (async(path: string) => {
      if (!(path in files)) {
        throw new Error(`File stat not found: ${path}`);
      }
      return files[path];
    }));
    mocked(fs.readFile).mockImplementation(<any> (async(path: string) => {
      if (!(path in fileContents)) {
        throw new Error(`File not found: ${path}`);
      }
      return fileContents[path];
    }));
    mocked(fs.writeFile).mockImplementation(<any> (async(path: string, contents: string) => {
      written[path] = contents;
    }));
    mocked(fs.rename).mockImplementation(<any> (async(from: string, to: string) => {
      fileContents[to] = written[from];
      delete written[from];
    }));
  });

  function createCache(withLogger = true): ModuleStateCache {
    return new ModuleStateCache({
      path: '/tmp/cache.json',
      mainModulePath: '/main',
      logger: withLogger ? logger : undefined,
    });
  }

  describe('fingerprint', () => {
    it('should include present and absent fingerprint files', async() => {
      const fingerprint = JSON.parse(await createCache().fingerprint());
      const entries = Object.fromEntries(fingerprint[3].map((entry: any[]) => [ entry[0], entry.slice(1) ]));
      expect(entries['package.json']).toEqual([ 1_000, 10 ]);
      expect(entries['yarn.lock']).toEqual([ 2_000, 20 ]);
      expect(entries.node_modules).toEqual([ 3_000, 30 ]);
      expect(entries['package-lock.json']).toEqual([ null, null ]);
      expect(entries['pnpm-lock.yaml']).toEqual([ null, null ]);
    });

    it('should change when a fingerprint file changes', async() => {
      const before = await createCache().fingerprint();
      files['/main/yarn.lock'] = { mtimeMs: 2_001, size: 20 };
      await expect(createCache().fingerprint()).resolves.not.toEqual(before);
    });
  });

  describe('load', () => {
    it('should return undefined without a cache file', async() => {
      await expect(createCache().load()).resolves.toBeUndefined();
    });

    it('should return undefined for a corrupt cache file', async() => {
      fileContents['/tmp/cache.json'] = '{ corrupt';
      await expect(createCache().load()).resolves.toBeUndefined();
    });

    it('should return undefined for a non-object cache file', async() => {
      fileContents['/tmp/cache.json'] = 'null';
      await expect(createCache().load()).resolves.toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith(`Ignoring stale module state cache at /tmp/cache.json`);
    });

    it('should return undefined for a stale fingerprint', async() => {
      const cache = createCache();
      await cache.save(moduleState);
      files['/main/node_modules'] = { mtimeMs: 4_000, size: 31 };
      await expect(cache.load()).resolves.toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith(`Ignoring stale module state cache at /tmp/cache.json`);
    });

    it('should return undefined for a stale fingerprint without a logger', async() => {
      const cache = createCache(false);
      await cache.save(moduleState);
      files['/main/node_modules'] = { mtimeMs: 4_000, size: 31 };
      await expect(cache.load()).resolves.toBeUndefined();
    });

    it('should round-trip a saved module state', async() => {
      const cache = createCache();
      await cache.save(moduleState);
      await expect(cache.load()).resolves.toEqual(moduleState);
    });
  });

  describe('save', () => {
    it('should write via a temporary file', async() => {
      await createCache().save(moduleState);
      expect(fs.writeFile).toHaveBeenCalledWith(`/tmp/cache.json.${process.pid}.tmp`, expect.any(String), 'utf8');
      expect(fs.rename).toHaveBeenCalledWith(`/tmp/cache.json.${process.pid}.tmp`, '/tmp/cache.json');
    });

    it('should warn on write failures', async() => {
      mocked(fs.writeFile).mockImplementation(<any> (async() => {
        throw new Error('Disk full');
      }));
      await createCache().save(moduleState);
      expect(logger.warn).toHaveBeenCalledWith(`Failed to save module state cache to /tmp/cache.json: Disk full`);
    });

    it('should ignore write failures without a logger', async() => {
      mocked(fs.writeFile).mockImplementation(<any> (async() => {
        throw new Error('Disk full');
      }));
      await createCache(false).save(moduleState);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
