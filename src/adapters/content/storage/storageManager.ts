import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import { ensureDir, readJson, resolveDataDir, writeJson } from '@/shared/utils/file';
import { explainMountFailure } from './mountDiagnostics';

export interface StorageConfig {
  id: string;
  name: string;
  server: string;
  folder: string;
  type: string;
  username?: string;
  password?: string;
  guest?: boolean;
  options?: string;
}

interface StorageFilePayload {
  storages: StorageConfig[];
}

const log = createLogger('Content', 'Storage');
const execFileAsync = promisify(execFile);
const STORAGE_PATH = resolveDataDir('music', 'nas', 'storage.json');
const LEGACY_STORAGE_PATH = resolveDataDir('storage', 'storages.json');
const NAS_DIR_TIMEOUT_MS = 3000;
const NAS_MOUNT_TIMEOUT_MS = 8000;
const NAS_CHECK_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadStorageFile(): Promise<StorageFilePayload> {
  await ensureDir(path.dirname(STORAGE_PATH));
  await ensureDir(path.dirname(LEGACY_STORAGE_PATH));

  const primary = await readJson<StorageFilePayload>(STORAGE_PATH);
  if (primary?.storages) {
    return { storages: primary.storages };
  }

  const legacy = await readJson<StorageFilePayload>(LEGACY_STORAGE_PATH);
  if (legacy?.storages) {
    return { storages: legacy.storages };
  }

  return { storages: [] };
}

async function saveStorageFile(storages: StorageConfig[]): Promise<void> {
  await ensureDir(path.dirname(STORAGE_PATH));
  await ensureDir(path.dirname(LEGACY_STORAGE_PATH));
  await writeJson(STORAGE_PATH, { storages });
  // Best-effort legacy write for compatibility; failure only skips the legacy copy.
  await bestEffort(() => writeJson(LEGACY_STORAGE_PATH, { storages }), {
    fallback: undefined,
    onError: 'debug',
    log,
    label: 'legacy storage save failed',
  });
}

export function getStorageMountPath(id: string): string {
  return path.join(resolveDataDir('music', 'nas'), String(id));
}

const DEFAULT_MOUNT_OPTIONS = ['rw', 'file_mode=0644', 'dir_mode=0755'];

/**
 * The mount options for one attempt: our defaults, the attempt's credentials, then what the
 * storage's own options field says.
 *
 * The field wins over a default it names: `ro` replaces `rw`, and `file_mode=0600` replaces ours.
 * Appending it after the defaults left both `rw` and `ro` in the list, and the fallback with
 * inline credentials dropped the field altogether, so options a user typed never reached
 * mount.cifs (#438).
 */
export function withMountDefaults(credentials: readonly string[], userOptions: string | undefined): string[] {
  const user = (userOptions ?? '')
    .split(',')
    .map((opt) => opt.trim())
    .filter(Boolean);
  const keyOf = (opt: string) => {
    const key = opt.split('=')[0]!.trim().toLowerCase();
    return key === 'ro' ? 'rw' : key;
  };
  const named = new Set(user.map(keyOf));
  const defaults = DEFAULT_MOUNT_OPTIONS.filter((opt) => !named.has(keyOf(opt)));
  return [...defaults, ...credentials, ...user];
}

