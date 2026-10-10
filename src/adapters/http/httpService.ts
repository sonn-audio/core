import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { HttpServerConfig } from '@/config/http';
import { AdminApiHandler } from '@/adapters/http/adminApi/adminApiHandler';
import { createAdminApiDeps, type AdminSurfaceDeps } from '@/adapters/http/adminApi/adminApiDeps';
import { MusicStreamingHandler } from '@/adapters/http/music/musicStreamingHandler';
import { StaticFileHandler } from '@/adapters/http/static/staticFileHandler';
import { SendspinGateway } from '@/adapters/http/sendspin/sendspinGateway';
import { SnapcastGateway } from '@/adapters/http/snapcast/snapcastGateway';
import { AudioStreamHandler } from '@/adapters/http/streams/audioStreamHandler';
import { AudioProxyHandler } from '@/adapters/http/streams/audioProxyHandler';
import { LineInIngestWebSocket } from '@/adapters/http/streams/lineInIngestWs';
import { SonnClientApiHandler } from '@/adapters/http/sonnClientApi/sonnClientApiHandler';
import { BeoremoteApiHandler } from '@/adapters/http/beoremote/beoremoteApiHandler';
import { ApiHandler } from '@/adapters/http/api/apiHandler';
import { createApiHandlerDeps, type ApiSurfaceDeps } from '@/adapters/http/api/apiHandlerDeps';
import { AboutStore } from '@/adapters/content/enrichment/aboutStore';
import { AboutService } from '@/adapters/http/api/aboutService';
import { BrowseService } from '@/adapters/http/api/browseService';
import { DestinationService } from '@/adapters/http/api/destinationService';
import { isLocalRequest } from '@/shared/utils/net';
import type { StreamProxyRoute } from '@/shared/streamProxyRoute';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { EnginePort } from '@/ports/EnginePort';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import type { LineInActivationRegistry } from '@/adapters/inputs/linein/lineInActivationRegistry';
import type { BluetoothNowPlayingSink } from '@/adapters/http/sonnClientApi/sonnClientApiHandler';
import type { StreamEvents } from '@/adapters/http/streams/streamEvents';
import type { LoxoneCommandProcessor } from '@/adapters/loxone/http/commandProcessor';
import type { ConnectionRegistry } from '@/adapters/loxone/ws/connectionRegistry';
import type { BrowserZoneRegistry } from '@/application/zones/browserZoneRegistry';
import { connection as WebSocketConnection, server as WebSocketServer } from 'websocket';
import type { LmsCliServer } from '@/adapters/outputs/squeezelite/lmsCliServer';
import type { MediaServer } from '@/adapters/mediaserver/mediaServer';
import type { SubsonicApi } from '@/adapters/subsonic/subsonicApi';
import type { WebdavServer } from '@/adapters/webdav/webdavServer';
import type { DlnaInputService } from '@/adapters/inputs/dlna/dlnaInputService';
import type { DlnaLineInService } from '@/adapters/inputs/linein/dlnaLineInService';

/**
 * What the streaming and websocket transports need: the engine, the ingest registries and the
 * gateways, plus the optional servers an install may or may not be running.
 *
 * The third of the three surfaces this gateway hosts. `HttpServiceOptions` is their sum, which is
 * what a composition point's dependencies honestly are — the difference is that each surface now
 * declares its own, so a route's needs can be read off a type instead of traced by hand.
 */
export type TransportSurfaceDeps = {
    /** The Bluetooth input, so a phone's now-playing reaches the room it is playing in. */
    bluetoothInput?: BluetoothNowPlayingSink;
    browserZoneRegistry: BrowserZoneRegistry;
    connectionRegistry: ConnectionRegistry;
    dlnaInput?: DlnaInputService;
    dlnaLineIn?: DlnaLineInService;
    engine: EnginePort;
    lineInActivation: LineInActivationRegistry;
    lineInRegistry: LineInIngestRegistry;
    loxoneProcessor: LoxoneCommandProcessor | null;
    squeezeliteCli: LmsCliServer;
    streamEvents: StreamEvents;
    streamProxyRoutes: StreamProxyRoute[];
    subsonic?: SubsonicApi;
};

export type HttpServiceOptions = ApiSurfaceDeps & AdminSurfaceDeps & TransportSurfaceDeps;

