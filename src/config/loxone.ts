import type { EnvironmentConfig } from '@/config/environment';
import { DEFAULT_MAC_ID } from '@/shared/utils/mac';

export type LoxoneServerName = 'appHttp' | 'msHttp';

export interface LoxoneHttpServerConfig {
  name: LoxoneServerName;
  port: number;
  identification: string;
}

export interface LoxoneHttpConfig {
  firmwareVersion: string;
  firmwareVersionNumber: string;
  apiVersion: string;
  sessionToken: string;
  macAddress: string;
  servers: LoxoneHttpServerConfig[];
  /** The host name the server gives a search for audio servers, without `.local`. */
  hostname: string;
}

// Single source of truth for the emulated Audioserver version: the LWSS greeting and the answer
// to a search both carry it.
//
// The Loxone app switches features on by this number (see docs/loxone-client-map.md, "Greeting").
// 18.1.0.0 is the lowest that makes it offer the loudness switch; everything else it gates sits
// at 17.0 or below.
const FIRMWARE_VERSION_NUMBER = '18.1.0.0';

const DEFAULT_FIRMWARE_VERSION = `LWSS V ${FIRMWARE_VERSION_NUMBER}`;
const DEFAULT_API_VERSION = '~API:1.6~';
const DEFAULT_SESSION = '8WahwAfULwEQce9Yu0qIE9L7QMkXFHbi0M9ch9vKcgYArPPojXHpSiNcq0fT3lqL';
const DEFAULT_HOSTNAME = 'audioserver';

/**
 * Builds the configuration for the emulated Loxone HTTP servers.
 */
export function buildLoxoneHttpConfig(
  env: EnvironmentConfig,
  macAddress?: string,
): LoxoneHttpConfig {
  const firmwareVersion = DEFAULT_FIRMWARE_VERSION;
  const apiVersion = DEFAULT_API_VERSION;
  const sessionToken = DEFAULT_SESSION;
  const resolvedMacAddress = macAddress?.trim() || DEFAULT_MAC_ID;

  return {
    firmwareVersion,
    firmwareVersionNumber: FIRMWARE_VERSION_NUMBER,
    apiVersion,
    sessionToken,
    macAddress: resolvedMacAddress,
    servers: [
      {
        name: 'appHttp',
        port: env.loxoneAppPort,
        identification: formatIdentification(
          'appHttp',
          firmwareVersion,
          apiVersion,
          resolvedMacAddress,
          sessionToken,
        ),
      },
      {
        name: 'msHttp',
        port: env.loxoneMiniserverPort,
        identification: formatIdentification(
          'msHttp',
          firmwareVersion,
          apiVersion,
          resolvedMacAddress,
          sessionToken,
        ),
      },
    ],
    hostname: DEFAULT_HOSTNAME,
  };
}

function formatIdentification(
  name: LoxoneServerName,
  firmware: string,
  api: string,
  mac: string,
  session: string,
): string {
  const base =
    name === 'msHttp' ? `MINISERVER V ${firmware} ${mac}` : firmware;

  return `${base} | ${api} | Session-Token: ${session}`;
}