async function mountStorage(cfg: StorageConfig, dir: string): Promise<void> {
  if (cfg.type.toLowerCase() !== 'cifs') {
    throw new Error(`Unsupported storage type "${cfg.type}" (only "cifs" is supported)`);
  }

  const unc = `//${cfg.server}/${cfg.folder}`;
  // No iocharset here: CIFS already defaults to UTF-8. Forcing iocharset=utf8
  // breaks mounts on Linux 6.6+, where nls_utf8 is built into the kernel instead
  // of a loadable module, so mount.cifs aborts with "iocharset utf8 not found"
  // before any SMB negotiation (#321). A share that needs a different charset can
  // still pass iocharset=… through the per-storage options field below.
  const options: string[] = [];
  const inlineCreds: string[] = [];
  let credentialsPath: string | undefined;

  if (cfg.guest) {
    options.push('guest');
  } else if (cfg.username) {
    if (cfg.password && cfg.password.trim()) {
      credentialsPath = path.join(dir, '.cifs-credentials');
      const credsPath = credentialsPath;
      const content = `username=${cfg.username}\npassword=${cfg.password}\n`;
      // Best-effort credentials file; mount will fall back to inline creds or fail later.
      await bestEffort(
        () => fsp.writeFile(credsPath, content, { encoding: 'utf8', mode: 0o600 }),
        {
          fallback: undefined,
          onError: 'debug',
          log,
          label: 'credentials file write failed',
          context: { dir },
        },
      );
      await bestEffort(() => fsp.chmod(credsPath, 0o600), {
        fallback: undefined,
        onError: 'debug',
        log,
        label: 'credentials chmod failed',
        context: { dir },
      });
      options.push(`credentials=${credsPath}`);
    } else {
      options.push(`username=${cfg.username}`);
    }
    inlineCreds.push(`username=${cfg.username}`);
    if (cfg.password && cfg.password.trim()) {
      inlineCreds.push(`password=${cfg.password}`);
    }
  }

  const attemptMount = async (opts: string[]): Promise<void> => {
    const optString = opts.join(',');
    const mountArgs = ['-t', 'cifs', unc, dir, '-o', optString];
    log.debug('mounting storage', { unc, dir, options: optString });
    await execFileAsync('mount', mountArgs, { timeout: NAS_MOUNT_TIMEOUT_MS });
  };

  const tryMountWithFallback = async (opts: string[]): Promise<void> => {
    try {
      await attemptMount(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/read-only/i.test(msg)) {
        const roOptions = opts.map((opt) => (opt === 'rw' ? 'ro' : opt));
        await attemptMount(roOptions);
        return;
      }
      throw err;
    }
  };

  try {
    await tryMountWithFallback(withMountDefaults(options, cfg.options));
    return;
  } catch (primaryErr) {
    // If credentials file was used, try inline username/password as a fallback (matches simple CLI mount).
    if (inlineCreds.length) {
      const inlineOptions = withMountDefaults(inlineCreds, cfg.options);
      try {
        await tryMountWithFallback(inlineOptions);
        return;
      } catch (inlineErr) {
        if (credentialsPath) {
          // Best-effort cleanup; a missing credentials file is harmless.
          await bestEffort(() => fsp.rm(credentialsPath, { force: true }), {
            fallback: undefined,
            onError: 'debug',
            log,
            label: 'credentials cleanup failed',
            context: { dir },
          });
        }
        const msg = inlineErr instanceof Error ? inlineErr.message : String(inlineErr);
        log.error('mount failed (inline fallback)', { unc, dir, message: msg });
        throw new Error(await explainMountFailure(msg));
      }
    }

    if (credentialsPath) {
      // Best-effort cleanup; missing credentials file is harmless.
      await bestEffort(() => fsp.rm(credentialsPath, { force: true }), {
        fallback: undefined,
        onError: 'debug',
        log,
        label: 'credentials cleanup failed',
        context: { dir },
      });
    }
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    log.error('mount failed', { unc, dir, message: msg });
    throw new Error(await explainMountFailure(msg));
  }
}

async function checkMount(dir: string): Promise<boolean> {
  // Best-effort check; if mount output can't be read, treat as not mounted.
  return bestEffort(
    async () => {
      const { stdout } = await execFileAsync('mount', [], { timeout: NAS_CHECK_TIMEOUT_MS });
      const output = typeof stdout === 'string' ? stdout : String(stdout ?? '');
      return output.includes(` ${dir} `);
    },
    {
      fallback: false,
      onError: 'debug',
      log,
      label: 'mount check failed',
      context: { dir },
    },
  );
}

