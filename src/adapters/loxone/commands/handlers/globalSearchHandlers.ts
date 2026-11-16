import { ProviderUnavailableError } from '@/adapters/content/providerUnavailable';
import { buildResponse } from '@/adapters/loxone/commands/responses';
import {
  forLoxoneSearchResult,
  forLoxoneServiceSearchResult,
} from '@/adapters/loxone/commands/utils/loxoneItems';
import { splitCommand, decodeSegment, parseNumberPart } from '@/adapters/loxone/commands/utils/commandUtils';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';

export function createGlobalSearchHandlers(contentManager: ContentManager, notifier: LoxoneWsNotifier) {
  // A search that comes back empty because the account was signed out looks like a search
  // with no hits. The app can be told the difference.
  const reportRefusal = (error: unknown, account: string): void => {
    if (error instanceof ProviderUnavailableError && (error.reason === 'auth' || error.reason === 'denied')) {
      notifier.notifyServiceRefused(account, error.reason);
    }
  };
  /** The account in a search source such as `spotify@<account>:track#5,album#5`. */
  const accountOfSource = (source: string): string => /@([^:]+)/.exec(source)?.[1] ?? '';
  return {
    audioCfgGlobalSearchDescribe: async (command: string) => {
      const desc = contentManager.getGlobalSearchDescription();
      return buildResponse(command, 'globalsearch', desc ?? {});
    },
    audioCfgGlobalSearch: async (command: string) => {
      const parts = splitCommand(command);
      const source = decodeSegment(parts[3] ?? '');
      const query = decodeSegment(parts.slice(4).join('/'));
      const unique = `gs-${Date.now()}`;

      // Always return immediately with the unique token.
      const immediate = buildResponse(command, 'globalsearch', { unique });

      if (!source || !query) {
        notifier.notifyGlobalSearchError(source, unique);
        return immediate;
      }

      (async () => {
        try {
          const { result, user, providerId } = await contentManager.globalSearch(source, query);
          const provider = (providerId || source.split('@')[0] || 'spotify').split('@')[0] ?? 'spotify';
          // The library and the radio have row schemas of their own; everything else reaches
          // the app as a streaming service and has to fit its service rows.
          const isOwnSchema = ['local', 'library', 'tunein', 'radio'].includes(provider.toLowerCase());
          notifier.notifyGlobalSearchResult(
            {
              ...(isOwnSchema ? forLoxoneSearchResult(result) : forLoxoneServiceSearchResult(result)),
              user,
              query,
            },
            provider,
            unique,
          );
        } catch (error) {
          notifier.notifyGlobalSearchError(source, unique);
          reportRefusal(error, accountOfSource(source));
        }
      })();

      return immediate;
    },
    /**
     * `audio/cfg/search/<service>/<user>/<tag>/<query>/<start>/<count>` — one category of a
     * search, paged. This is what the app sends when a category of a global search is opened
     * in full: it takes the `link` we put on that category, keeps its first four segments and
     * appends its own start and count.
     *
     * Unlike the global search this one is answered in place. The app reads
     * `search_result[0].results[0]` and tells the three kinds of result apart by `where`.
     */
    audioCfgSearch: async (command: string) => {
      const parts = splitCommand(command);
      const service = decodeSegment(parts[3] ?? '').toLowerCase();
      const user = decodeSegment(parts[4] ?? '') || 'nouser';
      const tag = decodeSegment(parts[5] ?? '').toLowerCase();
      // The query is the one segment that may itself hold a slash; the two numbers close the path.
      const query = decodeSegment(parts.slice(6, -2).join('/'));
      const start = parseNumberPart(parts[parts.length - 2], 0);
      const count = parseNumberPart(parts[parts.length - 1], 50) || 50;

      const isLocal = service === 'local' || service === 'library';
      const isRadio = service === 'radio' || service === 'tunein';
      const where = isLocal ? 'local' : isRadio ? 'radio' : 'spotify';
      const reply = (items: unknown[], totalitems: number, replyUser: string) =>
        buildResponse(command, 'search', [
          { results: [{ where, user: replyUser, tag, offset: start, limit: count, totalitems, items }] },
        ]);
      const fallbackUser = isLocal ? 'local' : user;
      if (!service || !tag || !query) {
        return reply([], 0, fallbackUser);
      }

      // Search has no offset of its own: ask for everything up to the end of this page and
      // cut the page out of it.
      const wanted = start + count;
      const account = isLocal ? 'local' : isRadio ? 'tunein' : `${service}@${user}`;
      try {
        const found = await contentManager.globalSearch(`${account}:${tag}#${wanted}`, query);
        const result = (
          where === 'spotify' ? forLoxoneServiceSearchResult(found.result) : forLoxoneSearchResult(found.result)
        ) as Record<string, unknown>;
        const rows = result[`${tag}s`] ?? result[tag];
        const all = Array.isArray(rows) ? rows : [];
        const totals = (found.result as { _totals?: Record<string, number> })._totals;
        // A full answer may have more behind it; a short one is the end of the list. Saying
        // "one more page" on a full answer is what keeps the app asking, and the next answer
        // settles it.
        const total = totals?.[`${tag}s`] ?? (all.length >= wanted ? wanted + count : all.length);
        return reply(all.slice(start, wanted), Math.max(total, all.length), isLocal ? 'local' : found.user || user);
      } catch (error) {
        reportRefusal(error, user);
        return reply([], 0, fallbackUser);
      }
    },
  };
}
