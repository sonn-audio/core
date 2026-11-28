import { createLogger } from '@/shared/logging/logger';
import type { AudioserverExtensionConfig } from '@/domain/config/types';
import type { ConnectionRegistry } from '@/adapters/loxone/ws/connectionRegistry';
import type { ConfigPort } from '@/ports/ConfigPort';

const channelsPerExtension = 2;

/** How often the server repeats its hw_event while a client is connected (#460). */
const HEARTBEAT_INTERVAL_MS = 60_000;

interface HeartbeatEvent {
  client_id: string;
  event_id: number;
  value: number;
}

function normalizeMacId(raw?: string | number | null): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return normalized || undefined;
}

function buildBaseEvents(macId: string, uptimeSeconds: number): HeartbeatEvent[] {
  return [
    { client_id: `${macId}#1`, event_id: 2005, value: 0 },
    { client_id: `${macId}#1`, event_id: 2101, value: 67 },
    { client_id: `${macId}#1`, event_id: 2100, value: 0 },
    { client_id: `${macId}#1`, event_id: 2102, value: 0 },
    { client_id: `${macId}#1`, event_id: 2103, value: 0 },
    { client_id: `${macId}#1`, event_id: 2105, value: uptimeSeconds },
    { client_id: `${macId}#1`, event_id: 2106, value: 56 },
  ];
}

function buildExtensionEvents(
  extensions: AudioserverExtensionConfig[],
  uptimeSeconds: number,
): HeartbeatEvent[] {
  const events: HeartbeatEvent[] = [];

  for (const extension of extensions) {
    const mac = normalizeMacId(extension.mac);
    if (!mac) {
      continue;
    }

    for (let channel = 1; channel <= channelsPerExtension; channel++) {
      const client_id = `${mac}#${channel}`;
      events.push(
        { client_id, event_id: 2100, value: 0 },
        { client_id, event_id: 2101, value: 0 },
        { client_id, event_id: 2102, value: 0 },
        { client_id, event_id: 2103, value: 0 },
        { client_id, event_id: 2104, value: 1 },
        { client_id, event_id: 2105, value: uptimeSeconds },
      );
    }
  }

  return events;
}

function computeHeartbeatPayload(
  macId: string,
  extensions: AudioserverExtensionConfig[],
  uptimeSeconds: number,
): HeartbeatEvent[] {
  return [
    ...buildBaseEvents(macId, uptimeSeconds),
    ...buildExtensionEvents(extensions, uptimeSeconds),
  ];
}

export class ServerHeartbeat {
  private readonly log = createLogger('LoxoneHttp', 'Heartbeat');
  private readonly heartbeatStart = Date.now();

  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly registry: ConnectionRegistry) {}

  /**
   * Repeat the hw_event while the Loxone subsystem runs. It used to go out once, when the
   * Miniserver connected, and Audio Player blocks were reported offline after a while on
   * installations whose sockets and zone states were fine, until sonn was restarted (#460).
   */
  public start(configPort: ConfigPort, intervalMs = HEARTBEAT_INTERVAL_MS): void {
    this.stop();
    this.timer = setInterval(() => {
      if (this.registry.size === 0) return;
      this.emit(configPort);
    }, intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  public emit(configPort: ConfigPort): void {
    try {
      this.tick(configPort);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('failed to broadcast on-demand heartbeat', { message });
    }
  }

  private tick(configPort: ConfigPort): void {
    const systemConfig = configPort.getSystemConfig();
    const serverConfig = systemConfig?.audioserver;
    if (!serverConfig?.paired || !serverConfig.macId) {
      this.log.spam('skipped heartbeat tick (not paired)');
      return;
    }

    const macId = normalizeMacId(serverConfig.macId);
    if (!macId) {
      return;
    }

    const extensions = serverConfig.extensions ?? [];
    const uptimeSeconds = Math.floor((Date.now() - this.heartbeatStart) / 1000);
    const events = computeHeartbeatPayload(macId, extensions, uptimeSeconds);
    if (!events.length) {
      return;
    }

    this.registry.broadcastMessage(JSON.stringify({ hw_event: events }));
    this.log.spam('broadcast hw_event', {
      total: events.length,
      extensions: extensions.length,
    });
  }
}