async function probeMount(dir: string): Promise<boolean> {
  // fsp.access on a stale CIFS mount throws ESTALE immediately; timeout guards against hangs.
  return bestEffort(
    async () => {
      await withTimeout(fsp.access(dir), NAS_CHECK_TIMEOUT_MS, 'probe nas mount');
      return true;
    },
    { fallback: false, onError: 'debug', log, label: 'mount probe failed', context: { dir } },
  );
}

export async function listStorages(): Promise<StorageConfig[]> {
  const file = await loadStorageFile();
  return file.storages;
}

export async function addStorage(
  config: Omit<StorageConfig, 'id'> & { id?: string },
): Promise<StorageConfig> {
  const file = await loadStorageFile();
  const id = config.id ?? `storage-${Date.now()}`;
  const storage: StorageConfig = { ...config, id };

  const mountPoint = getStorageMountPath(storage.id);
  await ensureDir(mountPoint);

  try {
    await mountStorage(storage, mountPoint);
  } catch (err) {
    // Best-effort cleanup; mount failure should not crash cleanup.
    await bestEffort(() => fsp.rm(mountPoint, { recursive: true, force: true }), {
      fallback: undefined,
      onError: 'debug',
      log,
      label: 'mount point cleanup failed',
      context: { mountPoint },
    });
    throw err;
  }

  const updated = [...file.storages, storage];
  await saveStorageFile(updated);
  log.info('mounted storage', { id: storage.id, name: storage.name, mountPoint });
  return storage;
}

export async function deleteStorage(id: string): Promise<void> {
  const file = await loadStorageFile();
  const idx = file.storages.findIndex((storage) => storage.id === id);
  if (idx === -1) {
    return;
  }

  const storage = file.storages[idx]!;
  const mountPoint = getStorageMountPath(storage.id);

  try {
    await execFileAsync('umount', [mountPoint]);
  } catch (error) {
    // Best-effort unmount; proceed with cleanup even if already unmounted.
    const message = error instanceof Error ? error.message : String(error);
    log.debug('storage unmount failed', { mountPoint, message });
  }

  // Best-effort cleanup; missing mount dir is fine.
  await bestEffort(() => fsp.rm(mountPoint, { recursive: true, force: true }), {
    fallback: undefined,
    onError: 'debug',
    log,
    label: 'mount point cleanup failed',
    context: { mountPoint },
  });

  const updated = file.storages.filter((entry) => entry.id !== id);
  await saveStorageFile(updated);
  log.info('deleted storage', { id: storage.id, name: storage.name });
}

export async function ensureNasMounts(baseDir: string): Promise<void> {
  // Best-effort listing; if storage config is unreadable, skip mounting.
  const storages = await bestEffort(() => listStorages(), {
    fallback: [],
    onError: 'debug',
    log,
    label: 'list storages failed',
  });

  for (const storage of storages) {
    const mountRoot = path.join(baseDir, 'nas', String(storage.id));
    const meta = { id: storage.id, name: storage.name, mountRoot };
    try {
      await withTimeout(ensureDir(mountRoot), NAS_DIR_TIMEOUT_MS, 'ensure nas mount dir');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('nas mount dir unavailable; skipping', { ...meta, message });
      continue;
    }

    const mounted = await checkMount(mountRoot);
    if (mounted) {
      const healthy = await probeMount(mountRoot);
      if (healthy) {
        log.info('storage already mounted', { id: storage.id, name: storage.name });
        continue;
      }
      log.warn('stale NAS mount detected; remounting', { id: storage.id, name: storage.name });
      await bestEffort(() => execFileAsync('umount', ['-l', mountRoot], { timeout: NAS_CHECK_TIMEOUT_MS }), {
        fallback: undefined,
        onError: 'debug',
        log,
        label: 'lazy umount failed',
        context: { mountRoot },
      });
    } else {
      log.warn('mounting NAS storage', { id: storage.id, name: storage.name });
    }

    try {
      await mountStorage(storage, mountRoot);
      log.info('mounted NAS storage', { id: storage.id, name: storage.name, mountRoot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('failed to mount NAS storage', { id: storage.id, name: storage.name, message });
    }
  }
}
