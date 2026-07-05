import { promises as fs } from 'node:fs';
import * as Path from 'node:path';
import type { Logger } from 'winston';

// eslint-disable-next-line import/extensions
import packageJson from '../../package.json';
import type { IModuleState } from './ModuleStateBuilder';

/**
 * The version of the cache file format.
 * Increment when the shape of the persisted data (or of {@link IModuleState}) changes.
 */
const CACHE_FORMAT_VERSION = 1;

/**
 * The files (relative to the main module path) whose modification time and size
 * are included in the staleness fingerprint of a persisted module state.
 */
const FINGERPRINT_PATHS = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'node_modules',
];

/**
 * Persists an {@link IModuleState} (the result of component discovery over the
 * dependency tree) to a file, so that subsequent invocations can skip the
 * discovery scan entirely.
 *
 * Staleness handling: the cache stores a fingerprint of the cache format version,
 * the componentsjs version, the main module path, and the modification time and
 * size of the main module's package.json, lock files, and node_modules directory.
 * A fingerprint mismatch (or any read/parse failure) makes {@link ModuleStateCache.load}
 * return `undefined`, after which the caller is expected to run a fresh discovery
 * scan and {@link ModuleStateCache.save} its result.
 *
 * This is a heuristic: package installations and removals touch a lock file and
 * the node_modules directory, and are detected. In-place modifications deep
 * inside node_modules (such as manually editing an installed package's component
 * files) are NOT detected; in such cases the cache file must be removed manually
 * (or the option not be used).
 */
export class ModuleStateCache {
  private readonly path: string;
  private readonly mainModulePath: string;
  private readonly logger?: Logger;

  public constructor(options: IModuleStateCacheOptions) {
    this.path = options.path;
    this.mainModulePath = options.mainModulePath;
    this.logger = options.logger;
  }

  /**
   * Compute the current staleness fingerprint for the main module path.
   */
  public async fingerprint(): Promise<string> {
    const entries = await Promise.all(FINGERPRINT_PATHS.map(async(subPath) => {
      try {
        const stat = await fs.stat(Path.posix.join(this.mainModulePath, subPath));
        return [ subPath, stat.mtimeMs, stat.size ];
      } catch {
        return [ subPath, null, null ];
      }
    }));
    return JSON.stringify([ CACHE_FORMAT_VERSION, packageJson.version, this.mainModulePath, entries ]);
  }

  /**
   * Load the persisted module state, if it exists and is fresh.
   * @returns The module state, or `undefined` if there is no (fresh, readable) cache entry.
   */
  public async load(): Promise<IModuleState | undefined> {
    let payload: any;
    try {
      payload = JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch {
      // No (readable) cache file
      return;
    }
    if (!payload || typeof payload !== 'object' || payload.fingerprint !== await this.fingerprint()) {
      if (this.logger) {
        this.logger.info(`Ignoring stale module state cache at ${this.path}`);
      }
      return;
    }
    return payload.moduleState;
  }

  /**
   * Persist the given module state (best-effort: failures are logged, not thrown).
   * @param moduleState A module state.
   */
  public async save(moduleState: IModuleState): Promise<void> {
    try {
      const payload = JSON.stringify({
        fingerprint: await this.fingerprint(),
        moduleState,
      });
      // Write-then-rename, so concurrent invocations never observe a partial cache file.
      const temporaryPath = `${this.path}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, payload, 'utf8');
      await fs.rename(temporaryPath, this.path);
    } catch (error: unknown) {
      if (this.logger) {
        this.logger.warn(`Failed to save module state cache to ${this.path}: ${(<Error> error).message}`);
      }
    }
  }
}

export interface IModuleStateCacheOptions {
  /**
   * The file path to persist the module state to.
   */
  path: string;
  /**
   * Absolute path to the package root from which module resolution starts.
   */
  mainModulePath: string;
  /**
   * An optional logger.
   */
  logger?: Logger;
}