/**
 * Hosts the public HTTP gateway (admin UI, API stub, music streaming, Sendspin).
 */
export class HttpService {
  private readonly log = createLogger('Http');
  private readonly adminApi: AdminApiHandler;
  private readonly music: MusicStreamingHandler;
  private readonly staticFiles: StaticFileHandler;
  private readonly audioStream: AudioStreamHandler;
  private readonly audioProxy: AudioProxyHandler;
  private readonly mediaServer?: MediaServer;
  private readonly subsonic?: SubsonicApi;
  private readonly webdav?: WebdavServer;
  private readonly dlnaInput?: DlnaInputService;
  private readonly dlnaLineIn?: DlnaLineInService;
  private readonly streamProxyRoutes: StreamProxyRoute[];
  private readonly lineInIngestWs: LineInIngestWebSocket;
  private readonly sonnClientApi: SonnClientApiHandler;
  private readonly beoremoteApi: BeoremoteApiHandler;
  private readonly api: ApiHandler;
  private readonly browseService: BrowseService;
  private readonly aboutService: AboutService;
  private readonly destinationService: DestinationService;
  private readonly sendspin: SendspinGateway;
  private readonly snapcast: SnapcastGateway;
  private readonly lmsCli: LmsCliServer;
  // Mutable: the Loxone command engine is attached/detached at runtime when the
  // Loxone integration is connected/disconnected, without restarting this server.
  private loxoneProcessor: LoxoneCommandProcessor | null;
  private readonly connectionRegistry: ConnectionRegistry;
  private readonly zoneManager: ZoneManagerFacade;
  private server?: http.Server;
  private eventsWsServer?: WebSocketServer;

