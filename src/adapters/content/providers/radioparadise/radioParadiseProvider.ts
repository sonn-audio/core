import type { ContentFolder, ContentFolderItem, RadioMenuEntry } from '@/ports/ContentTypes';
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

  /**
   * The station a `radioparadise:<id>` audiopath names, with its catalogue logo: what a queue row
   * or a recent needs and the per-track lookups never had (#449).
   */
  public stationMetadata(audiopath: string): { name: string; coverurl: string } | null {
    const id = /^radioparadise:(?:\/\/)?([^/?#]+)/i.exec(audiopath.trim())?.[1]?.toLowerCase();
    const station = id ? RADIO_PARADISE_STATIONS.find((entry) => entry.id === id) : undefined;
    return station ? { name: station.name, coverurl: buildRadioParadiseIconUrl(station.icon, this.iconBaseUrl) } : null;
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
