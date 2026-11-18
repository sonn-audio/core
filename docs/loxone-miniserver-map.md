# Loxone Miniserver 17.3.11.12 — what it says to an Audioserver

A map of the Miniserver's side of the conversation with an Audioserver, and therefore of what
sonn core's Loxone adapter (`src/adapters/loxone`) is asked and what it is expected to answer.
The companion to [loxone-client-map.md](loxone-client-map.md), which does the same for the app.

- **Sources:** the Miniserver Gen 1 firmware 17.3.11.12 and Loxone Config 17.3.11.12, both from
  Loxone's public update server. Maintainers keep the unpacked files and the tools to reproduce
  them in `data/refcode/loxone-17.3.11.12/` (gitignored; see the README there).
- **How it was read:** the firmware image carries its log messages, its command format strings
  and the names of its C++ functions in the clear. Everything below about the Miniserver is read
  from those. **No code flow was traced in the firmware**: where this document gives an order of
  events, it is the order the log messages imply, marked *inferred*. Config was disassembled
  where noted, which is where the exact parsing rules come from.
- **What was verified against a real Miniserver and Loxone Config:** section 2 (the search
  answer and the extension search), on 2026-11-18. Nothing else.
- **What could not be read:** the Audioserver's own firmware and the audio filesystem of the
  Miniserver Compact are LUKS-encrypted. The Audioserver's half of every exchange below is
  therefore known only from what the Miniserver and Config expect of it.

In the tables, **Code** says where the string lives: `MMS` is `MultiMediaServer.cpp`
(`CMultiMediaServer`, shared with the old Music Server), `LMSV2` is `LMSV2.cpp`
(`CMultiMediaServer2`, the Audioserver — its log lines begin `PRG Audioserver`), `CO` is the
`ControlObjectMusicServer.cpp` family, `pair` is `crypt/DevicePairing.cpp`. An `MMS` command may
be Music-Server-only; which of them the Audioserver path still uses is not known. **sonn** is
what `routeRegistry.ts` does with the command today: `handled`, `placeholder` (answers
"not implemented"), or **no route** (logged as `unhandled loxone command`, answered with an
empty result).

---

## 1. The pieces

| Class | Source file | Role |
|---|---|---|
| `CDeviceDiscovery` | `DeviceDiscovery.cpp` | Runs the device searches Loxone Config asks for |
| `CLoxoneDevicePairing` | `crypt/DevicePairing.cpp` | Pairing and the secure session, for every Loxone network device |
| `CMultiMediaServer` | `MultiMediaServer.cpp` | Connection, command queue and zone commands; the Music Server generation |
| `CMultiMediaServer2` | `LMSV2.cpp` | The Audioserver: reconnection, init sequence, config push, events |
| `CControlObjectMusicServer`, `…MusicExtension`, `…MusicPlayer`, `…MusicPlayerGroup`, `…MusicZone`, `…AudioGroup`, `…AudioOut` | `ControlObject*.cpp` | The objects of the Loxone project; they call into the two classes above |

`CMultiMediaServer2` has 144 functions. Their names are the best table of contents there is; the
ones that matter are quoted in the sections below.

---

## 2. Being found (verified)

Loxone Config does not search itself. It asks the Miniserver, and both "Network device search"
and "Audio device search" make the Miniserver do the same two things: broadcast one zero byte
from UDP port 7071 to port 7070, and send an mDNS query for `_http._tcp`. `CDeviceDiscovery`
also has `SearchViaIpScan`, `SearchViaUpnp`, `SearchIntercomXl` and `SearchWallboxDevice`.

Config sorts every answer by how it begins (`LoxoneConfig.exe` 0x14041ee40):

| Answer begins with | Read as |
|---|---|
| `LoxLIVE:` or `Loxone Miniserver:` | a Miniserver |
| `{` | a generic network device: JSON with `t`, `v`, `tv`, `n`, `s`, `hn`, `p`, `do`, `di`, `if`, `master` |
| `LoxMedia` | a media server |

**An Audioserver answers with a `LoxMedia` line.** A JSON answer is how an Intercom answers; it
shows up in the network search under whatever `t` says, and never in the audio search.

```
LoxMedia IP:<ip> MAC:<serial> Product:<name> Version:<a.b.c.d> SubType:<n> Hostname:<host> Paired:<true|false> Master:<serial> State:<n> dhcp:<…>
```

- Config finds the fields by name, in this order (0x14041ffa0). `IP`, `MAC`, `Product` and
  `Version` are always read; everything from `SubType` on is optional.
