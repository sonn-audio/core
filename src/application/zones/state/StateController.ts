import type { ZoneConfig } from '@/domain/config/types';
import type { ZoneState } from '@/domain/zones/zoneState';

/** A speaker that switched itself to a source of its own while it was playing ours. */
export type ExternalTakeover = {
  mediaUrl: string;
  sourceName: string;
};

/** What an external player says it can do, in the terms the client mask uses. */
export type ExternalTransportCapabilities = {
  skip: boolean;
  seek: boolean;
  shuffle: boolean;
  repeat: boolean;
};

export interface ZoneStateController {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  handleCommand?(command: string, payload?: string): boolean | Promise<boolean>;
  /**
   * The transport a player that owns the zone right now will actually perform, or null when it
   * cannot say. Read by the projection to build the client's capability mask, so a control is
   * only offered when something will act on it; see `zoneTransportCapabilities`.
   */
  getTransportCapabilities?(): ExternalTransportCapabilities | null;
}

export type ZoneStateControllerFactoryArgs = {
  zone: ZoneConfig;
  onStatePatch: (zoneId: number, patch: Partial<ZoneState>) => void;
};
