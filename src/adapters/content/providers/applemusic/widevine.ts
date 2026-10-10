import { join } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { Widevine } from 'widevine';
import protobuf from 'protobufjs';
import { ensureDir, readFileBuffer, resolveDataDir } from '@/shared/utils/file';

const CDM_DIR = resolveDataDir('widevine_cdm');
const PRIVATE_KEY_PATH = join(CDM_DIR, 'private_key.pem');
const CLIENT_ID_PATH = join(CDM_DIR, 'client_id.bin');

type WidevineArtifacts = {
  privateKey: Buffer;
  clientIdBlob: Buffer;
};

let cachedArtifacts: WidevineArtifacts | null = null;

export function invalidateWidevineArtifactsCache(): void {
  cachedArtifacts = null;
}

export class WidevineArtifactsError extends Error {
  public readonly code: 'missing' | 'invalid';
  public readonly details: string[];

  constructor(code: 'missing' | 'invalid', message: string, details: string[]) {
    super(message);
    this.name = 'WidevineArtifactsError';
    this.code = code;
    this.details = details;
  }
}

async function ensureWidevineCdm(): Promise<void> {
  await ensureDir(CDM_DIR);
}

export async function loadWidevineArtifacts(): Promise<WidevineArtifacts> {
  if (cachedArtifacts) {
    return cachedArtifacts;
  }

  await ensureWidevineCdm();

  let privateKey: Buffer;
  let clientIdBlob: Buffer;
  try {
    privateKey = await readFileBuffer(PRIVATE_KEY_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WidevineArtifactsError('missing', 'Widevine artifacts missing', ['private_key.pem missing']);
    }
    throw err;
  }
  try {
    clientIdBlob = await readFileBuffer(CLIENT_ID_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WidevineArtifactsError('missing', 'Widevine artifacts missing', ['client_id.bin missing']);
    }
    throw err;
  }

  const issues: string[] = [];
  if (!privateKey.length) {
    issues.push('private_key.pem empty');
  } else {
    const keyText = privateKey.toString('utf-8');
    if (!/-----BEGIN [A-Z ]+-----/.test(keyText)) {
      issues.push('private_key.pem invalid');
    }
  }
  if (!clientIdBlob.length) {
    issues.push('client_id.bin empty');
  }
  // Basic sanity: real client_id blobs are larger than a few bytes. This catches placeholder files.
  if (clientIdBlob.length > 0 && clientIdBlob.length < 64) {
    issues.push('client_id.bin too small');
  }
  if (issues.length) {
    throw new WidevineArtifactsError('invalid', 'Widevine artifacts missing or invalid', issues);
  }

  // Strong validation: ensure the private key is parseable and that the widevine library accepts the pair.
  const strongIssues: string[] = [];
  try {
    createPrivateKey(privateKey);
  } catch {
    strongIssues.push('private_key.pem parse failed');
  }
  if (strongIssues.length === 0) {
    try {
      Widevine.init(clientIdBlob, privateKey);
    } catch {
      strongIssues.push('widevine init failed');
    }
  }
  if (strongIssues.length) {
    throw new WidevineArtifactsError('invalid', 'Widevine artifacts missing or invalid', strongIssues);
  }

  cachedArtifacts = { privateKey, clientIdBlob };
  return cachedArtifacts;
}

/* -------------------------------------------------------------------------- */
/* Pure PSSH / key-id parsing helpers for Apple Music key URIs                */
/* -------------------------------------------------------------------------- */

const WIDEVINE_PSSH_PROTO = `
syntax = "proto2";

message WidevinePsshData {
  optional uint32 algorithm = 1;
  repeated bytes key_ids = 2;
}
`;

const WidevinePsshDataMsg = (() => {
  const parsed = protobuf.parse(WIDEVINE_PSSH_PROTO);
  return parsed.root.lookupType('WidevinePsshData');
})();

/** Normalize a (possibly URL-safe / unpadded) base64 string to standard padded base64. */
export function normalizeBase64(value: string): string {
  const trimmed = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = trimmed.length % 4;
  if (pad === 0) return trimmed;
  return trimmed + '='.repeat(4 - pad);
}

/** Build a Widevine PSSH box from a raw 16-byte key id. */
export function buildWidevinePsshFromKid(kid: Buffer): Buffer {
  const initData = WidevinePsshDataMsg.encode({ algorithm: 1, keyIds: [kid] }).finish();
  const systemId = Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex');
  const totalSize = 32 + initData.length;
  const pssh = Buffer.alloc(totalSize);
  let offset = 0;
  pssh.writeUInt32BE(totalSize, offset); offset += 4;
  pssh.write('pssh', offset); offset += 4;
  pssh.writeUInt32BE(0, offset); offset += 4;
  systemId.copy(pssh, offset); offset += 16;
  pssh.writeUInt32BE(initData.length, offset); offset += 4;
  Buffer.from(initData).copy(pssh, offset);
  return pssh;
}

/** Coerce arbitrary key-uri payload bytes into a PSSH box (passthrough, or build from a 16-byte kid). */
export function coercePssh(data: Buffer): Buffer | null {
  if (data.length >= 32 && data.subarray(4, 8).toString('ascii') === 'pssh') {
    return data;
  }
  if (data.length === 16) {
    return buildWidevinePsshFromKid(data);
  }
  return null;
}

/** Extract a PSSH box from an EXT-X-KEY URI (data:...;base64,... or bare base64). */
export function extractPsshFromKeyUri(keyUri: string): Buffer | null {
  const trimmed = keyUri.trim();
  if (/^skd:\/\//i.test(trimmed)) return null;
  const base64Index = trimmed.indexOf('base64,');
  if (base64Index !== -1) {
    const payload = trimmed.slice(base64Index + 'base64,'.length).trim();
    if (!payload) return null;
    return coercePssh(Buffer.from(payload, 'base64'));
  }
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 16) {
    try {
      return coercePssh(Buffer.from(trimmed, 'base64'));
    } catch {
      return null;
    }
  }
  return null;
}

/** Read the first key id from a PSSH box's WidevinePsshData payload. */
export function extractKidFromPssh(pssh: Buffer): Buffer | null {
  if (!pssh || pssh.length < 32) return null;
  if (pssh.subarray(4, 8).toString('ascii') !== 'pssh') return null;
  try {
    const decoded = WidevinePsshDataMsg.decode(pssh.subarray(32)) as { keyIds?: Buffer[] };
    const keyId = decoded?.keyIds?.[0];
    return Buffer.isBuffer(keyId) ? keyId : keyId ? Buffer.from(keyId) : null;
  } catch {
    return null;
  }
}

/** Determine the expected content key id for a key URI (direct 16-byte payload or via PSSH). */
export function extractKidFromKeyUri(keyUri: string, pssh?: Buffer | null): Buffer | null {
  const trimmed = keyUri.trim();
  if (/^skd:\/\//i.test(trimmed)) return null;
  const base64Index = trimmed.indexOf('base64,');
  const payload = base64Index !== -1 ? trimmed.slice(base64Index + 'base64,'.length).trim() : trimmed;
  if (payload && /^[A-Za-z0-9+/=]+$/.test(payload)) {
    try {
      const decoded = Buffer.from(payload, 'base64');
      if (decoded.length === 16) return decoded;
    } catch {
      // ignore
    }
  }
  if (pssh) {
    return extractKidFromPssh(pssh);
  }
  return null;
}
