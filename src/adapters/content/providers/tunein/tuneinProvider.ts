import { createLogger } from '@/shared/logging/logger';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type {
  ContentFolder,
  ContentFolderItem,
  RadioMenuEntry,
  RadioStation,
} from '@/ports/ContentTypes';
import { TuneInClient } from '@/adapters/content/providers/tunein/tuneinClient';
import { expandPresetOutlines } from '@/adapters/content/providers/tunein/tuneinPresets';
import { resizeTuneInCoverUrl, COVER_ART_BROWSE_SIZE } from '@/shared/coverArt';

const DEFAULT_ICON =
  'https://extended-app-content.s3.eu-central-1.amazonaws.com/audioZone/services/Icon-TuneIn.svg';

const log = createLogger('Content', 'TuneIn');

export interface TuneInProviderOptions {
  username?: string;
}

/**
 * Unified provider that exposes TuneIn favourites under the `local` entry
 * and keeps the legacy `custom` list for manually defined streams.
 */
export class TuneInProvider {
  private readonly username?: string;
  private readonly api = new TuneInClient();
  private readonly searchCache = new Map<string, { station: RadioStation; seenAt: number }>();
  private readonly searchCacheTtlMs = 30 * 60 * 1000;
  private readonly searchCacheMaxSize = 200;
  private readonly tuneCache = new Map<
    string,
    { url: string | null; fetchedAt: number; inFlight?: Promise<string | null> }
  >();

  private readonly tuneCacheTtlMs = 60 * 60 * 1000;
  private localStationsCache: { items: RadioStation[]; fetchedAt: number; inFlight?: Promise<RadioStation[]> } | null = null;
  private readonly customRadioStore: CustomRadioStore;

  constructor(customRadioStore: CustomRadioStore, options: TuneInProviderOptions = {}) {
    this.customRadioStore = customRadioStore;
    this.username = options.username?.trim();
  }

  /**
   * Resolve a station by its stream URL (checks custom + local presets).
   */
  public async resolveStationByStream(streamUrl: string): Promise<RadioStation | null> {
    const normalized = this.normalizeStreamUrl(streamUrl);
    if (!normalized) return null;
    const cached = this.searchCache.get(normalized);
    if (cached) {
      if (Date.now() - cached.seenAt <= this.searchCacheTtlMs) {
        return cached.station;
      }
      this.searchCache.delete(normalized);
    }
    const stations = [
      ...(await this.getCustomStations()),
      ...(await this.getLocalStations()),
    ];
    const match = stations.find(
      (s) => this.normalizeStreamUrl(s.stream) === normalized,
    );
    return match ?? null;
  }

  public async getMenuEntries(): Promise<RadioMenuEntry[]> {
    return [
      {
        cmd: 'local',
        icon: DEFAULT_ICON,
        name: 'TuneIn Presets',
        root: 'start',
      },
      {
        cmd: 'custom',
        icon: DEFAULT_ICON,
        name: 'Custom Streams',
        root: 'start',
        editable: true,
      },
    ];
  }

  public async getFolder(
    service: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    if (folderId !== 'start') {
      return null;
    }

    const stations =
      service === 'custom' ? await this.getCustomStations() : await this.getLocalStations();
    const items = this.mapStationsToItems(stations, offset, limit);

    return {
      id: folderId,
      name: service === 'custom' ? 'Custom Radio' : 'TuneIn Presets',
      start: offset,
      totalitems: stations.length,
      items,
    };
  }