  constructor(
    private readonly config: HttpServerConfig,
    options: HttpServiceOptions,
  ) {
    this.sonnClientApi = new SonnClientApiHandler(
      options.configPort,
      config.port,
      options.lineInActivation,
      options.bluetoothInput,
    );
    this.browseService = new BrowseService(options.contentManager);
    this.aboutService = new AboutService({
      describeItem: (id) => this.browseService.describeItem(id),
      relatedArtists: (id, limit) => this.browseService.relatedArtists(id, limit),
      search: (request) => this.browseService.search(request),
      store: new AboutStore(),
    });
    this.destinationService = new DestinationService(
      options.zoneManager,
      options.browserZoneRegistry,
      config.port,
      (zoneId) => options.resolveOutputProtocol(zoneId),
    );
    this.api = new ApiHandler(
      createApiHandlerDeps(options, {
        browse: this.browseService,
        about: this.aboutService,
        destinations: this.destinationService,
      }),
    );
    this.beoremoteApi = new BeoremoteApiHandler({
      configPort: options.configPort,
      favorites: options.favoritesManager,
      contentManager: options.contentManager,
      zoneManager: options.zoneManager,
      lineIn: options.lineInActivationService,
    });
    this.adminApi = new AdminApiHandler(
      createAdminApiDeps(options, {
        sonnClientApi: this.sonnClientApi,
        beoremoteApi: this.beoremoteApi,
        httpPort: config.port,
      }),
    );
    this.music = new MusicStreamingHandler(config.musicDir);
    this.staticFiles = new StaticFileHandler(config.publicDir);
    this.audioStream = new AudioStreamHandler(
      options.engine,
      options.streamEvents,
      options.audioManager,
      options.zoneAudioPrefs,
    );
    this.audioProxy = new AudioProxyHandler(options.zoneManager);
    this.mediaServer = options.mediaServer;
    this.subsonic = options.subsonic;
    this.webdav = options.webdav;
    this.dlnaInput = options.dlnaInput;
    this.dlnaLineIn = options.dlnaLineIn;
    this.streamProxyRoutes = options.streamProxyRoutes;
    this.lineInIngestWs = new LineInIngestWebSocket(options.lineInRegistry);
    this.sendspin = new SendspinGateway(options.browserZoneRegistry);
    this.snapcast = new SnapcastGateway(options.snapcastCore);
    this.lmsCli = options.squeezeliteCli;
    this.loxoneProcessor = options.loxoneProcessor;
    this.connectionRegistry = options.connectionRegistry;
    this.zoneManager = options.zoneManager;
  }

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('http request failed', { message });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'http-internal-error' }));
        } else {
          res.end();
        }
      });
    });

    /*
     * Outlive the clients that poll us.
     *
     * Node closes an idle keep-alive connection after five seconds, and a Sonn Client posts its
     * status every five — so the two race, and every few minutes a speaker logs a connection reset
     * for a request that then succeeds on its retry. Nothing is broken by it, which is exactly why
     * it is worth removing: a warning that means nothing teaches people to ignore warnings.
     *
     * Sixty-five seconds is the usual figure for a server behind a proxy, and headers must be given
     * longer still or Node cuts the connection while a slow client is mid-request.
     */
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 70_000;

    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });

    // WebSocket endpoint that mirrors the Loxone audio_event broadcast on the
    // main HTTP port so the admin UI can subscribe to live zone state without
    // hitting the separate Loxone WS port (cross-origin).
    this.eventsWsServer = new WebSocketServer({
      httpServer: this.server,
      autoAcceptConnections: false,
    });
    this.eventsWsServer.on('request', (request) => {
      if (request.resourceURL.pathname !== '/audio/events') {
        return;
      }
      const connection = request.accept(null, request.origin);
      this.handleEventsConnection(connection);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!
        .listen(this.config.port, this.config.host, () => {
          this.log.info('http gateway listening', {
            port: this.config.port,
            host: this.config.host,
          });
          resolve();
        })
        .on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      const server = this.server;
      this.server = undefined;
      server.close(() => resolve());
      // Force-drop keep-alive and /audio/events WebSocket connections so close()
      // resolves promptly instead of waiting on idle clients. Without this a soft
      // restart triggered over HTTP would stall on the caller's own still-open
      // socket (and any admin UI events stream); clients simply reconnect after.
      server.closeAllConnections?.();
    });
    this.sendspin.close();
    this.snapcast.close();
  }

  /** Attach or detach the Loxone command engine at runtime. With it attached, the
   *  shared :7090 gateway accepts /audio/... commands; with null it rejects them. */
  public setLoxoneProcessor(processor: LoxoneCommandProcessor | null): void {
    this.loxoneProcessor = processor;
  }

  private handleEventsConnection(connection: WebSocketConnection): void {
    this.connectionRegistry.registerConnection(connection);

    // Send initial snapshot so clients render immediately, without waiting
    // for the next zone-state mutation.
    for (const state of this.zoneManager.getAllZoneStates()) {
      try {
        connection.sendUTF(JSON.stringify({ audio_event: [state] }));
      } catch {
        break;
      }
    }

    connection.on('close', () => this.connectionRegistry.unregisterConnection(connection));
    connection.on('error', () => this.connectionRegistry.unregisterConnection(connection));
  }

  private async handleLoxoneCommand(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = req.url ?? '/';
    const command = url.replace(/^\//, '');
    // Standalone: the Loxone command dialect is disabled on the shared gateway.
    if (!this.loxoneProcessor) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'loxone-disabled' }));
      return;
    }
    try {
      const body = await this.readRequestBody(req);
      const response = await this.loxoneProcessor.execute(command, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(response);
    } catch (err) {
      this.log.warn('loxone command dispatch failed', {
        command,
        message: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'command-failed' }));
    }
  }

  private async readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.applyCors(res);

    const pathname = this.normalizePath(req.url ?? '/');

    // WebDAV owns its own OPTIONS: clients read the DAV/Allow headers from it to
    // decide the mount is writable, and a bare 204 reads as "not a WebDAV share".
    if (req.method === 'OPTIONS' && !this.webdav?.matches(pathname)) {
      res.writeHead(204);
      res.end();
      return;
    }

    /*
     * `/` is a page, not a redirect.
     *
     * It used to 302 into `/admin/?chooser=1`, which handed the question "player or admin?" to one of the
     * two answers: the console had to boot and sign you in before it could ask you where you wanted to be,
     * and the chooser it drew was a whole screen inside a bundle that exists for something else. The
     * question has two links in it, so it is `public/index.html` — one file, no script, served by the
     * server that owns both destinations. Falls through to the static handler below.
     */

    if (pathname === '/sendspin') {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Upgrade Required');
      return;
    }

    if (pathname === '/jsonrpc.js') {
      await this.lmsCli.handleJsonRpcRequest(req, res);
      return;
    }

    if (this.adminApi.matches(pathname)) {
      await this.adminApi.handle(req, res);
      return;
    }

    // Mirror the standard Loxone audio command surface on the main port so
    // browser clients (admin UI) can drive playback via the same routes the
    // Loxone webclient uses (audio/<zoneId>/<command>).
    if (pathname.startsWith('/audio/') || pathname === '/audio') {
      await this.handleLoxoneCommand(req, res);
      return;
    }

    if (this.audioProxy.matches(pathname)) {
      await this.audioProxy.handle(req, res);
      return;
    }

    // Per-provider stream proxies (Tidal/Deezer/Apple Music) registered by the
    // content services. These replace per-service ephemeral http.Servers; they
    // are consumed only by local ffmpeg, so reject non-local clients even though
    // the gateway binds 0.0.0.0.
    for (const route of this.streamProxyRoutes) {
      if (!route.matches(pathname)) {
        continue;
      }
      if (!isLocalRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      try {
        await route.handle(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('stream proxy request failed', { pathname, message });
        if (!res.headersSent) {
          try {
            res.writeHead(500);
          } catch {
            /* ignore */
          }
        }
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // DLNA/UPnP MediaServer: serves the ContentDirectory, description/SCPD XML
    // and the zone-less `/dlna/track/<id>` stream endpoint. LAN-reachable by
    // design (renderers pull from it), so no local-only gate here.
    // Per-zone DLNA MediaRenderer inputs: SOAP control + device/SCPD XML under
    // /dlna-renderer/:zoneId/*. LAN-reachable by design (apps cast to it).
    if (this.dlnaInput?.matches(pathname)) {
      await this.dlnaInput.handle(req, res, pathname);
      return;
    }
    // DLNA line-in renderers, same idea under /dlna-linein/:input/*.
    if (this.dlnaLineIn?.matches(pathname)) {
      await this.dlnaLineIn.handle(req, res, pathname);
      return;
    }

    if (this.mediaServer?.matches(pathname)) {
      await this.mediaServer.handle(req, res, pathname);
      return;
    }

    // Subsonic API: the same content the MediaServer exposes over DLNA, served
    // as an authenticated REST surface at /rest/*. Reachable from anywhere the
    // gateway is, by design — it carries its own credential check.
    if (this.subsonic?.matches(pathname)) {
      await this.subsonic.handle(req, res, pathname);
      return;
    }

    // WebDAV share over the music library, so the folder can be mounted as a
    // network drive. Carries its own Basic-auth check, like Subsonic above.
    if (this.webdav?.matches(pathname)) {
      await this.webdav.handle(req, res, pathname);
      return;
    }

    if (this.audioStream.matches(pathname)) {
      await this.audioStream.handle(req, res, pathname);
      return;
    }

    if (this.sonnClientApi.matches(pathname)) {
      await this.sonnClientApi.handle(req, res, pathname);
      return;
    }

    if (this.beoremoteApi.matches(pathname)) {
      await this.beoremoteApi.handle(req, res, pathname);
      return;
    }

    // The server's own public API. Deliberately last of the /api/* handlers: the
    // device-facing linein and beoremote surfaces claimed their subpaths first.
    if (ApiHandler.owns(pathname)) {
      await this.api.handle(req, res);
      return;
    }

    if (this.music.matches(pathname)) {
      await this.music.handle(req, res, pathname);
      return;
    }

    await this.staticFiles.handle(pathname, res);
  }

  private handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (this.sendspin.handleUpgrade(req, socket, head)) {
      return;
    }
    if (this.snapcast.handleUpgrade(req, socket, head)) {
      return;
    }
    if (this.lineInIngestWs.handleUpgrade(req, socket, head)) {
      return;
    }
    // Let the `WebSocketServer` (attached to the same http.Server for
    // `/audio/events`) handle its own upgrades — its 'upgrade' listener is
    // registered on the same emitter and will fire alongside this one.
    // Destroying the socket here would race with the WS accept handshake.
    const pathname = this.normalizePath(req.url ?? '/');
    if (pathname === '/audio/events') {
      return;
    }
    socket.destroy();
  }

  private applyCors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    );
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-cache');
  }

  private normalizePath(url: string): string {
    const [path] = url.split('?');
    try {
      return decodeURIComponent(path || '/');
    } catch {
      return path || '/';
    }
  }
}
