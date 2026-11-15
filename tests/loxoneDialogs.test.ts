import assert from 'node:assert/strict';
import { z } from 'zod';
import { test } from './testHarness';
import {
  DialogThrottle,
  PLAYBACK_FAILED_QUIET_MS,
  SERVICE_REFUSED_QUIET_MS,
  explainPlaybackFailure,
  playbackFailedDialog,
  serviceRefusedDialog,
} from '../src/adapters/loxone/ws/dialogs';
import {
  PLAYBACK_ERROR_EXPLAINS_FOR_MS,
  recentPlaybackErrorReason,
  serviceRefusalOf,
} from '../src/application/zones/playback/playbackFailure';
import { createGlobalSearchHandlers } from '../src/adapters/loxone/commands/handlers/globalSearchHandlers';
import { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';
import { createProviderHandlers } from '../src/adapters/loxone/commands/handlers/providerHandlers';
import { ProviderUnavailableError } from '../src/adapters/content/providerUnavailable';

// Pop-ups in the Loxone app: a service that signed the listener out, and music that will not
// start. Two things the app cannot show any other way, and that only the listener can fix.

/**
 * `dialogEventSchema` (AppHub.js module 100846), transcribed. Every field without `.optional()`
 * is required, and the envelope drops a frame in which one is missing.
 */
const dialogButtonSchema = z.object({
  title: z.string(),
  command: z.string().optional(),
  color: z.string().optional(),
  link: z.string().optional(),
});
const dialogEventSchema = z.object({
  ID: z.string(),
  buttons: z.array(dialogButtonSchema),
  cancelbtn: dialogButtonSchema.optional(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  message: z.string(),
  messagetype: z.string(),
  state: z.string(),
  title: z.string(),
  ttl: z.number(),
});
const dialogFrameSchema = z.object({ dialog_event: z.array(dialogEventSchema).min(1) }).strict();

function notifier(now: { at: number } = { at: 1_000_000 }) {
  const frames: Array<Record<string, any>> = [];
  const registry = { broadcastMessage: (frame: string) => frames.push(JSON.parse(frame)) };
  const ws = new LoxoneWsNotifier(registry as any, { getGroupByZone: () => undefined } as any);
  // The throttle reads the clock through this, so a test can move it.
  (ws as any).dialogThrottle = new DialogThrottle(() => now.at);
  ws.setServiceAccountsLookup(() => [
    { id: 'md123121', user: 'Rudy', fake: false },
    { id: 'bridge-applemusic-p0gngd', user: 'Apple Music', fake: true },
  ]);
  ws.setSettingsUrlLookup(() => 'http://10.0.0.5:7090/');
  return { ws, frames, now };
}

test('both dialogs are ones the app accepts', () => {
  const dialogs = [
    serviceRefusedDialog({ account: 'Apple Music', accountId: 'bridge-applemusic-p0gngd', reason: 'auth', settingsUrl: 'http://x/' }),
    serviceRefusedDialog({ account: 'Rudy', accountId: 'md123121', reason: 'denied' }),
    playbackFailedDialog({ zoneId: 3, zoneName: 'Kitchen', title: 'Come Together' }),
    playbackFailedDialog({ zoneId: 3, zoneName: 'Kitchen' }),
  ];
  for (const dialog of dialogs) {
    const parsed = dialogFrameSchema.safeParse({ dialog_event: [dialog] });
    assert.ok(parsed.success, `the app drops this dialog: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
    assert.equal(dialog.state, 'show');
    assert.ok(dialog.cancelbtn, 'there is always a way to close it');
  }
});

test('a signed-out account is named the way the app lists it, with a way to the settings', () => {
  const { ws, frames } = notifier();
  ws.notifyServiceRefused('bridge-applemusic-p0gngd', 'auth');
  assert.equal(frames.length, 1);
  assert.ok(dialogFrameSchema.safeParse(frames[0]).success);
  const dialog = frames[0]!.dialog_event[0];
  assert.equal(dialog.title, 'Apple Music is signed out');
  assert.match(dialog.message, /Sign in again/);
  assert.deepEqual(dialog.buttons, [{ title: 'Open settings', link: 'http://10.0.0.5:7090/' }]);
  assert.equal(dialog.level, 2);
});

test('a refusal that is not a sign-out says so, and an account we cannot name still gets a dialog', () => {
  const { ws, frames } = notifier();
  ws.notifyServiceRefused('md123121', 'denied');
  assert.equal(frames[0]!.dialog_event[0].title, 'Rudy refused access');
  ws.notifyServiceRefused('gone', 'auth');
  assert.equal(frames[1]!.dialog_event[0].title, 'The streaming service is signed out');
});

test('without a settings address the dialog has no dead button', () => {
  const { ws, frames } = notifier();
  ws.setSettingsUrlLookup(null);
  ws.notifyServiceRefused('md123121', 'auth');
  assert.deepEqual(frames[0]!.dialog_event[0].buttons, []);
});

test('a refused account is announced once, not once per folder the app opens', () => {
  const { ws, frames, now } = notifier();
  for (let folder = 0; folder < 5; folder += 1) {
    ws.notifyServiceRefused('md123121', 'auth');
  }
  assert.equal(frames.length, 1);
  // Another account is its own matter.
  ws.notifyServiceRefused('bridge-applemusic-p0gngd', 'auth');
  assert.equal(frames.length, 2);
  // And after the quiet period it may be said again, if it is still true.
  now.at += SERVICE_REFUSED_QUIET_MS;
  ws.notifyServiceRefused('md123121', 'auth');
  assert.equal(frames.length, 3);
});

test('music that will not start is announced per zone, and not on every retry', () => {
  const { ws, frames, now } = notifier();
  const failure = { zoneName: 'Kitchen', title: 'Come Together', audiopath: 'applemusic:p0gngd:track:b64_MTIz' };
  ws.notifyPlaybackFailed(3, failure);
  ws.notifyPlaybackFailed(3, failure);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.dialog_event[0].title, 'Nothing is playing in Kitchen');
  assert.match(frames[0]!.dialog_event[0].message, /"Come Together" could not be played/);
  ws.notifyPlaybackFailed(4, { ...failure, zoneName: 'Living' });
  assert.equal(frames.length, 2, 'another zone is another failure');
  now.at += PLAYBACK_FAILED_QUIET_MS;
  ws.notifyPlaybackFailed(3, failure);
  assert.equal(frames.length, 3);
});

// --- where the refusal comes from ---------------------------------------------------

function browse(error: unknown) {
  const refused: unknown[][] = [];
  const handlers = createProviderHandlers(
    {
      getServiceFolder: async () => {
        throw error;
      },
    } as any,
    { notifyServiceRefused: (...args: unknown[]) => refused.push(args) } as any,
  );
  const run = () => handlers.audioCfgGetServiceFolder('audio/cfg/getservicefolder/spotify/bridge-applemusic-p0gngd/start/0/50');
  return { run, refused };
}

test('opening a folder of a signed-out account tells the app why it is empty', async () => {
  const signedOut = browse(new ProviderUnavailableError('applemusic', 'auth', 401));
  const result = await signedOut.run();
  assert.deepEqual(result.payload, [], 'the folder is still answered, empty');
  assert.deepEqual(signedOut.refused, [['bridge-applemusic-p0gngd', 'auth']]);

  const denied = browse(new ProviderUnavailableError('applemusic', 'denied', 403));
  await denied.run();
  assert.deepEqual(denied.refused, [['bridge-applemusic-p0gngd', 'denied']]);
});

test('a service that is merely slow or unreachable raises no dialog', async () => {
  // Nothing the listener can do about a rate limit or a timeout, and it usually passes.
  for (const reason of ['rate-limited', 'unreachable', 'error'] as const) {
    const attempt = browse(new ProviderUnavailableError('applemusic', reason));
    await attempt.run();
    assert.deepEqual(attempt.refused, [], reason);
  }
});

// --- why it did not play ----------------------------------------------------------

test('the dialog says why nothing played, in terms of what the listener can do about it', () => {
  // The three things a provider's own words can be sorted into.
  assert.match(explainPlaybackFailure('tidal stream is DRM protected'), /^It is copy-protected/);
  assert.match(explainPlaybackFailure('widevine missing'), /^It is copy-protected/);
  assert.match(explainPlaybackFailure("Tidal refused playback for this app's token"), /^The service refused to play it/);
  assert.match(explainPlaybackFailure('deezer stream url unavailable'), /^The service did not hand out a stream/);
  // The provider's wording is kept: it is what someone helping the listener will ask for.
  assert.match(explainPlaybackFailure('deezer stream url unavailable'), /\(deezer stream url unavailable\)$/);
  // And with nothing reported, nothing is made up.
  assert.equal(
    explainPlaybackFailure(undefined),
    'The service may be unreachable, or it may not offer this for playback here.',
  );
});

test('a failed play carries the provider\'s reason into the pop-up', () => {
  const { ws, frames } = notifier();
  ws.notifyPlaybackFailed(3, {
    zoneName: 'Kitchen',
    title: 'Come Together',
    audiopath: 'tidal:acc:track:1',
    reason: 'tidal stream is DRM protected',
  });
  const dialog = frames[0]!.dialog_event[0];
  assert.ok(dialogFrameSchema.safeParse(frames[0]).success);
  assert.equal(dialog.message, '"Come Together" could not be played. It is copy-protected, and the service only plays it in its own apps. (tidal stream is DRM protected)');
});

test('a play that failed because the account was turned away raises the account dialog instead', () => {
  const { ws, frames } = notifier();
  ws.setAudiopathToLoxone((path) => path.replace(/^applemusic:p0gngd:/, 'spotify@bridge-applemusic-p0gngd:'));
  // The account named in the path.
  ws.notifyPlaybackFailed(3, { zoneName: 'Kitchen', audiopath: 'applemusic:p0gngd:album:b64_QUJD', refusal: 'auth' });
  assert.equal(frames[0]!.dialog_event[0].title, 'Apple Music is signed out');
  assert.equal(frames[0]!.dialog_event[0].ID, 'service-refused:bridge-applemusic-p0gngd');
  // A bare Spotify path: the one real account there is.
  ws.notifyPlaybackFailed(4, { zoneName: 'Living', audiopath: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy', refusal: 'denied' });
  assert.equal(frames[1]!.dialog_event[0].title, 'Rudy refused access');
  assert.equal(frames.length, 2, 'and no "nothing is playing" on top of it');
});

test('what a provider last reported explains a failure only while it is recent', () => {
  const at = 1_000_000;
  const zone = { lastPlaybackErrorReason: ' deezer stream url unavailable ', lastPlaybackErrorAt: at };
  assert.equal(recentPlaybackErrorReason(zone, at + 5_000), 'deezer stream url unavailable');
  assert.equal(recentPlaybackErrorReason(zone, at + PLAYBACK_ERROR_EXPLAINS_FOR_MS + 1), undefined, 'an old error is not this failure');
  assert.equal(recentPlaybackErrorReason({ lastPlaybackErrorAt: at }, at), undefined);
  assert.equal(recentPlaybackErrorReason({ lastPlaybackErrorReason: 'x', lastPlaybackErrorAt: 0 }, at), undefined);
});

test('a refused account is told from any other error by its shape', () => {
  assert.equal(serviceRefusalOf(new ProviderUnavailableError('spotify', 'auth', 401)), 'auth');
  assert.equal(serviceRefusalOf(new ProviderUnavailableError('spotify', 'denied', 403)), 'denied');
  // Slow or unreachable is not the account's doing.
  assert.equal(serviceRefusalOf(new ProviderUnavailableError('spotify', 'rate-limited', 429)), null);
  assert.equal(serviceRefusalOf(new ProviderUnavailableError('spotify', 'unreachable')), null);
  assert.equal(serviceRefusalOf(new Error('auth')), null);
  assert.equal(serviceRefusalOf(null), null);
  assert.equal(serviceRefusalOf('auth'), null);
});

// --- a sign-out noticed while searching -------------------------------------------

function search(error: unknown) {
  const refused: unknown[][] = [];
  const handlers = createGlobalSearchHandlers(
    {
      globalSearch: async () => {
        throw error;
      },
    } as any,
    {
      notifyServiceRefused: (...args: unknown[]) => refused.push(args),
      notifyGlobalSearchError: () => {},
    } as any,
  );
  return { handlers, refused };
}

test('a search of a signed-out account tells the app, instead of looking like no hits', async () => {
  const global = search(new ProviderUnavailableError('spotify', 'auth', 401));
  await global.handlers.audioCfgGlobalSearch('audio/cfg/globalsearch/spotify@md123121:track#5,album#5/abba');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(global.refused, [['md123121', 'auth']]);

  const paged = search(new ProviderUnavailableError('spotify', 'denied', 403));
  const result = await paged.handlers.audioCfgSearch('audio/cfg/search/spotify/md123121/track/abba/0/50');
  assert.deepEqual(paged.refused, [['md123121', 'denied']]);
  assert.equal((result.payload as any)[0].results[0].items.length, 0, 'the answer is still an empty page');
});

test('a search that merely failed raises no dialog', async () => {
  const failed = search(new Error('socket hang up'));
  await failed.handlers.audioCfgSearch('audio/cfg/search/spotify/md123121/track/abba/0/50');
  const slow = search(new ProviderUnavailableError('spotify', 'rate-limited', 429));
  await slow.handlers.audioCfgSearch('audio/cfg/search/spotify/md123121/track/abba/0/50');
  assert.deepEqual([...failed.refused, ...slow.refused], []);
});
