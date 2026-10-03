import {
  clearAllRecents,
  loadRecents,
  saveRecents,
  type RecentItem,
} from '@/application/zones/recents/recentsStore';
import type { QueueItem } from '@/application/zones/zoneManager';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ContentPort } from '@/ports/ContentPort';
import { detectItemType, detectServiceFromAudiopath, decodeAudiopath, parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import { toLoxoneAudiopath } from '@/domain/zones/bridgeIdentity';
import { bestEffort } from '@/shared/bestEffort';

const MAX_RECENTS = 5;
const MAX_DECODE_DEPTH = 4;
const CANONICAL_RE = /^([^:]+):\/\/([^/]+)\/(.+)$/;
const CLIENT_RECENT_SERVICES = new Set([
  'linein',
  'spotify',
  'soundsuit',
  'library',
  'tunein',
  'custom_stream',
]);
function recentsEqual(next: RecentItem[], previous: RecentItem[]): boolean {
  if (next.length !== previous.length) {
    return false;
  }
  return next.every((item, index) => {
    const other = previous[index];
    if (!other) return false;
    return (
      item.audiopath === other.audiopath &&
      item.coverurl === other.coverurl &&
      item.owner === other.owner &&
      item.owner_id === other.owner_id &&
      item.service === other.service &&
      item.serviceType === other.serviceType &&
      item.title === other.title &&
      item.type === other.type &&
      (item.album ?? '') === (other.album ?? '') &&
      (item.artist ?? '') === (other.artist ?? '')
    );
  });
}

/** What the Loxone client calls a container, and what it calls a single item. */
const RECENT_TYPE_CONTAINER = 7;
const RECENT_TYPE_ITEM = 2;

/**
 * How to read a bridged service's audiopath for the Loxone item type.
 *
 * All of them are reported to the client as `spotify` — that is the disguise
 * the Loxone app understands — so the only thing that differs per service is
 * which word in the path means "this is a container". Four look for an album;
 * SoundCloud has no albums and uses playlists and artists instead.
 *
 * `ytmusic` and `youtube` are absent, as they were before this became a table:
 * their recents fall through to `custom`.
 */
const BRIDGE_RECENT_TYPES: ReadonlyArray<{ service: string; container: RegExp }> = [
  { service: 'applemusic', container: /album/ },
  { service: 'deezer', container: /album/ },
  { service: 'tidal', container: /album/ },
  { service: 'amazonmusic', container: /album/ },
  { service: 'soundcloud', container: /playlist|artist/ },
];

export class RecentsManager {
  private notifier: NotifierPort;
  private readonly recordLocks = new Map<number, Promise<void>>();
  private contentPort: ContentPort;
  // Live zone-state fallback for titles that aren't on the queue item or
  // resolvable as metadata (notably radio/tunein stations, whose name only
  // lives in the now-playing state).
  private zoneStateLookup:
    | ((zoneId: number) => { station?: string; title?: string; name?: string } | undefined)
    | null = null;

  constructor(notifier: NotifierPort, contentPort: ContentPort) {
    this.notifier = notifier;
    this.contentPort = contentPort;
  }

  public setNotifier(notifier: NotifierPort): void {
    this.notifier = notifier;
  }

  public setZoneStateLookup(
    lookup:
      | ((zoneId: number) => { station?: string; title?: string; name?: string } | undefined)
      | null,
  ): void {
    this.zoneStateLookup = lookup;
  }

  public decodeBase64Deep(value: string): string {
    let current = value;
    for (let i = 0; i < MAX_DECODE_DEPTH; i += 1) {
      const decoded = decodeAudiopath(current);
      if (decoded === current) {
        const idx = current.indexOf('b64_');
        if (idx < 0) break;
        const encoded = current.slice(idx + 4);
        try {
          current = current.slice(0, idx) + Buffer.from(encoded, 'base64').toString('utf-8');
        } catch {
          break;
        }
      } else {
        current = decoded;
      }
    }
    return current;
  }

  public toCanonicalAudiopath(value: string): string {
    const decoded = this.decodeBase64Deep(value);
    const canonical = decoded || value;
    const match = CANONICAL_RE.exec(canonical);
    if (match) {
      const [, provider = '', type = '', rest = ''] = match;
      const restMatch = CANONICAL_RE.exec(rest);
      if (restMatch) {
        const [, innerProvider = '', innerType = '', innerRest = ''] = restMatch;
        // Nested provider (e.g., spotify@bridge...:track:library://track/1234) — use inner for canonical key
        return `${innerProvider}:${innerType}:${innerRest}`;
      }
      if (rest.startsWith('library://')) {
        const [, innerType = 'track', innerRest = ''] = /^library:\/\/([^/]+)\/(.+)$/.exec(rest) || [];
        return `library:${innerType}:${innerRest || rest.replace(/^library:\/\//, '')}`;
      }
      return `${provider}:${type}:${rest}`;
    }
    return canonical;
  }

  public dedupeByCanonical(items: RecentItem[]): RecentItem[] {
    const seen = new Set<string>();
    const result: RecentItem[] = [];
    for (const item of items) {
      const key = this.toCanonicalAudiopath(item.audiopath);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  public async get(zoneId: number) {
    const stored = await loadRecents(zoneId);
    return {
      ...stored,
      items: stored.items.map((item) => this.normalizeForClient(item)),
    };
  }

  public async record(zoneId: number, item: QueueItem): Promise<void> {
    const previous = this.recordLocks.get(zoneId) ?? Promise.resolve();
    // Best-effort lock chain; avoid deadlock if a prior record failed.
    const next = bestEffort(() => previous, { fallback: undefined }).then(async () => {
      await this.performRecord(zoneId, item);
    });
    this.recordLocks.set(zoneId, next.finally(() => {
      if (this.recordLocks.get(zoneId) === next) {
        this.recordLocks.delete(zoneId);
      }
    }));
    return next;
  }

  public async performRecord(zoneId: number, item: QueueItem): Promise<void> {
    const storedRaw = await loadRecents(zoneId);
    const dedupedItems = this.dedupeByCanonical(storedRaw.items ?? []);
    const stored = { ...storedRaw, items: dedupedItems };
    if (dedupedItems.length !== (storedRaw.items ?? []).length) {
      // Clean up old duplicates eagerly.
      const ts = Math.floor(Date.now() / 1000);
      await saveRecents(zoneId, { ts, items: dedupedItems });
    }
    const service = this.resolveService(item.audiopath, item.user);
    const defaultSpotifyUser = this.contentPort.getDefaultSpotifyAccountId();
    const userForSpotify =
      service.service === 'spotify' && item.user && item.user !== 'nouser'
        ? item.user
        : service.service === 'spotify'
          ? defaultSpotifyUser ?? item.user ?? 'nouser'
          : item.user ?? 'nouser';
    // `service.service` is the Loxone answer: it reports every bridged service as `spotify`,
    // so it cannot decide whether this path wants a Spotify account glued in front of it.
    // The path itself can. Without this an Apple Music track was stored as
    // `spotify@applemusic:applemusic:track:…` — the account slot filled with a service name and
    // the real path repeated behind it, which is the doubled form other readers work around.
    const nativePath = parseServiceNativeAudiopath(item.audiopath);
    const wantsSpotifyAccount = !nativePath || nativePath.service === 'spotify';
    const rawAudiopath =
      service.service === 'spotify' &&
      userForSpotify &&
      wantsSpotifyAccount &&
      !item.audiopath.startsWith('spotify@')
        ? `spotify@${userForSpotify}:${item.audiopath.replace(/^spotify:/i, '')}`
        : item.audiopath;
    const audiopath = this.normalizeRecentAudiopath(
      this.normalizeAppleMusicAudiopath(rawAudiopath),
      service.service,
    );
    const canonicalAudiopath = this.toCanonicalAudiopath(audiopath);
    // Best-effort metadata lookup; missing metadata should not block recents.
    let meta = await bestEffort(() => this.contentPort.resolveMetadata(canonicalAudiopath), {
      fallback: null,
    });
    if (!meta) {
      const decoded = decodeAudiopath(canonicalAudiopath);
      if (decoded && decoded !== canonicalAudiopath) {
        meta = await bestEffort(() => this.contentPort.resolveMetadata(decoded), { fallback: null });
      }
    }
    const matchesAudiopath = (candidate: RecentItem): boolean => {
      const candidateCanonical = this.toCanonicalAudiopath(candidate.audiopath);
      return candidateCanonical === canonicalAudiopath;
    };
    const existing = stored.items.find((existingItem) => matchesAudiopath(existingItem));
    const merged = (field: keyof typeof entry): any => {
      const candidate = entry[field];
      if (candidate !== undefined && candidate !== '') return candidate;
      const fallbackExisting = existing?.[field];
      if (fallbackExisting !== undefined && fallbackExisting !== '') return fallbackExisting;
      return undefined;
    };

    const metaTitle = (meta?.title ?? '').trim();
    const safeTitle = (() => {
      if (metaTitle) return metaTitle;
      const candidate = (item.title ?? '').trim();
      if (candidate) return candidate;
      // Radio/tunein stations carry their name in `station` (on the queue item)
      // or only in the now-playing state — never in title/metadata.
      const station = (item.station ?? '').trim();
      if (station) return station;
      const live = this.zoneStateLookup?.(zoneId);
      const liveStation = (live?.station ?? '').trim();
      if (liveStation) return liveStation;
      // The live title is a last resort for stations, which carry their name nowhere else.
      // But it can be the *zone's* name: the state guard replaces a title that looks like a
      // raw audiopath with the zone name so the Loxone app never shows an id, and a local
      // track with no tags hits that path — which is how "Audio Player 1" ended up stored as
      // a song title. A title equal to the zone name is that guard, not a name.
      const liveTitle = (live?.title ?? '').trim();
      const zoneName = (live?.name ?? '').trim();
      if (liveTitle && liveTitle === zoneName) return '';
      return liveTitle;
    })();
    const ownerBase =
      service.service === 'musicassistant'
        ? 'musicassistant'
        : userForSpotify ?? item.artist ?? meta?.artist ?? '';
    const preferredAudiopath = existing?.audiopath ?? audiopath;
    const entry = {
      audiopath: preferredAudiopath,
      coverurl: item.coverurl ?? meta?.coverurl ?? '',
      owner: ownerBase,
      owner_id: ownerBase,
      service: service.service,
      serviceType: service.serviceType,
      title: safeTitle && !safeTitle.toLowerCase().startsWith('spotify:') && !safeTitle.toLowerCase().startsWith('spotify@')
        ? safeTitle
        : '',
      type: service.type,
      album: item.album ?? meta?.album ?? '',
      artist: item.artist ?? meta?.artist ?? '',
    };

    // Merge with existing entry to avoid wiping metadata when replaying an old recent.
    const mergedEntry = {
      ...existing,
      ...entry,
      coverurl: merged('coverurl') ?? '',
      title: merged('title') ?? '',
      album: merged('album') ?? '',
      artist: merged('artist') ?? '',
      owner: merged('owner') ?? '',
      owner_id: merged('owner_id') ?? '',
    };

    const filtered = stored.items.filter((existingItem) => !matchesAudiopath(existingItem));
    const dedupedNew = this.dedupeByCanonical([mergedEntry, ...filtered]);
    const items = dedupedNew.slice(0, MAX_RECENTS);
    // Avoid rewriting storage or emitting websocket events when nothing changed.
    if (recentsEqual(items, stored.items)) {
      return;
    }
    const ts = Math.floor(Date.now() / 1000);
    await saveRecents(zoneId, { ts, items });
    this.notifier.notifyRecentlyPlayedChanged(zoneId, ts);
  }

  public resolveService(
    audiopath: string,
    _user?: string,
  ): { service: string; serviceType: number; type: number } {
    const lower = (audiopath || '').toLowerCase();
    if (lower.includes('musicassistant')) {
      const loxType = detectItemType(audiopath, 'musicassistant');
      const type = loxType === 'musicassistant_album' ? 7 : 2;
      // Expose as spotify for Loxone compatibility, but keep type from MA.
      return { service: 'spotify', serviceType: 3, type };
    }
    const detectedService = detectServiceFromAudiopath(audiopath);
    if (lower.startsWith('linein:')) {
      return { service: 'linein', serviceType: 99, type: 6 };
    }
    if (detectedService === 'musicassistant') {
      const loxType = detectItemType(audiopath, 'musicassistant');
      const type = loxType === 'musicassistant_album' ? 7 : 2;
      return { service: 'musicassistant', serviceType: 3, type };
    }
    if (detectedService === 'library') {
      return { service: 'library', serviceType: 2, type: 2 };
    }
    if (detectedService === 'radio') {
      const lower = (audiopath || '').toLowerCase();
      const service = lower.startsWith('tunein:') ? 'tunein' : 'custom_stream';
      return { service, serviceType: 3, type: 3 };
    }
    if (detectedService === 'spotify' || lower.startsWith('spotify:') || lower.startsWith('spotify@')) {
      const type = lower.includes(':album:') ? 7 : 2;
      return { service: 'spotify', serviceType: 3, type };
    }
    const bridged = BRIDGE_RECENT_TYPES.find((entry) => entry.service === detectedService);
    if (bridged) {
      return {
        service: 'spotify',
        serviceType: 3,
        type: bridged.container.test(lower) ? RECENT_TYPE_CONTAINER : RECENT_TYPE_ITEM,
      };
    }
    return { service: 'custom', serviceType: 3, type: 3 };
  }

  public normalizeAppleMusicAudiopath(audiopath: string): string {
    const detectedService = detectServiceFromAudiopath(audiopath);
    if (detectedService !== 'applemusic') {
      return audiopath;
    }
    return audiopath.replace(/:library-track:/i, ':track:');
  }

  private normalizeForClient(item: RecentItem): RecentItem {
    const normalizedService = this.normalizeRecentService(item.service, item.audiopath);
    // The Loxone envelope goes back on here, and it is not decoration: the client derives the
    // item's serviceId from the audiopath with `audiopath.replace(/spotify@(.*?):.*/, '$1')`
    // (comps.js, PreProcessingSpotifyItemScheme). A service-native path does not match that
    // regex, so `replace` returns the whole path and the serviceId becomes the audiopath —
    // which is then what comes back on the play command. Storage stays service-native; only
    // this one payload speaks Loxone, the same as the queue and state emitters.
    const audiopath = this.normalizeRecentAudiopath(
      toLoxoneAudiopath(item.audiopath, this.contentPort.getBridgeRegistry()),
      normalizedService,
    );
    const name = item.name || item.title || '';
    // The native client's recently-played schema is a strict discriminated union
    // (one bad item drops the whole list). Mirror the browse/search item shape it
    // already accepts: a `tag` (track/album/artist/playlist/show/episode) for
    // service/library items, `thumbnail`/`id`, and a station shape for radio.
    const p = (item.audiopath || '').toLowerCase();
    const isRadio = /^https?:\/\//.test(p) || p.startsWith('tunein:') || /(?:tunein|radio)/.test(p);
    const base: RecentItem = {
      ...item,
      name,
      service: normalizedService,
      audiopath,
      id: item.id ?? audiopath,
      thumbnail: item.thumbnail || item.coverurl || '',
    };
    if (isRadio) {
      // Playable radio station: type File + station name + the "Playlists" content marker.
      return { ...base, type: 2, station: item.station || name, contentType: 'Playlists' };
    }
    const tag =
      /(?:^|[:-])(?:library-)?album:/.test(p) ? 'album'
      : /(?:^|[:-])(?:library-)?artist:/.test(p) ? 'artist'
      : /(?:^|[:-])(?:library-)?playlist:/.test(p) ? 'playlist'
      : /(?:^|[:-])show:/.test(p) ? 'show'
      : /(?:^|[:-])episode:/.test(p) ? 'episode'
      : /(?:^|[:-])(?:library-)?track:/.test(p) ? 'track'
      : undefined;
    return tag ? { ...base, tag } : base;
  }

  private normalizeRecentService(service: string, audiopath: string): string {
    if (CLIENT_RECENT_SERVICES.has(service)) {
      return service;
    }
    const lower = (audiopath || '').toLowerCase();
    if (lower.startsWith('linein:')) {
      return 'linein';
    }
    if (lower.includes('soundsuit:')) {
      return 'soundsuit';
    }
    if (lower.startsWith('spotify:') || lower.startsWith('spotify@') || service === 'musicassistant') {
      return 'spotify';
    }
    if (lower.startsWith('tunein:')) {
      return 'tunein';
    }
    if (/^https?:\/\//.test(lower) || /(tunein|radio)/.test(lower)) {
      return 'custom_stream';
    }
    return 'library';
  }

  private normalizeRecentAudiopath(audiopath: string, service: string): string {
    if (!audiopath) {
      return audiopath;
    }
    if (service === 'library' && audiopath.startsWith('library://local/')) {
      const encoded = Buffer.from(audiopath, 'utf8').toString('base64');
      return `library:local:track:b64_${encoded}`;
    }
    return audiopath;
  }

  public async clearAll(): Promise<void> {
    await clearAllRecents();
  }

  public async clear(zoneId: number): Promise<void> {
    const ts = Math.floor(Date.now() / 1000);
    await saveRecents(zoneId, { ts, items: [] });
    this.notifier.notifyRecentlyPlayedChanged(zoneId, ts);
  }
}

type RecentsManagerDeps = {
  notifier: NotifierPort;
  contentPort: ContentPort;
};

export function createRecentsManager(deps: RecentsManagerDeps): RecentsManager {
  return new RecentsManager(deps.notifier, deps.contentPort);
}
