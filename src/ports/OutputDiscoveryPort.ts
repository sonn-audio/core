import type { OutputConfigDefinition } from '@/ports/OutputsTypes';

/** How long to look, and where. `host` skips the scan and probes one address directly. */
export type DeviceDiscoveryOptions = {
  host?: string;
  timeoutMs?: number;
  /** SSDP `MX`: the window a device may wait before answering, in seconds. */
  mx?: number;
};

export interface AirplayDeviceDescriptor {
  id: string;
  name: string;
  host: string;
  address?: string;
  port: number;
  protocol: 'airplay' | 'raop';
  txt?: Record<string, unknown>;
}

export interface GoogleCastDeviceDescriptor {
  id: string;
  name: string;
  host: string;
  address?: string;
  port: number;
  manufacturer?: string;
  model?: string;
  txt?: Record<string, unknown>;
}

export interface DlnaDiscoveredDevice {
  id: string;
  name?: string;
  host: string;
  address?: string;
  location: string;
  controlUrl?: string;
  renderingControlUrl?: string;
}

/**
 * Sonos asks a different question than plain SSDP: a household can be named or filtered, and a
 * scan of the subnet is a fallback the caller opts into rather than the default.
 */
export type SonosDiscoveryOptions = {
  preferredName?: string;
  householdId?: string;
  allowNetworkScan?: boolean;
  timeoutMs?: number;
};

export interface SonosDiscoveredDevice {
  host: string;
  name?: string;
  roomName?: string;
  /** Model from the UPnP device description, e.g. "Sonos Beam". */
  model?: string;
  udn?: string;
  householdId?: string;
  /**
   * Passive/bonded satellite (e.g. stereo pair member, surround, sub).
   * These should not be selectable as standalone playback targets.
   */
  passiveSatellite?: boolean;
}

/**
 * Finding playback devices on the network, and saying which kinds exist.
 *
 * Four methods rather than one, because the protocols do not answer alike: mDNS browses for a
 * service type and SSDP asks the subnet a question with a wait window. Flattening them onto a
 * single signature would mean inventing options that three of the four ignore.
 *
 * A port because the admin routes are its only caller and they used to reach the four output
 * families directly — which made a route that lists AirPlay speakers impossible to exercise
 * without real hardware answering on the wire.
 */
export interface OutputDiscoveryPort {
  /** The output kinds this server can drive, for the admin UI's picker. */
  readonly definitions: readonly OutputConfigDefinition[];
  airplay(timeoutMs?: number): Promise<AirplayDeviceDescriptor[]>;
  googleCast(timeoutMs?: number, explicitHosts?: string[]): Promise<GoogleCastDeviceDescriptor[]>;
  dlna(options?: DeviceDiscoveryOptions): Promise<DlnaDiscoveredDevice[]>;
  sonos(options?: SonosDiscoveryOptions): Promise<SonosDiscoveredDevice[]>;
}
