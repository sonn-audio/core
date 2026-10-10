import { promises as fs } from 'node:fs';
import path from 'node:path';
import { generate } from 'selfsigned';
import { createLogger } from '@/shared/logging/logger';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';

export interface TlsContext {
  cert: string;
  key: string;
}

const log = createLogger('LoxoneHttp', 'TLS');

/**
 * Returns a self-signed cert/key pair for the Loxone HTTP listeners.
 *
 * v2 Miniservers connect to the Audioserver upstream over TLS even when the
 * audioserver is on the local network. Without a TLS listener on the same
 * port, the Miniserver's ClientHello is rejected (sonn-core answers
 * 400 Bad Request) and the cloud-proxy hop fails. The cert is generated
 * once and cached under `data/loxone/`; the Miniserver does not appear to
 * pin the issuer, so a self-signed cert is enough to complete the handshake.
 */
export async function loadOrGenerateSelfSignedTls(): Promise<TlsContext | null> {
  const dir = resolveDataDir('loxone');
  const certPath = path.join(dir, 'self-signed.crt');
  const keyPath = path.join(dir, 'self-signed.key');

  try {
    const [cert, key] = await Promise.all([
      fs.readFile(certPath, 'utf-8'),
      fs.readFile(keyPath, 'utf-8'),
    ]);
    log.info('loaded existing self-signed certificate', { certPath });
    return { cert, key };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('failed to read existing self-signed cert; will regenerate', {
        error: (error as Error).message,
      });
    }
  }

  try {
    await ensureDir(dir);
    const notBeforeDate = new Date();
    const notAfterDate = new Date(notBeforeDate);
    notAfterDate.setFullYear(notBeforeDate.getFullYear() + 10);
    const { cert: pemCert, private: pemKey } = await generate(
      [
        { name: 'commonName', value: 'sonn-core' },
        { name: 'organizationName', value: 'sonn-core' },
      ],
      { keySize: 2048, algorithm: 'sha256', notBeforeDate, notAfterDate },
    );
    await Promise.all([
      fs.writeFile(certPath, pemCert, { encoding: 'utf-8', mode: 0o600 }),
      fs.writeFile(keyPath, pemKey, { encoding: 'utf-8', mode: 0o600 }),
    ]);
    log.info('generated self-signed certificate', { certPath });
    return { cert: pemCert, key: pemKey };
  } catch (error) {
    log.warn('failed to generate self-signed cert; TLS disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
