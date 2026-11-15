/**
 * Pop-ups in the Loxone app, raised from here.
 *
 * `dialog_event` is the one channel the native client gives a server for saying something that
 * does not fit a list or a player state: a title, a message, an icon by severity, and buttons
 * that open a web page or send a command back. It is also blunt — the pop-up appears on every
 * connected phone and wall panel at once, whatever each is looking at, and stays until it is
 * tapped away. So it is kept for the two things a listener cannot otherwise find out and has
 * to act on: a service that has signed them out, and music that will not start.
 *
 * Nothing here knows about sockets. These are the dialogs and the rule for how often one may
 * be shown; the notifier puts them on the wire.
 */

/** `DialogLevel` in the client: decides the icon and its colour. */
export const DialogLevel = { Info: 1, Warning: 2, Critical: 3 } as const;

export type LoxoneDialogButton = {
  title: string;
  /** Opened in the browser when the button is tapped. */
  link?: string;
  /** Sent back to us, verbatim and without waiting for an answer, when the button is tapped. */
  command?: string;
  color?: string;
};

/**
 * One entry of `dialog_event`, exactly as the client's schema wants it: every field here is
 * required there, and a frame missing one is dropped whole. `ttl` is required and unused — the
 * current client never closes a dialog by itself.
 */
export type LoxoneDialog = {
  ID: string;
  state: 'show' | 'hide';
  level: 1 | 2 | 3;
  title: string;
  message: string;
  messagetype: string;
  buttons: LoxoneDialogButton[];
  cancelbtn?: LoxoneDialogButton;
  ttl: number;
};

/** Why a service turned a request away, for the cases a listener can do something about. */
export type ServiceRefusal = 'auth' | 'denied';

/**
 * "You have been signed out of …" — shown when a folder of a streaming service is opened and
 * the service refuses the account. Without it the app draws an empty folder and says nothing.
 */
export function serviceRefusedDialog(args: {
  /** The account as the app lists it: "Apple Music", or the name of a Spotify account. */
  account: string;
  accountId: string;
  reason: ServiceRefusal;
  /** Where the account can be signed in again; the button is left out when unknown. */
  settingsUrl?: string | null;
}): LoxoneDialog {
  const { account, accountId, reason, settingsUrl } = args;
  return {
    ID: `service-refused:${accountId}`,
    state: 'show',
    level: DialogLevel.Warning,
    title: reason === 'auth' ? `${account} is signed out` : `${account} refused access`,
    message:
      reason === 'auth'
        ? `The sign-in for ${account} has expired or was withdrawn, so nothing from it can be shown or played. Sign in again in the audio server's settings.`
        : `${account} did not allow this request. The account may lack the subscription this needs, or the sign-in may have to be renewed in the audio server's settings.`,
    messagetype: 'service',
    buttons: settingsUrl ? [{ title: 'Open settings', link: settingsUrl }] : [],
    cancelbtn: { title: 'Close' },
    ttl: 0,
  };
}

/**
 * "… could not be played" — shown when a zone was asked to play and nothing in its queue would
 * start. The app otherwise just stays silent, on a screen that still shows the track.
 */
export function playbackFailedDialog(args: {
  zoneId: number;
  zoneName: string;
  title?: string;
  /** What the provider reported, in its own words — see {@link explainPlaybackFailure}. */
  reason?: string;
}): LoxoneDialog {
  const what = args.title?.trim() ? `"${args.title.trim()}"` : 'The selected music';
  return {
    ID: `playback-failed:${args.zoneId}`,
    state: 'show',
    level: DialogLevel.Warning,
    title: `Nothing is playing in ${args.zoneName}`,
    message: `${what} could not be played. ${explainPlaybackFailure(args.reason)}`,
    messagetype: 'playback',
    buttons: [],
    cancelbtn: { title: 'Close' },
    ttl: 0,
  };
}

/**
 * A sentence for why nothing played, from what the provider reported.
 *
 * Providers report in their own words and for a log, not for a listener: "tidal stream is DRM
 * protected", "deezer stream url unavailable", "widevine missing". Three things can be told
 * apart in those, and each asks something different of the listener — nothing (it is
 * protected), the account (it was refused), or patience (no stream came back). The provider's
 * own wording is kept at the end either way: it is what someone helping the listener will ask
 * for.
 */
export function explainPlaybackFailure(reason: string | undefined): string {
  const said = reason?.trim();
  if (!said) {
    return 'The service may be unreachable, or it may not offer this for playback here.';
  }
  const lower = said.toLowerCase();
  const explanation = /drm|widevine|protected/.test(lower)
    ? 'It is copy-protected, and the service only plays it in its own apps.'
    : /refus|denied|forbidden|unauthori|not allowed/.test(lower)
      ? 'The service refused to play it for this account.'
      : 'The service did not hand out a stream for it.';
  return `${explanation} (${said})`;
}

/**
 * How often the same dialog may be raised.
 *
 * A refused account refuses every folder the app opens, and the app opens several at once; a
 * queue that will not start is retried by whoever is holding the phone. Each of those is one
 * thing to tell the listener once, not a pop-up per attempt.
 */
export class DialogThrottle {
  private readonly shownAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True when `id` may be shown now, and records that it was. */
  public allow(id: string, quietMs: number): boolean {
    const at = this.now();
    const last = this.shownAt.get(id);
    if (last !== undefined && at - last < quietMs) {
      return false;
    }
    this.shownAt.set(id, at);
    return true;
  }
}

/** A refused account is announced once in this long. */
export const SERVICE_REFUSED_QUIET_MS = 10 * 60 * 1000;
/** A zone that will not start is announced once in this long. */
export const PLAYBACK_FAILED_QUIET_MS = 20 * 1000;
