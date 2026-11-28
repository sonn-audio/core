import type { LoxoneHttpConfig } from '@/config/loxone';
import { createLogger } from '@/shared/logging/logger';
import { LoxoneRouter } from '@/adapters/loxone/commands/router/loxoneRouter';
import { registerRoutes } from '@/adapters/loxone/commands/router/routeRegistry';
import { serializeResult } from '@/adapters/loxone/commands/responses';
import { formatCommand } from '@/adapters/loxone/commands/utils/commandFormatter';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { GroupManager } from '@/application/groups/groupManager';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { GroupTrackerPort } from '@/ports/GroupTrackerPort';
import type { FadeControllerPort } from '@/ports/FadeControllerPort';
import type { AlertsPort } from '@/ports/AlertsPort';
import type { LineInActivationService } from '@/application/inputs/lineInActivationService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { LoxoneConfigService } from '@/adapters/loxone/services/loxoneConfigService';

export interface LoxoneCommandProcessorOptions {
  onRestart?: () => Promise<boolean>;
  notifier: NotifierPort;
  loxoneNotifier: LoxoneWsNotifier;
  configService: LoxoneConfigService;
  zoneManager: ZoneManagerFacade;
  configPort: ConfigPort;
  lineInActivationService: LineInActivationService;
  spotifyInputService: SpotifyInputService;
  recentsManager: RecentsManager;
  favoritesManager: FavoritesManager;
  groupManager: GroupManager;
  groupTracker: GroupTrackerPort;
  fadeController: FadeControllerPort;
  alerts: AlertsPort;
  contentManager: ContentManager;
}

/**
 * Bridges the HTTP transport with the command router/handlers.
 */
export class LoxoneCommandProcessor {
  private readonly log = createLogger('LoxoneHttp', 'Processor');
  private readonly router = new LoxoneRouter();
  private readonly slowCommandWarnMs = 100;

  private readonly loxoneNotifier: LoxoneWsNotifier;

  constructor(config: LoxoneHttpConfig, options: LoxoneCommandProcessorOptions) {
    this.loxoneNotifier = options.loxoneNotifier;
    registerRoutes(this.router, {
      config,
      onRestart: options.onRestart,
      notifier: options.notifier,
      loxoneNotifier: options.loxoneNotifier,
      configService: options.configService,
      zoneManager: options.zoneManager,
      configPort: options.configPort,
      lineInActivationService: options.lineInActivationService,
      spotifyInputService: options.spotifyInputService,
      recentsManager: options.recentsManager,
      favoritesManager: options.favoritesManager,
      groupManager: options.groupManager,
      groupTracker: options.groupTracker,
      fadeController: options.fadeController,
      alerts: options.alerts,
      contentManager: options.contentManager,
    });
  }

  public async execute(command: string, payload?: Buffer): Promise<string> {
    this.log.debug('command received', { command: formatCommand(command) });
    const startedAt = Date.now();
    try {
      const result = await this.router.dispatch(command, payload);
      // Covers in an answer go out as the clients can load them (#449).
      const answer =
        typeof result.payload === 'string' ? result.payload : this.loxoneNotifier.rewriteCovers(result.payload);
      return serializeResult({ ...result, payload: answer });
    } finally {
      const tookMs = Date.now() - startedAt;
      if (tookMs >= this.slowCommandWarnMs) {
        this.log.debug('slow command', { command: formatCommand(command), tookMs });
      }
    }
  }
}