  public async search(
    query: string,
    limits: { station?: number; custom?: number } = {},
  ): Promise<{ station: ContentFolderItem[]; custom: ContentFolderItem[] }> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return { station: [], custom: [] };
    }
    const stationLimit = limits.station ?? 50;
    const customLimit = limits.custom ?? 50;

    let outlines: unknown[] = [];
    try {
      outlines = await this.api.search(normalizedQuery, this.username);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('tunein search failed', { message, query: normalizedQuery });
    }

    // Avoid resolving streams for an unbounded number of outlines.
    // Overfetch a bit because some entries are filtered out as unavailable/non-audio.
    const outlineCap = Math.max(25, stationLimit * 3);
    const stations = await this.mapTuneInItems(outlines.slice(0, outlineCap));
    this.cacheStations(stations);
    const stationItems = stations
      .slice(0, stationLimit)
      .map<ContentFolderItem>((station) => this.toSearchItem(station));

    const customStations = await this.getCustomStations();
    this.cacheStations(customStations);
    const filteredCustom = customStations.filter((s) =>
      s.name.toLowerCase().includes(normalizedQuery.toLowerCase()),
    );
    const customItems = filteredCustom
      .slice(0, customLimit)
      .map<ContentFolderItem>((station) => this.toSearchItem(station));

    return { station: stationItems, custom: customItems };
  }

  private async getLocalStations(): Promise<RadioStation[]> {
    const username = this.username;
    // Without an account there are no presets to show. The list used to fall
    // back to a few hard-coded stations nobody had chosen and nobody could
    // remove, one of which no longer even streamed (issue #427).
    if (!username) {
      return [];
    }

    const cached = this.localStationsCache;
    if (cached && Date.now() - cached.fetchedAt <= this.searchCacheTtlMs) {
      return cached.items;
    }
    if (cached?.inFlight) {
      return cached.inFlight;
    }

    const inFlight: Promise<RadioStation[]> = (async () => {
      try {
        const { outlines } = await this.api.browsePresets(username);
        const expanded = await expandPresetOutlines(this.api, outlines, username, (id, message) =>
          log.debug('tunein preset folder failed', { id, message }),
        );
        const items = await this.mapTuneInItems(expanded);
        // An account with a name TuneIn knows keeps whatever it has, empty included.
        // Substituting the demo list here is what made a configured-but-unparsed
        // account indistinguishable from an unconfigured one (issue #362).
        this.localStationsCache = { items, fetchedAt: Date.now() };
        return items;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('failed to load TuneIn presets', { message });
        // Leave the previous entry (or nothing) in place rather than caching the
        // failure: a hiccup must not hold the list empty for the rest of the TTL.
        this.localStationsCache = cached ?? null;
        return cached?.items ?? [];
      }
    })();

    this.localStationsCache = {
      items: cached?.items ?? [],
      fetchedAt: cached?.fetchedAt ?? 0,
      inFlight,
    };
    return inFlight;
  }

  private async getCustomStations(): Promise<RadioStation[]> {
    const entries = await this.customRadioStore.list();
    return entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      stream: entry.stream,
      coverurl: entry.coverurl ?? DEFAULT_ICON,
    }));
  }

  private isDirectStreamUrl(url: string | undefined): boolean {
    const raw = (url ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) return false;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      // TuneIn uses radiotime endpoints that require a Tune call to resolve to the real stream.
      if (host.endsWith('radiotime.com')) return false;
      if (host.endsWith('tunein.com')) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async resolveStreamUrlCached(id: string, fallback?: string): Promise<string | null> {
    if (this.isDirectStreamUrl(fallback)) {
      return fallback ?? null;
    }

    const cached = this.tuneCache.get(id);
    if (cached && Date.now() - cached.fetchedAt <= this.tuneCacheTtlMs) {
      return cached.url ?? fallback ?? null;
    }
    if (cached?.inFlight) {
      const url = await cached.inFlight;
      return url ?? fallback ?? null;
    }

    const state = cached ?? { url: null, fetchedAt: 0 };
    state.inFlight = (async () => {
      try {
        const outlines = await this.api.tune(id);
        const match = outlines.find((entry) => entry && typeof (entry as { url?: unknown }).url === 'string') as
          | { url?: string }
          | undefined;
        const resolved = match?.url ?? null;
        state.url = resolved;
        state.fetchedAt = Date.now();
        return resolved;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.debug('tunein tune failed', { id, message });
        state.url = null;
        state.fetchedAt = Date.now();
        return null;
      } finally {
        state.inFlight = undefined;
      }
    })();

    this.tuneCache.set(id, state);
    const url = await state.inFlight;
    return url ?? fallback ?? null;
  }

  private async mapTuneInItems(outlines: unknown[]): Promise<RadioStation[]> {
    const concurrency = 8;
    const out: Array<RadioStation | null> = [];
    for (let i = 0; i < outlines.length; i += concurrency) {
      const batch = outlines.slice(i, i + concurrency);
      const resolved = await Promise.all(batch.map((raw) => this.mapTuneInItem(raw)));
      out.push(...resolved);
    }
    return out.filter((station): station is RadioStation => Boolean(station));
  }

  private async mapTuneInItem(raw: unknown): Promise<RadioStation | null> {
    const item = raw as {
      type?: string;
      preset_id?: string;
      guide_id?: string;
      URL?: string;
      text?: string;
      image?: string;
      playing_image?: string;
      key?: string;
    };

    if (!item || item.type !== 'audio' || item.key === 'unavailable') {
      return null;
    }

    const id = item.preset_id ?? item.guide_id;
    if (!id) {
      return null;
    }

    const stream = await this.resolveStreamUrlCached(id, item.URL);
    if (!stream) {
      return null;
    }

    let coverurl = item.image ?? item.playing_image;
    if (coverurl) {
      coverurl = resizeTuneInCoverUrl(coverurl, COVER_ART_BROWSE_SIZE);
    } else {
      coverurl = DEFAULT_ICON;
    }

    let name = item.text;
    if (name) {
      name = name.replace(/^(?:\d+\.\d+ \| )?(.+?)(?: \([^)]+\))?$/, '$1'); // removes frequency and genre if present in name
      name = this.repairUtf8Mojibake(name);
    } else {
      name = 'Unknown station';
    }

    return {
      id,
      name,
      stream,
      coverurl,
    } satisfies RadioStation;
  }

  /** TuneIn occasionally returns UTF-8 bytes decoded as Latin-1 (e.g. BublÃ©). */
  private repairUtf8Mojibake(value: string): string {
    if (!/[ÃÂâð]/.test(value)) return value;
    try {
      const repaired = Buffer.from(value, 'latin1').toString('utf8');
      return repaired.includes('\uFFFD') ? value : repaired;
    } catch {
      return value;
    }
  }

  private normalizeStreamUrl(streamUrl: string | undefined): string {
    const raw = streamUrl?.trim().toLowerCase();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      url.hash = '';
      // Keep the query string: many shared stream URLs (e.g. BBC HLS
      // aggregators) differ only by a query parameter such as
      // `?station=bbc_radio_one`. Dropping it collapsed distinct custom
      // streams onto the same key, so every favourite resolved to the
      // first matching station (see issue #282).
      const normalized = url.toString().replace(/\/$/, '');
      return normalized;
    } catch {
      return raw.replace(/\/$/, '');
    }
  }

  private cacheStations(stations: RadioStation[]): void {
    if (!stations.length) return;
    const now = Date.now();
    for (const station of stations) {
      const key = this.normalizeStreamUrl(station.stream);
      if (!key) continue;
      this.searchCache.set(key, { station, seenAt: now });
    }
    if (this.searchCache.size <= this.searchCacheMaxSize) {
      return;
    }
    let oldestKey: string | null = null;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [key, value] of this.searchCache.entries()) {
      if (value.seenAt < oldestSeenAt) {
        oldestSeenAt = value.seenAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.searchCache.delete(oldestKey);
    }
  }

  private mapStationsToItems(
    stations: RadioStation[],
    offset: number,
    limit: number,
  ): ContentFolderItem[] {
    return stations.slice(offset, offset + limit).map<ContentFolderItem>((station) => ({
      id: station.id,
      name: station.name,
      title: station.name,
      kind: 'radio',
      tag: 'radio',
      audiopath: station.stream,
      coverurl: station.coverurl ?? DEFAULT_ICON,
      items: 0,
    }));
  }

  private toSearchItem(station: RadioStation): ContentFolderItem {
    const cover = station.coverurl ?? DEFAULT_ICON;
    return {
      id: station.id,
      name: station.name,
      title: station.name,
      audiopath: station.stream,
      coverurl: cover,
      thumbnail: cover,
      kind: 'radio',
      tag: 'radio',
      provider: 'tunein',
      items: 0,
      // Keep a "station" field similar to legacy payloads so clients can show the stream URL.
      ...(station.stream ? { station: station.stream } : {}),
      contentType: 'audio/mpeg',
    } as ContentFolderItem;
  }
}
