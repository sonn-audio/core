import type { ZoneConfig } from '@/domain/config/types';
import type { ZoneState } from '@/domain/zones/zoneState';

/** A speaker that switched itself to a source of its own while it was playing ours. */
export type ExternalTakeover = {
  mediaUrl: string;
  sourceName: string;
};

export interface ZoneStateController {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  handleCommand?(command: string, payload?: string): boolean | Promise<boolean>;
}

export type ZoneStateControllerFactoryArgs = {
  zone: ZoneConfig;
  onStatePatch: (zoneId: number, patch: Partial<ZoneState>) => void;
};
