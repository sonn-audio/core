import type { ContentFolder, ContentFolderItem, RadioMenuEntry } from '@/ports/ContentTypes';
import type { RadioParadiseStation } from '@/domain/radioparadise/stations';
import {
  RADIO_PARADISE_ICON_BASE_URL,
  RADIO_PARADISE_STATIONS,
  buildRadioParadiseIconUrl,
} from '@/adapters/content/providers/radioparadise/radioParadiseConstants';

const PROVIDER_ID = 'radioparadise';

type RadioParadiseProviderOptions = {
  iconBaseUrl?: string;
};

export class RadioParadiseProvider {
  private readonly iconBaseUrl: string;

  constructor(options: RadioParadiseProviderOptions = {}) {
    this.iconBaseUrl = options.iconBaseUrl?.trim() || RADIO_PARADISE_ICON_BASE_URL;
  }

  public getMenuEntry(): RadioMenuEntry {
    return {
      cmd: 'radioparadise',
      name: 'Radio Paradise',
      icon: buildRadioParadiseIconUrl('radioparadise-logo-main.png', this.iconBaseUrl),
      root: 'start',
      description: 'Human-curated, listener-supported radio streams.',
    };
  }

  /**
   * The station a `radioparadise:<id>` audiopath names. The path may carry the
   * `radioparadise://` form or query/hash suffixes the clients append; only the
   * id before the first separator is significant.
   */
  public resolveStationFromAudiopath(audiopath: string): RadioParadiseStation | null {
    const raw = (audiopath ?? '').trim();
    if (!raw) return null;
    const match = /^radioparadise:(?:\/\/)?(.+)$/i.exec(raw);
    if (!match || !match[1]) return null;
    const stationId = match[1].split(/[/?#]/)[0]?.trim().toLowerCase();
    if (!stationId) return null;
    return RADIO_PARADISE_STATIONS.find((station) => station.id === stationId) ?? null;
  }

  /**
   * The catalogue icon on the artwork origin every client-facing image uses.
   * That origin is the one cbd326c7 fixed for the HTTPS Web UI, so the queue and
   * Recently Played receive exactly the URL the browse row already has.
   */
  public stationCoverUrl(station: RadioParadiseStation): string {
    return buildRadioParadiseIconUrl(station.icon, this.iconBaseUrl);
  }

  public async getFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    if (folderId !== 'start') {
      return null;
    }

    const items = this.mapStations(offset, limit);

    return {
      id: folderId,
      name: 'Radio Paradise',
      start: offset,
      totalitems: RADIO_PARADISE_STATIONS.length,
      items,
    };
  }

  private mapStations(offset: number, limit: number): ContentFolderItem[] {
    return RADIO_PARADISE_STATIONS.slice(offset, offset + limit).map((station) => {
      const cover = buildRadioParadiseIconUrl(station.icon, this.iconBaseUrl);
      return {
        id: station.id,
        name: station.name,
        title: station.name,
        kind: 'radio',
        audiopath: `radioparadise:${station.id}`,
        coverurl: cover,
        thumbnail: cover,
        tag: 'radio',
        provider: PROVIDER_ID,
        items: 0,
      } satisfies ContentFolderItem;
    });
  }
}
