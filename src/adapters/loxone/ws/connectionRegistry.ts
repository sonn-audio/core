import type { connection as WebSocketConnection } from 'websocket';
import { createLogger } from '@/shared/logging/logger';

export class ConnectionRegistry {
  private readonly log = createLogger('LoxoneHttp', 'WS');
  private readonly connections = new Set<WebSocketConnection>();

  public registerConnection(connection: WebSocketConnection): void {
    this.connections.add(connection);
    this.log.debug('ws connected', { total: this.connections.size });
  }

  public unregisterConnection(connection: WebSocketConnection): void {
    if (this.connections.delete(connection)) {
      this.log.debug('ws disconnected', { total: this.connections.size });
    }
  }

  public broadcastMessage(payload: string): void {
    for (const connection of this.connections) {
      if (!connection.connected) {
        continue;
      }
      try {
        connection.sendUTF(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('failed to broadcast message', { message });
      }
    }
  }

  public get size(): number {
    return this.connections.size;
  }
}
