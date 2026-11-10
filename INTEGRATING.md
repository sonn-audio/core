# Integrating with sonn core

> This file is the public API's single source of truth, kept next to the code it describes.
> The website renders it, chapter by chapter, at
> [sonn-audio.github.io/docs/reference](https://sonn-audio.github.io/docs/reference/).


How to read and control sonn core from your own software — a home-automation system, a
script, a wall display, a plugin.

The API below is the server's own: versioned in the path, additive within a version,
and it speaks its own vocabulary. You do not need to know anything about Loxone to use it,
and it works whether or not the Loxone integration is enabled.

Base URL: `http://<server>:7090/api/v1`

> **Not to be confused with `/admin/api`.** That is the back end of this server's own
> admin UI: it is UI-shaped, changes freely, and is not a contract. Build your integrations on
> `/api/v1`.

**SONN player is built on nothing else.** It uses this API and only this API —
no `/admin/api`, no loxone api, so everything described here is
exercised by a real client rather than merely offered.

### Coming from `/admin/api`?

Before this API existed, `/admin/api/zones/states` was the only way to read what a zone was
playing, so integrations polled it. It is now what it was always meant to be — diagnostics
for our own Admin UI — and the now-playing fields have moved here:

| was | now |
| --- | --- |
| `title`, `artist`, `album` | `track.title`, `track.artist`, `track.album` |
| `coverUrl` / `coverurl` | `track.coverUrl` |
| `station`, `sourceName` | `source.name` (with `source.kind` telling you which) |
| `state` (`play`/`pause`) | `state` (`playing`/`paused`/`stopped`) |
| `powerState` | `powerState.power` (`on`/`off`) |
| `tech`, `system` | stayed — engine internals, not part of this contract |

`tech.player` moved as well: it is `output.device` here, with `mac` renamed to the
protocol-neutral `id`. Same value, same guarantee that an idle zone still reports it.

`PUT`/`GET /admin/api/zones/{id}/equalizer` moved too, to
`/api/v1/zones/{id}/equalizer`. The old path is gone rather than aliased, because nothing
outside our own Admin UI should have to touch `/admin/api`. The request body is
unchanged (`{"bands": [ …10 ]}`); the response drops `ok` and `equalizerSettings` —
a `2xx` already means it worked, and the comma-joined string was only ever there for
the Loxone app.

`POST`/`DELETE /admin/api/zones/browser` is gone as well — that was how a browser tab used to
register itself as somewhere audio goes, and it needed an admin session to do it. It is
`POST /api/v1/destinations/local` now, needs no session, and hands back the client id and
socket url the old route never did. See [Destinations](#destinations).

`GET /admin/api/transports/squeezelite/clients` has an answer here too, if you were using
it to work out which of your players ended up on which zone. `output.device.id` is that
same MAC and `output.device.connected` that same link state, per zone, from one read of
`/api/v1/zones` — see [the zone object](#zone-object). No session, no credentials.

That last part is the point of all of this: **`/admin/api` needs a session and `/api/v1`
does not.** If you are logging in — with local accounts or with Miniserver credentials — to
read state or steer playback, you are on the wrong surface, and the login can go with it.
`/admin/api` is the back end of our own Admin UI: it is UI-shaped, it changes without
notice, and nothing in it is a promise to you.

And you no longer need to poll: subscribe to `/api/v1/events` and the same data
arrives on every change.

## Design

Two rules explain every choice below:

- **Reading state never requires polling.** Subscribe to `/api/v1/events` once and you are
  told about every change. `GET /api/v1/zones` exists to bootstrap or for one-shot scripts.
- **Commands are plain HTTP.** No handshake, no socket, no correlation ids — a `curl`
  one-liner or a five-line shell script is a first-class client.

Every successful command is followed by an event, so you never have to read back after
writing: `zone.changed` for anything that alters a zone's state, and `queue.changed`,
`favorites.changed` or `recents.changed` for the collections — those say *that* something
changed and leave you to re-read the page you are showing.

## Finding the server

The server advertises itself over mDNS, so an integration can offer to set itself up
instead of asking someone to type in an address:

```
_sonncore._tcp.local.
```

The instance name is the server's configured name. The TXT record carries:

| key | meaning |
| --- | --- |
| `id` | Stable identity, the same value `GET /api/v1/audio-servers` reports as `selfId`. Key your configuration on this — **not** on the instance name, which is a display name someone can change, and not on the address. |
| `version` | What is running, if you need to know whether a surface exists yet. |
| `api` | Path prefix of the versioned API on this server, e.g. `/api/v1`. Follow it rather than hard-coding the prefix, and you land on the contract this server actually serves. |
| `mac` | The server's routing MAC. Present for our own speaker clients; `id` is the value to identify a server by. |

The remaining keys are registration paths used by our own clients (line-in bridges,
Sonn Clients) and are not part of this contract.

Discovery is a convenience, never a requirement: everything below works against a
host and port you already know, which is what a Docker setup on another network needs.

## Zone object

```json
{
  "id": 3,
  "name": "Kitchen",
  "state": "playing",
  "powerState": {
    "power": "on",
    "target": "on",
    "managed": true,
    "idleTimeoutMs": 300000
  },
  "position": 43,
  "duration": 210,
  "volume": 40,
  "volumeLimits": { "max": 70, "default": 20, "step": 2 },
  "muted": false,
  "repeat": "off",
  "shuffle": false,
  "track": {
    "title": "Song",
    "artist": "Artist",
    "album": "Album",
    "coverUrl": "http://server:7090/streams/3/…/cover",
    "colors": {
      "primary": [120, 30, 40],
      "accent": [220, 80, 60],
      "backgroundDark": [10, 5, 8],
      "backgroundLight": [245, 240, 240],
      "onDark": [255, 255, 255],
      "onLight": [0, 0, 0]
    }
  },
  "source": { "kind": "track", "name": "Library", "id": "library://track/9", "seekable": true },
  "group": { "leader": 3, "members": [3, 7] },
  "output": {
    "protocol": "sendspin",
    "capabilities": {
      "formats": [{ "codec": "pcm", "sampleRate": 44100, "bitDepth": 24, "channels": 2 }],
      "roles": ["player@v1", "visualizer@v1", "color@v1"],
      "visualizer": {
        "types": ["loudness", "spectrum", "pitch"],
        "rateMax": 30,
        "spectrum": { "bins": 64, "scale": "log", "fMin": 40, "fMax": 16000 }
      }
    }
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | number | Zone id. Stable across restarts. |
| `name` | string | Zone name as configured. |
| `state` | `playing` \| `paused` \| `stopped` | |
| `powerState` | object | `power`, `target`, `managed` and `idleTimeoutMs`; see below. |
| `position` | number | Whole seconds into the current track. |
| `duration` | number | Whole seconds. `0` means open-ended (live radio). |
| `volume` | number | `0`–`100`, but see `volumeLimits`. |
| `volumeLimits` | object | `max`, `default` and `step` — what this zone's volume will actually accept. |
| `muted` | boolean | Silenced on purpose. A muted zone reports `volume: 0`; this says it will come back to the level it had. Any write that puts the volume above zero clears it, so you never have to unmute before turning something up. |
| `repeat` | `off` \| `one` \| `all` | |
| `shuffle` | boolean | |

`track.colors` is the palette derived from the current cover artwork. It is `null` when there
is no cover or when the artwork could not be processed.

`output.capabilities` contains the capabilities negotiated with the active output client. For
Sendspin this includes supported player formats, negotiated roles and visualizer preferences.
It is `null` when the client is not connected. `format` remains the format currently in use;
capabilities describe what the client can accept.

`powerState.power` is the last confirmed physical power signal. `powerState.target` is the
desired signal. When `managed` is false, no physical power action is configured and
`idleTimeoutMs` is `null`.
| `track` | object \| **null** | `null` when the zone has nothing loaded. |
| `source` | object \| **null** | Where the audio comes from. |
| `group` | object \| **null** | `null` when the zone plays on its own; `members` lists leader first. |
| `output` | object \| **null** | `protocol` is e.g. `sendspin`, `snapcast`, `googlecast`, `dlna`, `sonos`, `airplay`. |
| `format` | object \| **null** | The source audio and output audio format. |
| `error` | string \| *absent* | Why the last thing this zone was asked to play did not play. |

`output.device` is present when the protocol identifies a specific device — for
squeezelite that is the SlimProto MAC, i.e. what its `-m` is set to:

```json
"output": {
  "protocol": "squeezelite",
  "device": { "id": "02:8C:54:A9:DC:AC", "name": "Test1", "connected": true }
}
```

It is reported whether or not the zone is playing and whether or not the device is
reachable, so you can map your own devices onto zones from a single read. `connected`
tells you the current link state; the id stays put either way.

`output.sync` says how this zone's audio is timed against the device, for protocols that keep a
shared clock. It is `null` or absent for the rest: an output that just hands bytes to a renderer has
no clock agreement to report on, so **an absent `sync` does not mean "out of sync"**.

```json
"output": {
  "protocol": "sendspin",
  "sync": {
    "state": "synchronized",
    "delayMs": 0,
    "deviceDelayMs": null,
    "targetLeadMs": 250,
    "leadMarginMs": 150,
    "leadMs": 334,
    "leadMinMs": 271,
    "driftMs": -25
  }
}
```

Two different things live in there. `state` and `delayMs` are the **agreement**: the device reports
whether it locked onto the clock (`synchronized`, `error`, `external_source` when it switched to its
own input, or `unknown` before it has said), and `delayMs` is the delay its own chain adds after the
audio port — raising it makes the room play *earlier*, see below. `deviceDelayMs` is what the device
says it has, which is not a confirmation of `delayMs`: a device applies the command at once but only
mentions the value in its next state message, so this trails every write by design. Do not build a
"not applied yet" indicator on the difference.

The rest is the **measurement** of how well the server is keeping its end, and each is `null` while
nothing is streaming, because they describe a stream in flight.

Frames are scheduled to arrive inside a **band**, not at a single target: `targetLeadMs` is its
floor — the least lead the sender allows — and `leadMarginMs` is how far above that it may run
before it backpressures. `leadMs` is the lead the most recent frame achieved, so it oscillates
through the band by design as the sender bursts and then waits.

**`leadMinMs` is the health signal**, not `leadMs`: the lowest lead seen over the last couple of
seconds. While that floor stays at or above `targetLeadMs` the client always has audio in hand; a
floor sinking toward zero is what a listener hears as dropouts. It is deliberately a floor rather
than a jitter average or spread — those measure the designed oscillation above and report a
perfectly steady stream as a fault.

`driftMs` compares the server's modelled timeline against the frame clock — a value that keeps
growing is a slipping timeline; one that sits still is fine, whatever its sign.

Only the agreement is treated as state. A change in `state`, `delayMs` or `targetLeadMs` arrives as
a `zone.changed`; the measurements move every frame and would turn every progress tick into a full
zone, so they ride along on whatever `zone.changed` comes next rather than causing one. Poll
`GET /zones/{id}` if you want them live.

`source.kind` is one of `track`, `radio`, `playlist`, `linein`, `airplay`, `spotify`,
`bluetooth`, `unknown`. **Treat the list as open**: new kinds may be added, and a client
must not fail on one it does not recognise — that is what `unknown` is a placeholder for.

`source.seekable` says whether `PUT /zones/{id}/position` will do anything — false for a
live stream, which has no position to seek to.

`source.id` is an **opaque** provider-native identifier. You may store it and pass it
back, but do not parse it: its internal form is service-specific and explicitly not part
of this contract.

`null` is used deliberately instead of empty strings, so `if (zone.track)` is enough to
tell "playing something" from "idle".

`format.output` is what the device is actually receiving, which is not the file's own format — a
zone whose output cannot take 192 kHz gets it resampled. `format.source` is the native source
format when it was declared by the provider or successfully probed:

```json
"format": {
  "bitPerfect": true,
  "dspApplied": false,
  "source": { "codec": "flac", "sampleRate": 96000, "bitDepth": 24, "channels": 2, "bitrate": null, "highRes": true },
  "output": { "codec": "pcm", "sampleRate": 44100, "bitDepth": 24, "channels": 2, "bitrate": null, "highRes": true },
  "processing": {
    "resampled": true,
    "resampler": { "name": "soxr", "precision": 28, "cutoff": 0.91 },
    "requantised": false,
    "channelsRemapped": false,
    "reencoded": false,
    "equalizer": null,
    "gainDb": null,
    "delayMs": null,
    "crossfading": false
  }
}
```

`bitrate` is bits per second where it is known, and `null` when it is unavailable. `source` is
null when the source format is unknown; `format` is null when the zone is streaming nothing. Engine
internals — buffer sizes, restart counts, subscriber drops — stay out; those describe the
server's health rather than the audio, and live in the admin surface.

`format.bitPerfect` is true only when a lossless source reaches the output with matching sample
rate, bit depth and channel count and without EQ, gain, pre-delay or other DSP. It is false for
lossy sources such as MP3 and AAC, even when their output parameters happen to match.
`format.dspApplied` indicates whether the server performed conversion, filtering, gain, delay or
re-encoding. An AAC source can therefore be `bitPerfect: false` and `dspApplied: false`.
`format.source.highRes` and `format.output.highRes` are true above 48 kHz or above 16-bit depth.

`format.processing` is `dspApplied` itemised — what was done to the audio, stage by stage, so a
client can show *why* a stream is not bit-perfect rather than only that it is not.

| field | meaning |
| --- | --- |
| `resampled` | The resampler ran: rate, channels or depth changed, or a filter forced the path. |
| `resampler` | Which one and how it was configured, when it ran. `null` otherwise. |
| `requantised` | The sample depth changed — the source declared one, the output carries another. |
| `channelsRemapped` | The channel count changed: a downmix or an upmix. |
| `reencoded` | The output codec re-encodes rather than carrying samples (`aac`, `mp3`, `opus`). |
| `equalizer` | The zone's 10-band EQ, when any band is off zero. Gains in dB, low band first. |
| `gainDb` | Gain by origin: `source` is the provider's own loudness normalisation (Spotify sends one), `output` a fixed trim. `null` when both are zero. |
| `delayMs` | Pre-delay for aligning this source against another output. `null` when none. |
| `crossfading` | True while a crossfade is blending, which requantises by definition. |

It is **`null`-able rather than defaulted to a chain of `false`**, and the distinction carries
information: `null` means the engine cannot say, so a server that does not report a chain stays
distinguishable from one whose chain is genuinely empty.

The zone's volume is deliberately not in here. It is applied at the device rather than in this
pipeline, so listing it as processing would claim an alteration this server did not make.

`error` is present only when something went wrong, so `if (zone.error)` is the whole check.
It exists because `POST /play` answers `204` for a uri the server cannot resolve — resolution
is asynchronous, so the call is accepted before anything has been looked up. The failure then
arrives as a `zone.changed` like any other state change, which means you do not need a
verification timer: send the play, watch the stream. `track` is `null` while a zone carries an
error, and the error clears on the next successful play.

## Events

```
GET /api/v1/events        →  text/event-stream
```

Server-Sent Events. Every message is a JSON object on a `data:` line with a `type`
discriminator. The stream opens with a full snapshot, so a client can render before the
first change arrives. A `: keep-alive` comment is sent every 25 s.

That opening `server.snapshot` says your stream has state, not that the server has
finished starting — [`GET /ready`](#supervising-the-server) is the only thing that
answers that. It was called `server.ready` up to 4.0.0-beta.18, which read like a readiness claim
and contradicted `/ready` whenever the two disagreed.

```
data: {"type":"server.snapshot","zones":[ … ]}

data: {"type":"zone.changed","zone":{ … }}

data: {"type":"zone.progress","id":3,"position":44}

data: {"type":"queue.changed","id":3,"size":12}

data: {"type":"favorites.changed","id":3,"count":4}

data: {"type":"recents.changed","id":3}
```

`zone.changed` always carries the **complete zone**, never a patch — you never need to
keep prior state to interpret an event, and a client that reconnects is immediately
correct.

`zone.progress` is the one exception: while a track plays and nothing but the clock has
moved, only the new position is sent. A full zone is ~550 bytes and this fires once a
second per playing zone. Anything else that changes — volume, a new track, a source
switch — still arrives as a `zone.changed`, so **a client that ignores
`zone.progress` stays correct**; its progress bar just moves a beat later.

What counts as "nothing but the clock" excludes the server's own live *readings*:
`format.*.bitrate` (a throughput average that moves every second for any codec but PCM) and
`output.sync`'s `leadMs`/`leadMinMs`/`driftMs`. Every event carries their current values, but a
new reading on its own does not produce one — read them from `GET /zones` when you want them on
their own schedule. A snapshot identical to the one before it is not sent at all.

The three collection events carry a **size, not the collection**. A queue is paged and can
hold thousands of entries, so shipping it on every edit would be the wrong trade — re-read
`GET /zones/{id}/queue` for the page you are showing. They also fire when *another* client
makes the change, which is the point: two tabs, or a tab and a Loxone panel, stay in step.

Unlike `zone.changed` these are not deduplicated. "The queue changed" is an event rather than
a value, so two identical ones mean it changed twice — a reorder keeps the size and still
reports.

Browser:

```js
new EventSource('http://server:7090/api/v1/events')
  .onmessage = (e) => console.log(JSON.parse(e.data));
```

Shell:

```bash
curl -N http://server:7090/api/v1/events
```

### Realtime audio analysis

For visualizers, an individual zone also exposes the central audio analysis as an SSE stream:

```
GET /api/v1/zones/{id}/analysis?types=loudness,spectrum,f_peak,peak,pitch,stereo&rate=20&bins=32
```

The stream starts with `analysis.ready`. After that, each `data:` line is one analysis event:

```json
{"type":"loudness","value":0.42,"timestampUs":1720000000000000}
{"type":"spectrum","bins":[12,18,31],"timestampUs":1720000000050000}
{"type":"pitch","midiQ88":17612,"confidence":0.81,"timestampUs":1720000000050000}
{"type":"stereo","left":41200,"right":39880,"timestampUs":1720000000050000}
```

`types` selects the features, `rate` is capped at 60 events per second and `bins` controls the
spectrum resolution. The stream is fed from the zone's PCM output, so it is independent of the
Sendspin protocol; Sendspin and browser clients consume the same central analysis pipeline.
Analysis is realtime data rather than zone state and is therefore deliberately not included in
`zone.changed` or persisted in the zone object.

`stereo` is the pair a meter bridge needs: the front left and right levels, each in the same
encoding as `loudness`. It is not derivable from `loudness`, which is the mean power across the
channels and therefore averages the stereo image away — a wide mix reads as one number there. A
mono source answers with both sides equal rather than a silent right channel, which is the honest
reading rather than a dead meter. Ask for the type only when you are drawing it: the per-channel
levels are computed for the subscriptions that request them and for no others.

### Waveforms

The other half of the same job, for the shape of a whole track rather than the sound of this
instant — a scrubber that shows where the loud parts are.

```bash
curl -s "http://server:7090/api/v1/waveform?uri=<source id>"
```

```json
{ "uri": "library://local/…/01 - Don't Panic.flac", "buckets": [0, 3, 11, 42, 40, 38, …], "durationMs": 224000 }
```

**Keyed by `uri`, not by zone** — deliberately. The same track has the same shape in every room,
so hanging it off `/zones/{id}/waveform` would serve identical bytes under a dozen URLs and make
it uncacheable in a browser. A zone's `source.id` is exactly what goes in here, and the response
echoes it back so a late reply can be matched to the track that is playing *now*.

It is served `Cache-Control: private, max-age=86400`. That is safe to lean on rather than
re-fetching: the bytes derive from a file whose size and mtime are part of its audiopath, so a
file that changes is recomputed under a different response rather than staling this one.

`404 no-waveform` means there is no shape to draw, and covers two cases a caller can neither
tell apart nor needs to: a live stream that can never have one, and a file not yet analysed.
Both mean *draw what you have and ask again later*, so treat it as an empty state rather than an
error — and note that an empty `buckets` array would be a different answer, a track that really
is silent. A missing or blank `uri` is `400 missing-uri`.

## Reading

```
GET /api/v1/zones                   →  { "zones": [ … ] }
GET /api/v1/zones/{id}              →  { … }              404 zone-not-found
GET /api/v1/zones/{id}/equalizer    →  { "zoneId": 3, "bands": [ …10 ] }
GET /api/v1/zones/{id}/queue        →  { "items": [ … ], "start": 0, "total": 42, "currentIndex": 3 }
GET /api/v1/zones/{id}/favorites    →  { "items": [ … ], "start": 0, "total": 8 }
GET /api/v1/zones/{id}/recents      →  { "items": [ … ], "start": 0, "total": 20 }
GET /api/v1/destinations            →  { "destinations": [ … ] }
GET /api/v1/audio-servers           →  { "selfId": "…", "servers": [ … ] }
GET /api/v1/services                →  { "services": [ … ] }
GET /api/v1/browse                  →  the root: one entry per service
GET /api/v1/browse/{id}             →  { "container": …, "items": [ … ], "start": 0, "total": 42 }
                                                               404 not-found · 502 service-unavailable
GET /api/v1/items/{id}              →  one item                404 not-found
GET /api/v1/items/{id}/about        →  a biography, related items       404 when there is none
GET /api/v1/search?q=…              →  { "items": { "track": [ … ] }, … }
GET /api/v1/playlists               →  { "items": [ … ], "total": 1 }
GET /api/v1/waveform?uri=…          →  { "uri": …, "buckets": [ … ] }   404 no-waveform
GET /api/v1/inputs                  →  { "inputs": [ … ] }
GET /api/v1/health                  →  { "status": "ok"|"degraded"|"unhealthy", … }
GET /api/v1/ready                   →  { "ready": true, "phase": "ready" }   503 when not
GET /api/v1/zones/{id}/cover        →  the image itself        404 when the zone has none
```

### Supervising the server

Two endpoints, because "is it working?" and "can I stop waiting?" are different questions.

`GET /api/v1/ready` is the cheap one — poll it every second if you like:

```json
{ "ready": true, "phase": "ready" }
```

`phase` is `starting`, `ready` or `failed`, and the status code carries the same answer:
**200** when ready, **503** when not. That distinction is the point — a server that is still
booting and one that died during boot both fail to answer, but only the second needs you.
A `failed` phase adds `error` with the reason. This is also what to poll after a restart,
instead of sleeping and hoping.

`GET /api/v1/health` gives a verdict you can act on:

```json
{
  "status": "degraded",
  "version": "4.0.0-beta.17",
  "uptimeSec": 451,
  "phase": "ready",
  "checks": [
    { "name": "audio", "status": "degraded", "detail": "last playback attempt failed on Study (ffmpeg exited 1)" },
    { "name": "loxone", "status": "ok" }
  ]
}
```

Three statuses, and the middle one matters most:

| status | code | what to do |
| --- | --- | --- |
| `ok` | 200 | nothing |
| `degraded` | **200** | look, but do not restart — it is still serving |
| `unhealthy` | 503 | intervene |

`degraded` deliberately stays a 200. The usual reaction to a non-2xx is a restart, and
restarting a server whose Loxone link is down or whose one zone has a failing encoder fixes
nothing while interrupting every zone that was fine. If you want a single boolean for a
`docker healthcheck` or a load balancer, the status code already is one — only `unhealthy`
fails.

`checks[]` is keyed by a stable `name`, so branch on that rather than parsing `detail`
(which is prose, aimed at whoever has to fix it, and may change). Healthy checks carry no
`detail`. A check appears only where it is meaningful: a server no Miniserver has ever
paired with reports no `loxone` check at all, because an absent integration is not a broken
one.

`uptimeSec` counts from when the server last became **ready**, not from process start —
otherwise a restart keeps counting through a window in which nothing was served.

Neither endpoint needs a session.

### Cover art

`track.coverUrl` is the artwork's real location, and it changes every track — it can be a
remote CDN, a data uri, or a url only reachable from the server. That is fine if you read
state and update an `<img>` each time, but not if you want one address you can point a
wall panel or a Loxone visualisation at and forget about.

`animatedCoverUrl` sits beside it on a track, a queue entry and a browse item, when the provider
has motion artwork for that release. It is **absent rather than empty** when there is none, which
is the common case — so treat it as an enhancement over `coverUrl` and never as a replacement:
`coverUrl` is always the one to fall back to, and a client that ignores `animatedCoverUrl`
entirely is correct, just stiller.

`GET /api/v1/zones/{id}/cover` is that address. It names only the zone, returns the image
bytes, and follows whatever that zone is playing:

```bash
# Always shows the kitchen's current cover
http://server:7090/api/v1/zones/3/cover
http://server:7090/api/v1/zones/3/cover?size=300
```

`size` is a hint. Where the provider offers variants (Apple Music, TuneIn, the image
proxy) the server asks upstream for one near that size, which is sharper and cheaper than
scaling here; otherwise it is ignored. Out-of-range or unparseable values fall back to the
default rather than erroring, so an `<img src>` that cannot handle a `400` stays safe.

A zone playing nothing, or an unknown zone, answers `404` — draw your own placeholder
rather than expecting a blank image.

#### Keeping it fresh

Because the url does not change when the track does, caching needs a way to tell one cover
from the next. Every response carries an `ETag` hashed from the artwork itself, alongside
`Cache-Control: public, max-age=10`:

```bash
curl -s -o cover.jpg -D - http://server:7090/api/v1/zones/3/cover
# ETag: "xLp3…"

# Still the same cover → 304, no body transferred
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'If-None-Match: "xLp3…"' http://server:7090/api/v1/zones/3/cover
```

So polling costs almost nothing while a track plays, and the moment it changes you get
bytes again. The tag is derived from the source and the requested size, which makes it
stable across restarts and identical on two servers holding the same art — not a counter
you have to store.

Some clients ignore all of that. A Loxone visualisation will hold an `<img src>` far longer
than `max-age` suggests, and there is no header that fixes it. For those, add any parameter
of your own and vary it when the track changes — unknown parameters are ignored:

```
http://server:7090/api/v1/zones/3/cover?v=applemusic:track:b64_MTc4MDM4MjY5NQ==
```

`track.coverUrl` from `/api/v1/events` is a convenient value to put there: it changes
exactly when the picture does.

## Commands

All return **`204 No Content`** on success. The resulting state arrives over
`/api/v1/events`.

```
POST /api/v1/zones/{id}/play    {"uri": "…"}   or  no body to resume
POST /api/v1/zones/{id}/pause
POST /api/v1/zones/{id}/stop
POST /api/v1/zones/{id}/next
POST /api/v1/zones/{id}/previous

PUT  /api/v1/zones/{id}/volume     {"volume": 40}   or  {"delta": -5}
PUT  /api/v1/zones/{id}/mute       {"muted": true}  or  no body to toggle
PUT  /api/v1/zones/{id}/position   {"position": 90}
PUT  /api/v1/zones/{id}/power      {"power": "on"}
PUT  /api/v1/zones/{id}/input      {"input": "linein-ms3h9f42"}
PUT  /api/v1/zones/{id}/equalizer  {"bands": [3,3,2,1,0,0,-1,-2,-2,-3]}
PUT  /api/v1/zones/{id}/repeat     {"repeat": "off" | "all" | "one"}
PUT  /api/v1/zones/{id}/shuffle    {"shuffle": true}

POST   /api/v1/zones/{id}/queue    {"uri": "…"}            add to the end
POST   /api/v1/zones/{id}/queue    {"uri": "…", "next": true}   add after what is playing
PATCH  /api/v1/zones/{id}/queue    {"play": "<item id>"}    jump to an entry
PATCH  /api/v1/zones/{id}/queue    {"move": "<id>", "before": "<id>"}   reorder (omit `before` for the end)
DELETE /api/v1/zones/{id}/queue    {"id": "<item id>"}      remove one entry
DELETE /api/v1/zones/{id}/queue    {"all": true}            clear it
DELETE /api/v1/zones/{id}/queue    {"undo": true}           revert the last edit

POST   /api/v1/zones/{id}/handoff  {"targetZoneId": 7}      move playback to another zone

POST   /api/v1/zones/{id}/alert      {"kind": "tts", "text": "…"}   say or play something
DELETE /api/v1/zones/{id}/alert      {"kind": "alarm"}              stop it

POST   /api/v1/zones/{id}/favorites  {"uri": "…", "name": "…"}   add (name optional)
PATCH  /api/v1/zones/{id}/favorites  {"id": 1, "name": "…"}      rename
PATCH  /api/v1/zones/{id}/favorites  {"order": [3,1,2]}          reorder
PATCH  /api/v1/zones/{id}/favorites  {"play": 1}                 start it
DELETE /api/v1/zones/{id}/favorites  {"id": 1}                   remove
DELETE /api/v1/zones/{id}/recents                                clear the history

PUT    /api/v1/zones/{id}/group      {"members": [7, 9]}   group these behind this zone
PUT    /api/v1/zones/{id}/group      {"members": []}       ungroup
```

`powerState.power` is the current physical amplifier/player power. `powerState.target` is the
desired signal, and `powerState.idleTimeoutMs` reports the automatic idle timeout. The explicit
power command still uses `{"power":"off"}` and switches the
configured power action immediately; it does not wait for the automatic `offDelayMs`. It also
stops playback. The automatic switch-off caused by a normal playback state transition keeps
using the configured delay.

`mute` is silence with a way back: it sets the volume to `0` and remembers the level, so
unmuting returns the zone to where it was rather than to a default. Sending `{"muted":true}`
twice is harmless, which is why the field is a boolean — a client that retries a failed
request does not flip it. Omit the body to toggle, the way a remote's mute key does. There
is no need to unmute before turning something up: any volume write above zero clears it,
whether it comes from here, from a device's own knob or from an announcement.

`pause` keeps the zone's place and `stop` gives it up: after `pause`, `play` resumes
where it was; after `stop` it starts over. Both let the zone's power management switch
an amplifier off, since by default only `play` counts as active.

Live radio is the exception — it has no position to resume, so `pause` tears the stream
down and `play` reconnects live. Expect `position` to restart at 0 there rather than
continue.

`play` without a body resumes whatever the zone already has queued. With `{"uri": "…"}`
it **starts** something: either a stream URL, or a `source.id` this API gave you
earlier — that is what makes the id worth storing. Resolving it and rebuilding the queue
happens server-side, so you do not need to know anything about how content is modelled.

```bash
# Start a stream, then a track this zone reported playing earlier
curl -X POST http://server:7090/api/v1/zones/3/play -d '{"uri":"http://example/stream.mp3"}'
curl -X POST http://server:7090/api/v1/zones/3/play -d '{"uri":"library://track/9"}'
```

`handoff` is a server-side queue transfer. It moves the complete queue, including its order,
current index, repeat/shuffle settings and current position, to the target zone. The source is
stopped and cleared only as part of the same operation; the client must not rebuild the queue
itself. Both zones must exist and must be different, and the source must have a queue. A successful
handoff returns `204`; an impossible transfer returns `404` with
`{"error":"handoff-not-possible"}`.

```bash
curl -X POST http://server:7090/api/v1/zones/3/handoff \
  -H 'Content-Type: application/json' \
  -d '{"targetZoneId":7}'
```

### Audioservers

`GET /api/v1/audio-servers` lists the audioservers known from the installation configuration.
`selfId` is the MAC id of the current server. Each entry identifies whether it is a sonn core or
a regular Loxone audioserver. This is a discovery resource, not a playback target: use
`/destinations` and `/zones` for audio routing.

```json
{
  "selfId": "001122AABBCC",
  "servers": [
    {
      "id": "001122AABBCC",
      "name": "Living room server",
      "host": "sonn-living",
      "self": true,
      "kind": "sonn-core"
    }
  ]
}
```

## Destinations

Somewhere audio can be sent. A zone is one kind of destination, but **this server does not
require zones at all** — it can run as a DLNA source with a streaming account and nothing
else, and a client can play audio itself with no zone configured anywhere.

```bash
curl -s http://server:7090/api/v1/destinations
```

```json
{ "destinations": [
  { "id": "3",    "name": "Kitchen",  "kind": "zone",  "protocol": "sendspin", "available": true },
  { "id": "9000", "name": "This tab", "kind": "local", "protocol": "sendspin", "available": true }
]}
```

Playback works the same on either: `POST /destinations/{id}/play`, `/pause`, `/volume` and the
rest are the same commands as their `/zones/{id}/…` counterparts, and a destination's id *is*
its zone id.

**A local destination is not in `GET /zones`.** A zone is a room in a house — everyone may see
that the kitchen is playing. A browser tab is not a room, so it appears in neither the zone list
nor the events stream, not even for the browser that registered it. Otherwise every client's
room list would grow with every tab anyone opened, and one person's phone would sit beside the
speakers, playable by mistake.

A tab does not need it there either: the Sendspin socket it already holds to receive audio pushes
title, artist, album, artwork, playback state and progress as `server/state`. That is the source
that cannot be out of step with the sound, and reading the same thing twice from two places is
one time too many.

`GET /destinations` is where a tab finds itself, and it is private: send the `clientId` you were
given at registration, as an `X-Sonn-Client-Id` header or `?clientId=`, and your own destination
is listed alongside the configured zones. Send nothing and you get the zones only.

Every zone route still *works* on a local destination — `/zones/{id}/queue`, favourites,
grouping — because it is a zone underneath. It is only absent from the listings. Drive it through
`/destinations/{id}/…` and you never need to know that.

`/destinations` exists for the one thing `/zones` cannot express: **registering** a client as
somewhere audio goes, and telling a zone from a tab (`kind`). Everything after that is a zone.

### Playing audio yourself

A client can be the thing that plays. Register, then connect:

```bash
curl -X POST http://server:7090/api/v1/destinations/local -d '{"name":"This tab"}'
```

```json
{ "id": "9000", "kind": "local", "clientId": "browser-9000",
  "streamUrl": "ws://server:7090/sendspin", "protocol": "sendspin", "available": true }
```

Then open `streamUrl` and announce `clientId` in a Sendspin `client/hello`. Audio arrives as
PCM frames on that socket, and `POST /destinations/{id}/play` starts it. The
[Sendspin protocol](https://github.com/Sendspin/spec) does the rest — format negotiation,
clock sync, grouping — and `sendspin-js` implements the client side for a browser.

> **`streamUrl` is the socket itself**, `ws://…/sendspin` — not a base url to append a path to.
> A library that wants an origin and adds its own path needs the http form of *this* url, not
> your page's origin: in development those differ, and pointing it at your own origin dials a
> port where nothing listens. There is no error when that happens — the connect simply hangs —
> so bound your connect attempt and treat the timeout as a failure.

`streamUrl` is built from the address your request arrived on, so it is reachable from wherever
you are, including behind a proxy. Pass your own `clientId` back on a later call to reclaim the same registration — that
is what a page reload needs, and without it every refresh leaves an orphan behind until it
times out. The registration disappears shortly after the socket closes.

`DELETE /destinations/local/{id}` removes one early. It refuses a configured zone: that is not
this route's to delete.

**Release a registration you could not use.** If registering succeeds but connecting fails,
delete it — otherwise the tab that never connected sits in everyone's room list as a speaker
that plays nothing until it times out.

## Browsing

```bash
# What is there?
curl -s http://server:7090/api/v1/services

# Start at the root, then walk in
curl -s http://server:7090/api/v1/browse
curl -s "http://server:7090/api/v1/browse/<id>?offset=0&limit=50"
```

Every service appears **under its own name** — `applemusic`, `soundcloud`, `library`, `radio`. The
`radio` service contains Radio Paradise, TuneIn Presets and Custom Streams. There
is no Spotify disguise here. That disguise exists because the Loxone clients know exactly
one streaming service; it is a translation in that adapter and it stops there.

```json
{ "services": [
  { "id": "applemusic", "name": "Apple Music",
    "rootId": "b1.c.category.YXBwbGVtdXNpYw.cm9vdA",
    "searchableKinds": ["track", "album", "artist", "playlist"] }
]}
```

`rootId` is the id to browse that service's top level — `GET /browse/{rootId}` — so you can jump
straight into one service without walking the root listing. `searchableKinds` is what its search
can actually answer; **empty means it cannot search at all**, which is why asking `radio` for
tracks returns nothing rather than failing.

`GET /browse` with no id lists the services themselves, so a client that just wants a tree can
start there and never read `/services`.

### Sections

A listing may carry a `sections` array alongside `items`, when the provider groups its own
children — an Apple Music root does, the browse root does not:

```json
{ "container": { … }, "items": [ … ], "sections": [ { "id": "…", "name": "Recently Added", "items": [ … ] } ], "start": 0, "total": 8 }
```

**`sections` is not a grouping of `items` — it is separate content.** On the Apple Music root the
two do not overlap at all: `items` holds the eight menu entries you can walk into (Albums,
Artists, Playlists…), while `sections` holds eighty-odd editorial rows (New Releases, Recently
Played, Made For You). A client that renders only `items` shows a menu and silently drops
everything the provider actually put on its front page.

So render both, in either order, and expect no duplicates. `total` counts `items`; section
contents are whole and not paged.

### Items

```json
{
  "id": "b1.p.track.YXBwbGVtdXNpYzp0cmFjazpiNjRfYVM1WVRVUldaRUpS…",
  "name": "A Bird In New York",
  "kind": "track",
  "browsable": false,
  "playable": true,
  "service": "applemusic",
  "artist": "Eric Serra",
  "album": "Léon (Original Motion Picture Soundtrack)",
  "duration": 81,
  "coverUrl": "https://…/640x640bb.jpg"
}
```

`kind` is `track`, `album`, `artist`, `playlist`, `radio`, `show`, `episode`, `category`,
`folder` or `unknown`. **Treat the list as open** — new kinds may appear and a client must
not fail on one it does not know.

`browsable` and `playable` are separate questions and both can be true: an album is
something to open *and* something to play, so branch on what the user did rather than
inferring from `kind`.

`id` is **opaque**. Feed it back to `/browse/{id}`, `/items/{id}` or
`POST /zones/{id}/play` — it round-trips exactly, and the queue routes take it too. Do not parse it: the encoding is not part
of this contract, and ids stay valid across restarts and library rescans precisely because
they do not encode anything you should rely on.

### The container

The `container` in a browse response is an item of the same shape — the thing you are inside.
It answers the fields it can: `id`, `kind`, `name`, `browsable`, `playable`, and, where the
provider knows them, `coverUrl` and `artist`.

Those last two are worth stating because they used to be absent for everyone. A container
described itself with a name and nothing else, so an album page had the album's tracks and no
album cover — every row carried artwork its own container could not — and a client that wanted
to open a record with its sleeve had to reach into the first child and hope. They are filled by
the provider rather than inferred, so treat them as optional: the local library answers both, a
streaming service may answer neither, and nothing is fabricated to fill the gap.

### When a service will not answer

```json
{ "error": "service-unavailable", "service": "spotify", "reason": "auth",
  "message": "spotify did not answer (auth, 401)" }
```

A **502** with this body means the service was asked and turned the request away. It is a
different answer from `200` with an empty `items`: that is a folder with nothing in it, this is a
folder nobody was allowed to look in. `reason` is one of `auth` (the account's token is dead or
needs to be linked again), `denied` (the token is fine and the request is not allowed — a Spotify
app put back into development mode answers this way), `rate-limited`, `unreachable` (no answer at
all), or `error`. Show the person the reason: "Spotify needs to be linked again" beats a shelf with
nothing on it. The answer is not cached, so asking again asks the service again.

### Paging

`start` (or `offset` — both accepted everywhere, and the response field is `start`) and
`limit`, default 50, max 500. `total` is the number of children — **or `null`
when the provider cannot say**, which several streaming providers genuinely cannot. When it
is null, keep paging until you get back fewer items than you asked for. A number here is a
real count, not an estimate.

### Looking one thing up

```bash
curl -s http://server:7090/api/v1/items/<id>
```

For when you have an id but no listing it came from — a deep link, a restored session, an id
stored last week. One caveat, stated plainly: a container's own name is not always knowable.
Providers name a folder in the *listing that contains it*, not in the folder itself, so
`name` can come back empty for a container you did not browse into. It is never fabricated.

### The story around an item

```bash
curl -s http://server:7090/api/v1/items/<id>/about
```

```json
{
  "description": "Queen are a British rock band formed in London in 1970 by…",
  "similar": [ { "id": "…", "name": "Chris Martin", "kind": "artist", … } ],
  "source": { "name": "Wikipedia", "url": "https://en.wikipedia.org/wiki/Queen_(band)" }
}
```

**404 is the ordinary answer, not an error.** Most items have no article, some kinds have none
by nature (a playlist is somebody's collection; nobody writes about it), and a story that has
not been assembled yet has nothing to show. Render nothing and move on — a client that treats
this 404 as a failure will report an outage on the common case.

Three things worth knowing:

- **`similar` are real items**, with ids that go straight back into `/browse/{id}` or
  `POST /zones/{id}/play`. A related act this server has no copy of is *absent* rather than
  listed as a name you cannot open. The list is often empty, and empty is a legitimate answer:
  it means the neighbours exist in the world but not in this house. Where the service has an
  editorial answer of its own — Apple Music does — that is what you get, because "who else would
  I like" is a catalogue owner's question; otherwise it falls back to the acts the metadata
  source relates, which is a weaker claim (a band's own line-up, not music beside it).
- **`source` is not decoration.** The prose comes from freely licensed sources that require
  attribution, so if you show the description, show the credit.
- **The first ask may 404 and the second may not.** Assembling a story means several
  rate-limited upstream requests; rather than hold your request open, the server answers with
  what it has and finishes in the background. Ask again later — the answer is cached for weeks,
  including the answer "there is nothing".

The server that assembles this uses MusicBrainz, Wikidata and Wikipedia — no API key, and
nothing about your library leaves the server beyond the artist or album name being looked up.

### Search

```bash
curl -s "http://server:7090/api/v1/search?q=beatles"
curl -s "http://server:7090/api/v1/search?q=beatles&kind=album&limit=10"
curl -s "http://server:7090/api/v1/search?q=beatles&service=applemusic,library"
```

```json
{
  "query": "beatles",
  "items": { "track": [ … ], "album": [ … ], "artist": [ … ] },
  "services": [{ "service": "library" }, { "service": "applemusic" }]
}
```

Results are grouped by kind, and every item names the service it came from.

`kind` narrows the search, and it is not merely a filter: a provider that cannot search a
kind is **not asked** for it. Ask for albums and SoundCloud sits it out, because SoundCloud
has no album search — check `searchableKinds` in `/services` to see what each one offers
rather than assuming they are alike. `service` narrows which providers are asked at all.

`services` in the response says who answered, with `failed: true` on any that errored — so
a provider outage looks like a partial answer rather than "no matches".

### Playlists

Playlists you make here, on the local library. Streaming services keep their own — those are
read-only and appear through `/browse` like any other container.

```
GET    /api/v1/playlists          ?start=&limit=   →  { "items": [ … ], "total": 1 }
POST   /api/v1/playlists          {"name": "…"}    →  201 with the playlist
PATCH  /api/v1/playlists/{id}     {"name": "…"}    →  200, renamed
DELETE /api/v1/playlists/{id}                      →  204

POST   /api/v1/playlists/{id}/items  {"id": "<item id>"}        append
PATCH  /api/v1/playlists/{id}/items  {"from": 0, "to": 3}       move
DELETE /api/v1/playlists/{id}/items  {"position": 0}            remove
```

```json
{ "id": "b1.c.playlist.bGlicmFyeQ.…", "name": "Sunday", "tracks": 5,
  "coverUrl": "http://server:7090/music/local/…/cover.jpg" }
```

A playlist's `id` **is a browse id**, so `GET /browse/{id}` lists its tracks and
`POST /zones/{id}/play` with it plays the lot. There is no separate "read a playlist" route
because there does not need to be one.

Two things differ from the queue, and both catch people out:

- **Entries are addressed by position, not by an id.** `{"position": 0}` removes the first
  track; `{"from": 0, "to": 3}` moves it. A queue hands out a per-entry id because the same
  track can sit in it twice and you must be able to say which; a playlist is edited as a list,
  so the index is the handle. Read the playlist back after a move rather than assuming your
  own arithmetic matched.
- **Only library tracks can be added.** Handing it an `applemusic:` or `soundcloud:` item id
  answers `400 invalid-playlist-item`. A local playlist stores local audio; a streaming track
  is not the server's to keep, and a reference that dies when a subscription lapses would be
  worse than the refusal.

Errors: `invalid-name`, `playlist-not-found`, `invalid-playlist-item`, `playlist-item-not-found`.

### Inputs

Physical inputs — a turntable, a CD player, a MasterLink device — are configured in the
admin UI. What is configured is listed here, and there may be none:

```json
{
  "inputs": [
    { "id": "linein-ms3h9f42", "name": "BeoSound 9000", "icon": "cd-player",
      "controllable": true, "reportsMetadata": true }
  ]
}
```

They belong to the server, not to a zone: the same input is selectable from any zone, so
switching one is a property of the zone rather than a list under it.

```bash
curl -X PUT http://server:7090/api/v1/zones/3/input -d '{"input":"linein-ms3h9f42"}'
```

`source.id` reports that same id back once the zone is on it, so what you read is what you
can write. `source.name` is the input's configured name.

`controllable` is worth branching on. For an input that answers commands — something on a
MasterLink bus, say — the ordinary `POST /zones/{id}/pause`, `/next` and so on reach the
device. For a turntable or a bare jack it is `false`: selecting it is the whole
interaction, and transport commands change nothing audible. `reportsMetadata` says whether
`track` will ever be more than blank.

`icon` is a hint for choosing an artwork: `line-in`, `cd-player`, `computer`, `imac`,
`ipod`, `mobile`, `radio`, `screen`, `turntable`. **Treat the list as open.**

There is no verb for leaving an input — selecting something else is how you leave, and the
server releases the old source as part of that.

### Announcements

```bash
# Say something in the kitchen
curl -X POST http://server:7090/api/v1/zones/3/alert \
  -d '{"kind":"tts","text":"Dinner is ready","language":"nl"}'

# The doorbell, everywhere at once
curl -X POST http://server:7090/api/v1/zones/3/alert \
  -d '{"kind":"bell","zones":[7,9]}'

# Your own sound
curl -X POST http://server:7090/api/v1/zones/3/alert \
  -d '{"kind":"url","url":"http://nas/sounds/washer-done.mp3"}'
```

An alert interrupts rather than queues: whatever the zone was playing is ducked and picked
up again afterwards, and the volume comes from that zone's configured alert level — not its
current one, so an announcement is audible in a room someone had turned down.

`kind` is `tts`, `bell`, `alarm`, `fire`, `buzzer` or `url`. `tts` needs `text` and takes an
optional `language`; `url` needs an `http(s)` address this server can reach. `zones` adds
more rooms to the same announcement, with the zone in the path leading it — the response
lists every room it played in.

`volume` (0–100) overrides the zone's alert level for one announcement.

`alarm` and `fire` keep going until stopped, which is what `DELETE` is for. The others end
by themselves.

A `422` means the alerts layer refused it — most often no text-to-speech provider is set up
— with `error` naming the reason. A `2xx` means it started, not that you heard it.

### Favourites, recents and groups

A favourite's `id` is its handle, for renaming, reordering, playing and removing. The
Loxone clients also carry a `slot` and a `plus` flag — a position in their own button
grid — which describe that UI rather than the favourite, so neither appears here.
Reordering is simply the order you send.

Recents are read-only apart from clearing: history has no handle to rename or reorder,
and `source` is what you hand back to `play`.

Grouping answers **200 with the resulting group**, not 204. Frame mirroring works between
outputs of one protocol, so unless the server allows mixed groups a member on another
protocol cannot join — it comes back under `rejected` with a reason, instead of leaving
you to diff what you asked for against the next zone event. An empty `members` list
ungroups; there is no separate verb for leaving.

### Output delay

`PUT /zones/{id}/output/delay` with `{"delayMs": 60}` declares how much delay a zone's speaker chain
adds *after* its audio output — an amplifier, an active speaker. It is the only output setting this
API writes.

**It points the opposite way from its name.** The client subtracts the value from every timestamp
before scheduling playback, so raising it makes that room play **earlier**, compensating for the
delay downstream of it. That is what lines up a room arriving late; a room arriving *early* has
nothing to declare, and the protocol has no negative form (`0–5000` at the device). To pull a group
together, raise the value on the room that lags — not on the one that leads.

The server keeps its own send-ahead in step: it schedules that client's audio further in advance by
the same amount, so the buffer headroom stays what it was. You can see that in `output.sync` —
`targetLeadMs` grows with `delayMs`.

The value is **persisted and applied live**: Sendspin pushes it to the client without restarting the
stream, so it is audible immediately and survives a reboot. Out-of-range values are clamped to
0–10000 ms rather than refused, because "as far as it goes" is a real request; a value that is not a
number is a `400`, because moving a speaker by accident is worse than an error.

One caveat: the device owns this setting. It persists it locally, may keep a different value per
audio output, and only honours the command if it advertised support for it — so what you write here
is a request. `output.sync` therefore reports both sides: `delayMs` is what this server asked for and
`deviceDelayMs` is what the device last declared, or `null` if it never has.

`deviceDelayMs` is **not** a confirmation of `delayMs`. A device applies the command immediately —
that is how the protocol works — and does not mention the value until the next state message it sends
for some other reason, so the two differ after every write until something else happens. Do not build
a "not applied yet" indicator on the difference; it only tells you that you just wrote.

What it is good for is the case where a device holds a value nobody here asked for, persisted locally
for the amplifier it is wired to. Whether a device accepts the command at all is a different question,
answered by the `supported_commands` it advertises.

Pass `clientId` to target one Sendspin satellite instead of the zone's own output — a subwoofer
under a pair of speakers needs its own offset.

```
PUT /zones/3/output/delay   {"delayMs": 60}
    -> 200 {"delayMs": 60, "applied": true, "clientId": null}
```

`applied: false` means the value was stored but no live output took it: the zone's protocol has no
delay, or the named satellite is not configured. That is a success, not a failure — the config is
the durable part, and a device connecting later picks it up. There is no `GET`: the current value is
`output.sync.delayMs` on the zone, and a second spelling of one value is a second thing to keep
true. The write publishes a `zone.changed`, so every other client sees it without polling.

### The queue

`GET` returns a page: `start` and `limit` (default 100, max 500) are query parameters,
and `total` is the length of the whole queue so you know whether to ask for more.
`currentIndex` is the entry playing now, or `null`.

Each entry has an **`id` that identifies the entry, not the track** — queue the same
track twice and you get two ids. That id is what `play`, `move` and `id` take. `source`
is the same opaque provider id as `ApiSource.id`, so an entry can be re-queued later.

Clearing the queue needs `{"all": true}` rather than an empty body: wiping a queue
should be something you asked for, not something a missing field happened to mean.

`volume` takes either an absolute value (`0`–`100`) or a signed `delta`. Use `delta` for
remote-control style stepping: it avoids the read-then-write race that two clients
adjusting the same zone would otherwise hit, and `volumeLimits.step` is the size a step
should have.

A zone can be capped: writing above `volumeLimits.max` lands on the cap rather than
where you asked, so render your slider against `max` instead of against 100.

`equalizer` takes ten gains in dB, low band first, clamped to `-6`..`+6` — the same
range the Loxone app uses. It replies `200` with the applied bands rather than `204`,
since a clamped value is worth seeing. Unlike the transport verbs it is configuration,
so it works on an idle zone too.

If you are an **equalizer provider** — you run the actual DSP and want the server to
reflect it — write here when your own UI changes, and read here to pick up changes made
elsewhere. The server does not push your change back to you.

Errors are `4xx` with `{"error":"…"}`: `zone-not-found`, `invalid-json`,
`invalid-volume`, `invalid-position`, `invalid-power`, `invalid-uri`, `invalid-repeat`, `invalid-shuffle`, `invalid-equalizer-bands`,
`invalid-queue-patch`, `invalid-queue-delete`, `queue-item-not-found`,
`invalid-target-zone`, `handoff-not-possible`, `handoff-failed`,
`invalid-favorite-patch`, `invalid-favorite-delete`, `invalid-favorite-order`,
`favorite-not-found`, `invalid-members`,
`invalid-alert-kind`, `invalid-text`, `invalid-zones`,
`invalid-input`, `input-not-found`, `invalid-query`,
`method-not-allowed`.

## MQTT

An optional second surface, for setups already built around a broker. It is not a
replacement for the API above: it carries zone state and the everyday transport controls,
and nothing else. Announcements, browsing, the queue, favourites, recents, the equalizer,
grouping, cover art and health checks are HTTP only.

Reach for it when a broker is already how your house talks to itself — then MQTT saves you
writing an HTTP client, and tools like Home Assistant or Node-RED consume it with no code
at all. Reach for the HTTP API when you want the whole feature set, or when adding a broker
would be infrastructure you do not otherwise need. Both can run at once, and both report
the same state: MQTT publishes from the same event source `/api/v1/events` streams from, so
the two cannot disagree.

Switch it on under **Access** in the admin UI and point it at your broker. The payload is
the same zone object described above — the API model, not Loxone's field names.

### What it publishes

```
sonn/server/online              1        (0 when the server dies — this is an MQTT will)
sonn/zones/3                    {"id":3,"name":"Kitchen","state":"playing",…}
sonn/zones/3/state              playing
sonn/zones/3/volume             40
sonn/zones/3/muted              0
sonn/zones/3/track/title        Song
sonn/zones/3/source/name        Apple Music
sonn/zones/3/output/protocol    sendspin
```

Two shapes on purpose. The `zones/<id>` topic carries the whole object as JSON. The
per-field topics carry plain scalars, because a Miniserver or a KNX gateway can subscribe
to a topic and read a number but cannot parse JSON. Booleans are `1`/`0` for the same
reason, and a field with no value is published empty rather than dropped — so a display
clears when playback stops instead of keeping the last track.

Everything is **retained**, so a consumer that connects later sees current state
immediately instead of waiting for the next change.

A topic is only written when **its own** value moved: a volume step publishes `volume` and the
JSON object, and leaves the title, album and cover url alone. So the message rate on a topic is
the rate that field actually changes at, and `mosquitto_sub` on the tree shows you changes rather
than a heartbeat. A full tree is republished on connect and reconnect, because a broker that
restarted lost its retained messages.

`sonn` is the default prefix and is configurable; two servers on one broker need different
ones. The playing-time counter (`position`) is off by default — it costs a message per
second per zone — and can be switched on in the same panel. With it off, a playing zone is
quiet until something other than the clock changes.

### Controlling it

Publish to `set/<field>` for a single value, or to `cmd` with JSON when you need more than
one at once:

```bash
mosquitto_pub -t 'sonn/zones/3/set/volume' -m '40'      # absolute
mosquitto_pub -t 'sonn/zones/3/set/volume' -m '+5'      # relative, like a remote
mosquitto_pub -t 'sonn/zones/3/set/muted'  -m '1'
mosquitto_pub -t 'sonn/zones/3/set/muted'  -m ''        # empty toggles, for a wall button
mosquitto_pub -t 'sonn/zones/3/set/state'  -m 'paused'
mosquitto_pub -t 'sonn/zones/3/set/next'   -m '1'       # value ignored

mosquitto_pub -t 'sonn/zones/3/cmd' -m '{"power":"on","volume":40}'
mosquitto_pub -t 'sonn/zones/3/cmd' -m '{"play":"applemusic:track:…"}'
```

Writable fields: `volume`, `muted`, `state`, `power`, `position`, `repeat`, `shuffle`,
`next`, `previous`, `play`. The values are the ones the state topics publish — write `paused`, not
some separate command word — and booleans accept `1`/`true`/`on`/`yes` and their opposites.
A message carrying several fields is applied in a sensible order regardless of key order:
power before volume, so `{"power":"on","volume":40}` does what it looks like, and mute
after volume, so `{"volume":40,"muted":true}` sets the level it will come back to.

An invalid value is refused whole rather than applied in part, and an unknown field is
ignored, so echoing our own state topics back does no harm.

> **Publish commands unretained.** A retained command is replayed to us every time we
> reconnect, which makes a zone lurch back to it after each restart. The server refuses
> replayed commands and *deletes* the retained message, so the surprise happens once — but
> `mosquitto_pub -r` on a command topic is never what you want.

Access is your broker's business: anyone allowed to publish to these topics can control
the audio, exactly as anyone allowed to read the state topics can watch it. Use your
broker's own credentials and per-topic ACLs.

## Examples

```bash
# What is playing everywhere?
curl -s http://server:7090/api/v1/zones | jq -r '.zones[] | "\(.name): \(.track.title // "—")"'

# Pause the kitchen, then turn it down a notch
curl -X POST http://server:7090/api/v1/zones/3/pause
curl -X PUT http://server:7090/api/v1/zones/3/volume -d '{"delta":-5}'

# Follow every change
curl -N http://server:7090/api/v1/events
```

## Notes for integrators

- **CORS** is open (`Access-Control-Allow-Origin: *`), so browser clients work directly.
- The API is **unauthenticated on the LAN**, like the other device-facing surfaces on
  port `7090`. Do not expose port `7090` to the internet.
- The API works **with or without the Loxone integration enabled** — it is not a Loxone
  surface and does not depend on one.
- Additive changes (new fields, new `source.kind` values, new event types) are **not**
  breaking. Ignore fields and event `type`s you do not know.
- **A device that reconnects is put back to playing by the server.** If a player drops off
  and returns while its zone was playing, the server starts its stream again by itself —
  the position restarts, the track and queue do not. You do not need to watch for this and
  you should not send a stop/play (or an off/on/play) to force it. Anything doing that
  today can drop it; if you still see a zone reporting `playing` with nothing audible after
  a device returns, that is a bug worth reporting rather than working around.
- **The version is in the path.** Within `v1`, fields are only ever added — nothing is
  renamed or removed under you. Anything that has to break appears as `v2`, served
  alongside `v1` rather than replacing it, so you migrate when it suits you. Calling
  `/api/...` without a version returns `404 api-version-required` and names the prefix
  to use, rather than failing in some way you have to guess at.