- **`SubType` below 1 makes it a legacy "LOXONE Music Server"** (object type 0x34, port 7091).
  1 or higher makes it an Audioserver (object type 0xDF, port 7095), and the value is kept as the
  server's subtype.
- `Paired` is compared against the word `true`.
- A 12-character serial without separators is shown with colons; either form is accepted.
- In the JSON form, a missing `tv` is filled in from `t`: `Intercom` gives 2, `Audioserver` gives
  3. That is the only place the JSON path knows the word Audioserver, and it does not make the
  device one.
- The Miniserver keeps one answer per IP address, and a burst of answers from one address empties
  the result list.

Verified with: `LoxMedia IP:… MAC:504F94FEED01 Product:Audioserver Version:17.3.11.12 SubType:1 Hostname:… Paired:false`
— listed as "Audioserver", addable. The same line with `SubType:0` was listed as "LOXONE Music
Server". `Paired:true` with `Master:` has not been seen in Config yet.

A real Audioserver also advertises over mDNS, but not with these fields: `_http._tcp` as
`webadmin as<last three bytes of the MAC>` on port 80 with an empty TXT record, and
`_loxone._tcp` as `loxonemusic_<serial>` (from a capture posted in issue #114). sonn does neither
and is found without.

Implemented in `src/adapters/loxone/http/loxoneUdpDiscovery.ts`; `tests/loxoneDiscovery.test.ts`.

### Extensions (verified)

An Audioserver's extensions are Tree Turbo devices, and Config's "Tree Turbo search" on a saved
Audioserver sends no search command at all. While the dialog is open the Miniserver asks
`audio/cfg/getconfig` about every five seconds (captured on port 7095, which is plain WebSocket),
and Config lists the devices under `extensions` in the answer that the project does not have:

```json
{ "getconfig_result": { "crc32": "…", "extensions": [ { "type": 3, "subtype": 0, "id": 1, "mac": "504F94FEED01", "version": "18.1.0.0" } ] } }
```

- `type`, `subtype` and `id` are read as **numbers** (`LoxoneConfig.exe` 0x140d577c0). Sent as
  strings, the device is left out without a word.
- **`type` 3 is listed as "Stereo Extension"**, type 6 as an amplifier shutdown device
  ("Versterkeruitschakeling" in the Dutch UI). Types 1, 2, 4, 5 and 7–10 are not listed in this
  dialog. Type 6 also gets a port appended to its address.
- Config also reads `mac`, `version`, `dhcp`, `ip`, `host`, a `versionstring` fallback and a
  nested `clients` list per device; `mac` and `version` were enough.

**Adding one does not reach the server until the project is saved** (captured). Clicking the
plus in the dialog sends `GET /audio/cfg/identify/<extension serial>/acoustic/1,2` over plain
HTTP on port 7091, then `GET /audio/cfg/identify/off`; nothing else. "Save in Miniserver" makes
the Miniserver drop the connection and open a new one about thirty seconds later (section 3),
and the extension arrives with `audio/cfg/setconfig/…` right after the first `getconfig`.

The server has to describe the extensions the project already has in the same form. Listed
without a numeric `type`, a known extension shows up in the dialog as an unused "Audio zone"
waiting to be added.

sonn offers the extensions added in its Zones view that are not in the project yet
(`unlearnedExtensions` in `configHandlers.ts`).

---

## 3. Connecting

*Inferred from the `HReconn` / `CheckDevSerial` / `MainLoop` log lines of `LMSV2.cpp`.*

**Captured on 2026-11-18** (Miniserver Gen 1, 17.3.11.10, against sonn on port 7095, plain
WebSocket), the opening of a connection after a "Save in Miniserver":

1. `GET /` with `Upgrade: WebSocket`, `Sec-WebSocket-Protocol: miniserver`,
   `Origin: <miniserver ip>`.
2. The server's banner: `MINISERVER V LWSS V <firmware> <serial> | ~API:1.6~ | Session-Token: <token>`.
3. `audio/cfg/miniservertime/<unix time>`
4. `secure/info/pairing`
5. `secure/hello/<unix time>/<base64 certificate chain>`
6. `secure/init/<JWT>` — header `RS256`, claims `sub: secure-session-init`, `iat`, `exp`,
   `session_token` (the token from the banner), `session_keys`, `encryption_type: 1`.
7. `secure/info/pairing` again.

The capture ends there. Closing a search dialog in Config makes the Miniserver send
`GET /audio/cfg/identify/off` over plain HTTP on port 7091.

1. The Miniserver opens a WebSocket to the Audioserver ("no connection, attempt connection via
   Websocket"). It can use **mTLS** and fall back to the plain port ("mTLS … times -> fall
   back to plain transport + re-probe version"; functions `ApplyTransport`,
   `FallbackToPlainTransport`, `PlainPortReachable`). Which it tries first is not in the strings.
2. It expects a **banner** as the first frame and takes the Audioserver's serial from it
   (`ParseInitMessage`; the strings `MINISERVER V ` and `Session-Token: ` are what it looks for).
   "connected without a banner" and "sessionSerial EMPTY but socket established -> Close for
   fresh reconnect+banner" are the failure paths: no banner, no session.
3. `CheckDeviceSerialAndPairing` compares that serial with the one in the project. An empty
   project serial is filled in from the session. A **mismatch raises a system message and stops**
   ("SERIAL MISMATCH cfg='%s' session='%s'").
4. It then decides whether to pair and whether to start a secure session ("HandleReconnection
   fork: needPair=%d needSecure=%d secureActive=%d pairState=%d pairingStatus=%d") — section 4.
5. Once the session stands, `HandleInit` runs — section 5.

While connected it sends a keep-alive and closes the connection on a timeout. In the Music Server
code the string next to "send alive" is `audio/cfg/mac`, and `mac_result` sits next to "got alive
answer" (*inferred from adjacency*); the Audioserver class has its own `AliveMessage`, whose
command is not literal in the image. An answer of
**`not authorized`** means the secure session is gone: the first one is tolerated, the second
triggers a reconnect, rate-limited (`OnNotAuthorizedEvent`).

---

## 4. Pairing and the secure session

`CLoxoneDevicePairing` is shared by every Loxone network device; the Audioserver is one user.

**States**, as the firmware names them: uninitialized → Websocket Established → Sent:Hello →
Received:HELLO → Sent:Secure Init → Received:Secure Init → *Secure Session Initialized* →
(Pairing needed → Sent:Pair Request → Received:Pair Request →) *Paired*. Side branches: Paired
with other master, Sent/Received:Unpair Request, Sent/Received:Recovery Request, Secure Session
Ended, Unpaired.

**Messages.** The command names are built from a prefix (`SetCommandPrefix`,
`SetPairingPrefix`), so only parts are literal in the image: `info/pairing`, `secure/pair`,
`secure/wrapper/`, and these bodies:

```
{"command": "pair-request",            "session_token": "%s", "installation_id": "%s"}
{"command": "forget-request",          "session_token": "%s", "installation_id": "%s"}
{"command": "recovery-request",        "session_token": "%s", "installation_id": "%s"}
{"command": "peers-request",           "session_token": "%s", "peers": [%s]}
{"command": "secure-session-destroy",  "session_token": "%s"}
```

- **Hello:** the Miniserver sends its certificate chain and expects one back (`public_key`;
  "parsed peer cert-chain from hello", "LoadAndVerifyCertificateChain", "LoadPublicKey").
  "no_context -> ABORT (peer did not return a hello/cert-chain)". An answer of "ok (already
  authorized)" over mTLS skips `secure/init` and goes straight to `secure/pair`.
- **Secure init:** a JWT with `sub` = `secure-session-init`, `session_token`, `encryption_type`,
  `session_keys` and a validity time, signed with the Miniserver's factory RSA key
  (`CreateInitJWT`). The session keys are encrypted with the peer's public key; without that key
  they are left out and "the peer WILL reject" — the firmware calls this the root cause of
  `not authorized`. Success is `secure-session-init-success`, and the peer's session token has to
  match the local one. Over mTLS a bare acknowledgement counts.
- **Info:** the answer to `secure/info/pairing` is parsed as `error` (status), `master`, `start`,
  `end`, `peers`. The statuses the firmware can name: ok (is master), ok (is peer), ok (already
  authorized), certificate error, init failed, jwt not verified, already paired, not paired,
  pairing error, forget error, recover error, wrapper error, status error, peer error, not in
  secure session, paired to other master, no response from peer, invalid session, malformed
  request, invalid install id, result / request mismatch. The firmware's own log (below) gives
  the effect of each status the server answers with:

  | `error` answered | `needPair` | What the Miniserver does next |
  |---|---|---|
  | `0`, `1`, `-80`, `-81` | 0 | secure session, then straight to init |
  | `-82` | **1** | secure session, then `secure/pair/<token>` |

  `-82` is therefore "not paired"; the others count as paired. Tested with `master` set to the
  Miniserver's own serial; a different master was not tried. sonn answers `-81`.
- **Pair:** sent as `secure/pair/<token>`. The Miniserver expects an answer whose `command`
  is exactly `secure/pair`; an answer that echoes the whole command fails with
  "result / request mismatch" (Error-Id -126), and it starts over from hello. sonn has no route
  for it, so a sonn that answered `-82` would never get paired.

  **It cannot be answered without the session keys** (tried 2026-11-18, against the debug log).
  The token after `secure/pair/` is encrypted: it decodes to random bytes, not JSON. Answers with
  the right `command` and `error: 0` — plain with the session token, with a JWT, with both, and
  wrapped in `secure_pair_result` — all passed the envelope check (`CHK;error: No Error`) and
  were still refused (`HandlePairReceive: failed, lastError=No Error`). The firmware's own
  "mTLS bare ack accepted as PAIRED (no session_token echo required)" says what is missing on the
  plain path: the session token, echoed under the session's AES layer. The keys for that layer
  come in `secure/init`, encrypted with the public key from the peer's hello — which sonn can
  only give as the Miniserver's own, since the chain has to verify against Loxone's CA. So sonn
  stays on answering `-81`, which skips pairing.
- **Pair (from the strings):** `pair-request` with the installation id. `pair_wrong_installation_id` is tolerated
  when `info/pairing` already confirmed the same master. Over mTLS a bare acknowledgement is
  accepted as paired.
- After pairing the Miniserver saves a recovery key (`/sys/cert/recovery.key`).
- `secure/wrapper/` is how a command is sent inside the session; in mTLS mode the request is
  base64 only, with no AES layer ("EncodeRequest: mTLS mode -> base64 only").

The Miniserver will not push a configuration without a secure session ("Do not set config
without secure session, pairingstate is %d").

sonn handles `secure/hello`, `secure/init`, `secure/authenticate` and `secure/info/pairing`.
It has no route for `secure/pair` or `secure/wrapper/`.

| Command | Code | sonn |
|---|---|---|
| `secure/info/pairing` | pair | handled |
| `secure/init` | pair | handled |
| `secure/pair` | pair | **no route** |

---

### Reading the Miniserver's own log

All of the above can be watched live. In Loxone Config, *Miniserver → Debug settings → Send
data to: user defined*, with an IP address and port 7777, makes the Miniserver stream its log
there as UDP; the packet format is decoded in
[sarnau/Inside-The-Loxone-Miniserver](https://github.com/sarnau/Inside-The-Loxone-Miniserver)
(`Code/LoxoneMonitorServer.py`, the logging part). The lines quoted in this document (`PRG
Audioserver …`, `LoxoneDevicePairing: …`) arrive as plain text, with the state and error names
next to their numbers, e.g. `state: Sent:Hello(State-Id: 6) -> Received:HELLO(State-Id: 7)`.

States seen: uninitialized 3, Sent:Hello 6, Received:HELLO 7, Sent:Secure Init 8,
Secure Session Initialized 10, Sent:Pair Request 12. Errors seen: No Error 0,
result / request mismatch -126.

## 5. The init sequence

*Inferred from the `HandleInit` log lines.* The server is offline to the app until this
completes.

1. **Request the configuration:** `audio/cfg/getconfig`. Until `getconfig_result` arrives,
   `HandleInit` returns and retries ("getconfig NOT received yet (fails=%d)").
2. **Compare:** `CompareCrc Miniserver %08x Musicserver %08x`. If they differ, or the server
   reports "no local configuration", the Miniserver sends `audio/cfg/setconfig/<payload>` and
   `audio/cfg/setconfigtimestamp/%d`.
3. **Set the players**, once the Miniserver's own program has run more than three cycles
   ("setplayer waiting for SPS (cycle=%d, need >3)"). Six steps, named in the failure message:
   `SetSpeakerTypes` (`audio/cfg/speakertype/`), `SetDefaultVolumes` (`audio/cfg/volumes/`),
   `SetPlayerNames` (`audio/cfg/playername/`), `SetPlayerOptions` (`audio/cfg/playeropts/`),
   `SetPresetLinks` (`audio/cfg/playercfg/%d/roomfavprio/%s`), `SetPresenceStates`
   (`audio/cfg/presencemode/%s/on|off`). **If any of them returns false the server stays offline
   and the whole step is retried.**
4. **Online:** "SERVERSTATE_ONLINE set -- init complete, AudioServer should now show online".

Server states: `ONLINE`, `INITIALIZING`, `UPDATING`, `REBOOTING`, `NOT_REACHABLE(offline)`.

Around this the Miniserver also sends `audio/cfg/ready`, `audio/cfg/miniserverip/`,
`audio/cfg/miniserverversion/%s/%s`, `audio/cfg/miniservertime/%d`, `audio/cfg/timezone/%s`,
`audio/cfg/groupopts/` (`SetGroupOptions`), `audio/cfg/getroomfavs/all` and periodic
`audio/cfg/healthcheck/…` (answer: `healthcheck_response`).

**The Miniserver does not read the answers to these.** Its log shows every one of them as
`unprocessed Event <name>_result` (`speakertype`, `volumes`, `playername`, `groupopts`,
`playeropts`, `presencemode`, `miniserverip`, `miniserverversion`, `timezone`, `bluetooth`,
`setconfigtimestamp`, `ready`), and init completes either way: "false" for a step means the
command could not be sent, not that it was refused. sonn acknowledges them all
(`settingHandlers.ts`) and logs their decoded payloads; `playercfg/…/roomfavprio` was not sent by
a 17.3.11.12 Miniserver.

Captured payloads, decoded from base64 JSON:

| Command | Payload |
|---|---|
| `playeropts` | `{"players":[{"playerid":29,"rf":"off","lock":"off","ap":"on","sp":"on"}, …]}` — `rf` room-favourite priority, `ap` AirPlay, `sp` Spotify Connect |
| `groupopts` | `{"groups":[{"groupid":"<uuid>","name":"Woonkamer","mode":1,"sp":"on","ap":"on"}]}` — AirPlay and Spotify Connect for a player group, which override the players' own |
| `volumes` | `{"players":[{"playerid":29,"default":10,"alarm":75,"fire":75,"bell":40,"buzzer":10,"tts":20,"volstep":1,"fading":0,"maxVolume":100}, …]}` |
| `speakertype` | `{"speakers":[{"id":"<serial>#1","speakerType":3}, …]}` |
| `playername` | `{"players":[{"playerid":29,"name":"Werkkamer"}, …]}` |

Plain: `presencemode/<ids>/off`, `miniserverip/<ip>/<mask>/<gateway>/<dns,dns>/<own ip>/static`,
`miniserverversion/<a>/<b>`, `timezone/<Area/City>`, `bluetooth/<zone>/visible`.

---

## 6. Everything it sends

### Zone commands

| Command | Code | sonn |
|---|---|---|
| `audio/%d/%s` | MMS | **no route** |
| `audio/%d/%s/%d` | MMS | **no route** |
| `audio/%d/alarm/%d` | MMS | handled |
| `audio/%d/bell/%d` | MMS | handled |
| `audio/%d/firealarm/%d` | MMS | handled |
| `audio/%d/linein/%s` | LMSV2 | handled |
| `audio/%d/lock/%s` | LMSV2 | **no route** |
| `audio/%d/mastervolume/%d` | MMS | handled |
| `audio/%d/off` | MMS | handled |
| `audio/%d/on` | MMS | handled |
| `audio/%d/pause` | MMS | handled |
| `audio/%d/play` | MMS | handled |
| `audio/%d/play/%d` | MMS | handled |
| `audio/%d/position/%d` | MMS | handled |
| `audio/%d/queueminus` | MMS | handled |
| `audio/%d/queueplus` | MMS | handled |
| `audio/%d/repeat/%d` | MMS | handled |
| `audio/%d/resume` | MMS | handled |
| `audio/%d/roomfav/play/%d` | MMS | handled |
| `audio/%d/roomfav/play/%d/%d` | MMS | handled |
| `audio/%d/roomfav/playvolume/%d/%d` | LMSV2 | **no route** |
| `audio/%d/roomfav/plus` | MMS | handled |
| `audio/%d/shuffle/%d` | MMS | handled |
| `audio/%d/sleep/%d` | MMS | **no route** |
| `audio/%d/stop` | MMS | **no route** |
| `audio/%d/tracktime` | MMS | **no route** |
| `audio/%d/tts/%s\|%s/%d` | MMS | handled |
| `audio/%d/volume/%d` | MMS | handled |
| `audio/%d/volume/+%d` | MMS | handled |
| `audio/%d/volume/-%d` | MMS | handled |
| `audio/%d/wecker/%d` | MMS | handled |
| `audio/cec/%s/%s/%s` | LMSV2 | **no route** |

`audio/%d/%s` and `audio/%d/%s/%d` are generic builders; the verbs passed to them include the
ones listed separately. The `%%d` forms are templates the Miniserver stores per zone and fills
in later; they are folded into the plain forms here.

### Grouped commands

| Command | Code | sonn |
|---|---|---|
| `audio/grouped/%s/%d` | LMSV2 | handled |
| `audio/grouped/%s/%d~%d` | MMS | handled |
| `audio/grouped/%s/off/%d` | MMS | handled |
| `audio/grouped/playeventfile/` | CO | handled |
| `audio/grouped/playeventfile/%d~%u/Event_Sounds/%s` | CO | handled |
| `audio/grouped/tts/%d/%s` | LMSV2 | handled |
| `audio/grouped/tts/%d/%s\|%s` | LMSV2 | handled |
| `audio/grouped/tts/%d/0` | LMSV2 | handled |

`audio/grouped/%s/…` carries an event type (`bell`, `alarm`, `firealarm`, `buzzer`, `tts`);
the id list uses `~` between player and volume in the event forms.

### Configuration pushed to the server

| Command | Code | sonn |
|---|---|---|
| `audio/cfg/%s/%d` | LMSV2 | **no route** |
| `audio/cfg/airplay` | MMS | **no route** |
| `audio/cfg/airplay/disable` | MMS | **no route** |
| `audio/cfg/airplay/enable` | MMS | **no route** |
| `audio/cfg/blinkpos/%d/%d` | MMS | **no route** |
| `audio/cfg/bluetooth/%s` | LMSV2 | **no route** |
| `audio/cfg/defaultvolume/%d/%d` | MMS | handled |
| `audio/cfg/equalizer/%d` | MMS | handled |
| `audio/cfg/equalizer/%d/!%s` | MMS | handled |
| `audio/cfg/errortts/disable` | MMS | **no route** |
| `audio/cfg/errortts/enable` | MMS | **no route** |
| `audio/cfg/eventvolumes/%d/` | MMS | handled |
| `audio/cfg/groupopts/` | LMSV2 | handled |
| `audio/cfg/identify/%s` | MMS | handled |
| `audio/cfg/identify/%s/acoustic` | MMS | handled |
| `audio/cfg/identify/off` | MMS | handled |
| `audio/cfg/maxvolume/%d/%d` | MMS | handled |
| `audio/cfg/miniserverip/` | LMSV2 | placeholder |
| `audio/cfg/miniservertime/%d` | LMSV2 | handled |
| `audio/cfg/miniserverversion/%s/%s` | LMSV2 | placeholder |
| `audio/cfg/playercfg/%d/airplay/%s` | LMSV2 | **no route** |
| `audio/cfg/playercfg/%d/roomfavprio/%s` | LMSV2 | **no route** |
| `audio/cfg/playercfg/%d/spotify/%s` | LMSV2 | **no route** |
| `audio/cfg/playername/` | LMSV2 | handled |
| `audio/cfg/playeropts/` | LMSV2 | placeholder |
| `audio/cfg/presencemode/%d/%s` | LMSV2 | placeholder |
| `audio/cfg/presencemode/%s/off` | LMSV2 | placeholder |
| `audio/cfg/presencemode/%s/on` | LMSV2 | placeholder |
| `audio/cfg/setasdefault/` | LMSV2 | **no route** |
| `audio/cfg/setconfig/` | LMSV2 | handled |
| `audio/cfg/setconfigtimestamp/%d` | LMSV2 | handled |
| `audio/cfg/setlanguage/%s` | MMS | **no route** |
| `audio/cfg/setplayername/%d/%s` | MMS | **no route** |
| `audio/cfg/speakertype/` | LMSV2 | placeholder |
| `audio/cfg/speakertype/%d/%d` | MMS | placeholder |
| `audio/cfg/spotifyconnect` | MMS | **no route** |
| `audio/cfg/spotifyconnect/disable` | MMS | **no route** |
| `audio/cfg/spotifyconnect/enable` | MMS | **no route** |
| `audio/cfg/timezone/%s` | LMSV2 | placeholder |
| `audio/cfg/upnpsetboot/%d/%d` | MMS | **no route** |
| `audio/cfg/upnpsetmode/%d/%d` | MMS | **no route** |
| `audio/cfg/upnpsetpredelay/%d/%d` | MMS | **no route** |
| `audio/cfg/usetrigger/disable` | MMS | **no route** |
| `audio/cfg/usetrigger/enable` | MMS | **no route** |
| `audio/cfg/volumes/` | LMSV2 | handled |

### Identity, lifecycle and maintenance

| Command | Code | sonn |
|---|---|---|
| `audio/cfg/callback/action/%d/%d` | MMS | **no route** |
| `audio/cfg/delete/%d` | MMS | **no route** |
| `audio/cfg/disable/%d` | MMS | **no route** |
| `audio/cfg/enable/%d` | MMS | **no route** |
| `audio/cfg/iamaminiserver/%s` | MMS | **no route** |
| `audio/cfg/iamaminiserverdone` | MMS | **no route** |
| `audio/cfg/installupdate` | MMS | **no route** |
| `audio/cfg/miniserverinit/%s` | MMS | **no route** |
| `audio/cfg/miniserverport/%d` | MMS | **no route** |
| `audio/cfg/ready` | LMSV2 | handled |
| `audio/cfg/reboot` | LMSV2 | **no route** |
| `audio/cfg/reconfigplayers` | MMS | **no route** |
| `audio/cfg/reloadcertificates` | LMSV2 | **no route** |
| `audio/cfg/restart` | MMS+pair | handled |
| `audio/cfg/setlastconfig/%s` | MMS | **no route** |
| `audio/cfg/setmaster/%s` | LMSV2+MMS | **no route** |
| `audio/cfg/setnetwork` | MMS | **no route** |
| `audio/cfg/setnetwork/` | LMSV2 | **no route** |
| `audio/cfg/standby` | MMS | **no route** |
| `audio/cfg/updatelevel/%d` | MMS | **no route** |

### Queries

| Command | Code | sonn |
|---|---|---|
| `audio/cfg/all` | MMS | **no route** |
| `audio/cfg/diagcmd/%s` | LMSV2 | **no route** |
| `audio/cfg/diaginfo` | LMSV2 | **no route** |
| `audio/cfg/diaginfo/%s` | LMSV2 | **no route** |
| `audio/cfg/diagnosis` | LMSV2 | handled |
| `audio/cfg/diagnosis/%s` | LMSV2 | handled |
| `audio/cfg/diagnosis/%s/%s` | LMSV2 | handled |
| `audio/cfg/getconfig` | LMSV2 | handled |
| `audio/cfg/getmaster` | MMS | **no route** |
| `audio/cfg/getmonitorstatus` | MMS | **no route** |
| `audio/cfg/getpairedmaster` | MMS | **no route** |
| `audio/cfg/getplayersdetails` | MMS | **no route** |
| `audio/cfg/getroomfavs/%d/0/%d` | MMS | handled |
| `audio/cfg/getroomfavs/%d/0/%d/?q&cmVzaXplPXRydWU=` | LMSV2 | handled |
| `audio/cfg/getroomfavs/all` | LMSV2 | handled |
| `audio/cfg/getsyncedplayers` | MMS | **no route** |
| `audio/cfg/healthcheck/` | LMSV2 | **no route** |
| `audio/cfg/healthcheck/%s%s` | LMSV2 | **no route** |
| `audio/cfg/mac` | MMS | **no route** |
| `audio/cfg/monitor/` | MMS | **no route** |
| `audio/cfg/monitorExtension/` | LMSV2 | **no route** |

### Searches run through the Audioserver

| Command | Code | sonn |
|---|---|---|
| `audio/cfg/searchclients/%s` | LMSV2 | **no route** |
| `audio/cfg/searchnet/%s/%s` | LMSV2 | **no route** |
| `audio/cfg/searchupnp` | MMS | **no route** |

- **`audio/cfg/searchclients/%s`** (`SendClientSearchRequest`) asks the Audioserver for the
  devices it can see. It is **not** what the Tree Turbo search uses (section 2); most likely it
  is the search for client speakers. The answer is `searchclients_result` with `extensions`, `clients`, `ttfw`,
  `non_audio` and `versionstring`; Config reads per device `id`, `mac`, `ip`, `host`, `type`,
  `subtype`, `version` and `dhcp` (`LoxoneConfig.exe` around 0x140d56c40). Config shows them as
  "Network Speakers", "Client Speakers", "Tree Turbo Devices" and "Audio Devices", and refuses to
  search until the server has been saved into the Miniserver. What `%s` is, the values of `type`
  and `subtype`, and how the lists are nested are **not known**.
- **`audio/cfg/searchnet/%s/%s`** (`SendNetworkSearchRequest`) answers with `searchnet_result`.
- **`audio/cfg/searchupnp`** is the Music Server's search; results arrive as `searchupnp_event`.

---

## 7. What it listens for

Names the firmware compares incoming frames against. A frame it does not know is logged as
"unprocessed Event %s".

**Results:** `getconfig_result`, `configall_result`, `getplayersdetails_result`,
`getsyncedplayers_result`, `getroomfavs_result`, `getmonitorstatus_result`, `mac_result`,
`getmaster_result`, `getpairedmaster_result`, `mastervolume_result`, `defaultvolume_result`,
`maxvolume_result`, `equalizer_result`, `standby_result`, `poweroff_result`, `reboot_result`,
`diagnosis_result`, `diagcmd_result`, `searchclients_result`, `searchnet_result`,
`healthcheck_response`.

**Events:**

| Event | Handler | What is known |
|---|---|---|
| `audio_event` | `OnAudioEvent` | Fields read: `playerid`, `audiotype`, `duration`, `plrepeat`, `plshuffle`, `coverurl`, `audiopath`, `playlistId`, `clientState`, `max_volume`, `default_volume`. Logged as power, mute, source, volume, play state, duration, progress, title, artist, album, cover, station |
| `audio_sync_event` | `OnAudioSyncEvent` | The group list; the Miniserver re-publishes it |
| `audio_queue_event` | | |
| `event_event` | `OnEventEvent` | Per player, an event state (an alert starting or ending) |
| `roomfav_event`, `roomfavchanged_event` | `OnRoomFavEvent`, `OnRoomFavoritesEvent` | "playing slot" |
| `mastervolumechanged_event` | `OnMasterVolumeChangedEvent` | `mastervolume` |
| `equalizerchanged_event` | | `equalizer` |
| `hw_event` | `OnHardwareEvent` | `client_id`, `event_id` — the heartbeat values sonn already sends |
| `extension_online_event` | `OnExtensionChangedEvent` | |
| `player_modified_event` | `OnPlayerModifiedEvent` | |
| `new_audio_device`, `event_newdevice` | `OnNewDeviceEvent` | `id`, `serial`, `master`, `ori_master`, `subtype`, `new_tt_device` ("New Device Event. id: %s, serial: %s, master: %s") |
| `event_devicestatus` | `OnDeviceUpdatestatus` | |
| `presence_event` | `OnPresenceEvent` | |
| `addhistory_event` | `OnHistoryEvent` | `player_id`, `roomfav_id`, `targetUuid` |
| `cec_event` | `OnCECEvent` | |
| `dialog_event`, `popup_event` | | `messageid`; forwarded to the Miniserver's message centre (`MsgCenterEntry`) |
| `reboot_event`, `restart_event`, `update_event`, `goingtostandby_event` | | Move the server state to rebooting / updating |
| `searchupnp_event` | | Music Server search results |

`clientState` values the firmware names: `starting`, `rebooting`, `updating`.

The Miniserver answers one thing itself: when a zone has no favourites it fabricates
`getroomfavs_result` with a single slot named "Please Reopen Room Mode".

---

## 8. What sonn does not answer

Commands with no route, by how much they are likely to matter. The first group is in the
Audioserver's own code path (`LMSV2`); the rest may be Music-Server-only.

- **Init and health:** `audio/cfg/healthcheck/…`, `audio/cfg/playercfg/%d/roomfavprio|airplay|spotify/%s`,
  `audio/cfg/setasdefault/`, `audio/cfg/bluetooth/%s`.
- **Pairing:** `secure/pair`, `secure/wrapper/`, `audio/cfg/reloadcertificates`.
- **Searches:** `audio/cfg/searchclients/%s`, `audio/cfg/searchnet/%s/%s`.
- **Zone:** `audio/%d/stop`, `audio/%d/sleep/%d`, `audio/%d/lock/%s`, `audio/%d/tracktime`,
  `audio/%d/roomfav/playvolume/%d/%d`, `audio/cec/%s/%s/%s`.
- **Maintenance:** `audio/cfg/reboot`, `audio/cfg/diaginfo`, `audio/cfg/diagcmd/%s`,
  `audio/cfg/monitor/`, `audio/cfg/monitorExtension/`, `audio/cfg/setnetwork/`.
- **Music Server generation (`MMS`):** `audio/cfg/all`, `audio/cfg/mac`,
  `audio/cfg/getplayersdetails`, `audio/cfg/getsyncedplayers`, `audio/cfg/iamaminiserver/%s`,
  `audio/cfg/setmaster/%s`, `audio/cfg/getmaster`, `audio/cfg/getpairedmaster`,
  `audio/cfg/airplay|spotifyconnect|errortts|usetrigger/enable|disable`, `audio/cfg/standby`,
  `audio/cfg/upnpset…`, and the rest of the tables above.

Of these, `audio/cfg/mac` is worth a look: if it is the keep-alive on the Audioserver path too
(section 3), sonn answers it with an empty result rather than `mac_result`.

## 9. Open questions

- The order and the exact frames of the hello / init / pair exchange, and the number behind each
  pairing status. Readable only by tracing the firmware's code or by capturing a real pairing.
- Which `MMS` commands the Audioserver path still sends.
- The `setconfig` payload: the Miniserver forwards it; Loxone Config builds it.
- `searchclients`: the argument and the shape of the answer (section 6).
- What a real Audioserver puts in `Product`, `State` and `dhcp` of its `LoxMedia` line.
