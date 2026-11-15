# Loxone app 17.3.0 — the client code that talks to an Audioserver

A map of the code in the Loxone app that speaks to an Audioserver, and therefore to sonn core's
Loxone adapter (`src/adapters/loxone`). Written for whoever has to answer "what does the app
send, and what must we send back for it to accept it".

- **Source:** the Loxone app for macOS, version 17.3.0 (`com.loxone.groot`, build 272553), an
  Electron app. Its JS is in `Loxone.app/Contents/Resources/app.asar`.
- **Line numbers** below refer to prettified copies of the app's bundles. Those are not part of
  this repository — they are the app's own code. To reproduce them:
  1. `npx @electron/asar extract <Loxone.app>/Contents/Resources/app.asar <dir>`
  2. `npx prettier --parser babel --print-width 140` over `www/scripts/AppHub.js`,
     `www/shared-app.js`, and `www/scripts/scripts10.js`, `scripts11.js`, `scripts5.js`,
     `controls1.js`.

  Maintainers keep them in `data/refcode/loxone-app-17.3.0/pretty/` (gitignored), together with
  two boilerplate-stripped dumps that are far easier to read than the bundles:
  `audio-schemas.txt` (every command schema, `shared-app.js` lines 0–18400) and
  `events-schemas.txt` (every event schema, `AppHub.js` lines 16200–16960). Each module in a dump
  starts with `#### L<line in the bundle> <module id>`; `strip-modules.js` next to them
  regenerates both.
- **Files referred to:**
  - `AppHub.js` — transport, events, manager
  - `shared-app.js` — typed command library and repositories
  - `scripts10.js`, `scripts11.js`, `scripts5.js`, `controls1.js` — legacy `MediaServerComp`
- **Executable form of this contract:** `tests/loxoneClientEvents.test.ts` (events),
  `tests/loxoneClientCommands.test.ts` (command answers) and
  `tests/loxoneClientSchemas.test.ts` (queue, recents, favourites) transcribe the client's zod
  schemas and parse what we emit with them. When this document and those tests disagree, the
  tests are what `npm test` enforces.

Claims are from reading the code unless marked *inferred*. Nothing here was verified against a
running app.

---

## 1. Two clients, one of which matters

| | Modern stack | Legacy `MediaServerComp` |
|---|---|---|
| Files | `AppHub.js`, `shared-app.js` | `scripts10.js` |
| Serves | media servers of `type === 2` (`LXMUSIC_V2`, the Audioserver) | `type === 1` (old Music Server) only (`scripts10.js:565-588`) |
| Style | zod schemas, promises, repositories | event channels, loaders, hand-built strings |
| Talks to us | **yes** | no — but it shares the wire conventions |

Neither wraps the other. Everything in §2–§6 is the modern stack; §7 summarises the legacy one.

### Layers of the modern stack

| Layer | Where | Role |
|---|---|---|
| `AudioServerManager` | `AppHub.js:17300` (module 577408), instantiated at `:14830` as `window.AudioServerManager` | One data source + repository per Audioserver that has at least one `AUDIO_ZONE_V2` control pointing at it (`_onStructureReady`/`_createOrSync`, `:17356-17455`) |
| `AudioServerDataSource` | `AppHub.js:15001-16197` (module 296328) | WebSocket, greeting, auth, request/response matching, event dispatch |
| Event schemas | `AppHub.js:16283-16950` | `eventSchema` (module 383177) and one module per event |
| Command schemas | `shared-app.js:1-18130` | ~85 zod schemas: params → wire string, response validation |
| `AudioServerRepository` | `shared-app.js:19546` (module 871259) | Façade; creates Cover, Grouping, LocalPlaylist, LocalLibrary, GlobalSearch, Spotify, Soundsuit, Radio repositories (`:19570-19610`) and per player Favorites, RecentlyPlayed, Queue, LoxoneRadio (`:20006`) |
| AudioZoneV2 control | `shared-app.js:75561` (module 504874), `AppHub.js:29437` | UI; not analysed in depth |

### What does *not* go to us

- Zone transport from the control card goes to the **Miniserver**: `jdev/sps/io/<zone uuid>/<cmd>`
  with `play`, `pause`, `on`, `off`, `svpower/on|off`, `next`, `prev`, `volume/%d`, `volstep/%d`,
  `volUp`, `volDown`, `progress/%d`, `playZoneFav/%d`, `roomfav/plus`, `tts/%s`,
  `presence/on|off` (`scripts5.js:496-515`, `controls1.js:1454-1569`).
- Grouping and per-zone `clientState` are read from Miniserver states (`grouping`,
  `GroupingRepository` at `shared-app.js:22151`; `AudioServerStateContainer` at `AppHub.js:60703`).
  `audio_sync_event` is validated but has no consumer.

---

## 2. Connection

`_connect`, `AppHub.js:15780-15840`; target selection `:15394-15485`.

- **Server entry:** `ActiveMSComponent.getStructureManager().getMediaServerSet()`, entries with
  `type === 2` and a string `uuidAction`. Fields used: `uuidAction`, `host`, `mac`, `subType`
  (0 Audioserver, 1 MiniserverCompact, 5 Install7), `name`, `deviceType`, `states`.
- **Gate:** the client only connects when the Miniserver reports, for the server's uuid,
  `connState === 10` (READY) and `serverState === 2` (ONLINE), and reach mode is LOCAL or REMOTE.
  Otherwise it closes with code 4002.
- **Host/port:** `(state.host || mediaServer.host).split(":")`; port defaults to `"7091"`.
- **URL**, with `p` the attempt counter:
  - LOCAL and not every third attempt: `ws://<ip>:<port>` when subType is COMPACT, or
    `certificateValid` is false, or the host is not an IP, or `p` is odd; otherwise
    `wss://<ip with . and : as ->.<serial>.dyndns.loxonecloud.com:<port>/`.
  - REMOTE, or every third attempt: `<miniserver url, http→ws>/proxy/<uuidAction>/`.
- **Socket:** `new WebSocket(target, "remotecontrol")`. No headers, no auth in the URL.
- **HTTP base** for side channels: the same target with `ws`→`http`.

### Greeting

The server speaks first. The frame must match

```
/^LWSS V ([^ ]*) \| ~API:(.*)~ \| Session-Token: (.*)$/
```

(`AppHub.js:17068-17098`) → firmware, api, session token. It must arrive within 5000 ms (direct)
or 15000 ms (proxied), else the attempt fails.

Features are derived from the greeting (`shared-app.js:5-21`); each needs api ≥ 1.6 and:

| Feature | Firmware ≥ |
|---|---|
| RecentlyPlayed | 15.3.12.19 |
| SpotifySoundsuitNewLogin | 15.3.11.20 |
| PlayWithEnforcedUser | 15.5.01.13 |
| ShuffleSwitch | 16.1.09.23 |
| AuthenticatedCustomUrls | 17.0.0.0 |
| LoxoneRadio | 17.0.0.0 |
| LoudnessSwitch | 18.1.0.0 |

### Authentication

`_authenticate`, `AppHub.js:16114-16190`.

1. Send `audio/cfg/getkey/full`. Reply:
   `{"command":"audio/cfg/getkey/full","getkey_result":[{"pubkey":"<RSA public key>"}]}`.
2. `token` = the Miniserver token of the current session; `user` = the active Miniserver user.
3. `pass` = 16 random bytes as hex. `h = CryptoJS.AES.encrypt(token, pass, CBC/Pkcs7)` — a
   passphrase, so key and IV come from EVP_BytesToKey(MD5) with a random salt (*inferred* from
   CryptoJS).
4. `rsaEnc = JSEncrypt(pubkey).encrypt(keyHex + ":" + ivHex + ":" + sessionToken)` (PKCS#1 v1.5,
   base64).
5. Send `secure/authenticate/<user>/<encodeURIComponent(rsaEnc)>/<encodeURIComponent(base64(h.ciphertext))>`.
   Reply must be `{"command":<the exact string sent>,"authenticate_result":"authentication successful"}`.
   Any other string is a failure → close 4001.
6. The pubkey is kept for `encryptWithPublicKey` (`AppHub.js:15612`), used for storage and
   service credentials.

### After "established"

`_fetchInitialInfo` (`shared-app.js:21174`) sends: `audio/cfg/globalsearch/describe`,
`audio/cfg/getinputs`, `audio/cfg/getavailableservices`, `audio/cfg/getradios`,
`audio/cfg/getservices`. No status command exists in this stack: the first `audio_event` per zone
has to be pushed by the server (*inferred*).

---

## 3. Wire format

`_internalSend` `AppHub.js:15897`, `_internalSendCommand` `:15925-15972`, `_onMessage` `:15975-16110`.

- **Command:** `[schema.command, ...schema.params.parse(args)].join("/")`, one text frame, no id.
- **Defaults** (`BaseCommandScheme`, `shared-app.js:18072`): `timeout` 20000 ms,
  `shouldWaitForResponse` true, no preprocessing. `BaseResponse = {error?: string, command: string}`.
- **Pending map:** keyed by the command string with any trailing `/?q&…` removed. A duplicate
  pending key shares the response.
- **Incoming frame**, first match wins:
  1. greeting regex;
  2. any key ending in `_event` → the *whole object* through `eventSchema.safeParse`; on failure
     the frame is logged and dropped, all events in it;
  3. any key ending in `_error`, or a truthy `error` → reject pending requests for `command`;
  4. a pending request for `command` → optional `responsePreProcessing`, then `response`; resolves
     with `.result`, which each schema fills from its `<name>_result` key. No result →
     `Command "<cmd>" did resolve without any result!`;
  5. unsolicited `globalsearch_result` → must be `{globalsearch_result, unique, type}` with type
     `"tunein" | "local" | "spotify"` (`AppHub.js:16200-16221`).
- **So the server must:** echo `command` byte-for-byte, and put the payload under the exact
  `<name>_result` key the schema names.
- **Keepalive:** none.
- **Reconnect:** `min(500 * 1.3^failures, 30000)` ms. A *clean* close of an established socket
  with any code but 4001 is ignored — no reconnect, state stays "established"
  (`AppHub.js:15829-15832`). Do not close cleanly.
- **`sendDirect`** (`:15695`): fire-and-forget; used for dialog button commands.

### HTTP side channels

No auth headers, no cookies.

- `PUT audio/cfg/upload/audioupload/add/<file name>` — announcement audio (`shared-app.js:83484`,
  `putFile` at `:20431`); then `audio/grouped/playuploadedfile/<name>.wav/<ids>`.
- `PUT audio/cfg/radios/coverurl/<encodeURIComponent(id)>` — custom station cover (`:25903`).
- `GET <coverurl>` — covers, cached in IndexedDB `CoverDB` (`CoverRepository.fetch`, `:21875`).
  A path containing `imgcache` is retried through `/proxy/<viaproxy>` on the connection target.

---

## 4. Events

Envelope `eventSchema`, module 383177, `AppHub.js:16413-16487`. Every key optional; unknown keys
stripped. **Shapes differ per key** — the tests pin this.

| Key | Shape |
|---|---|
| `audio_event` | array of audio events (below) |
| `audio_queue_event` | array of `{playerid: coerce number, queuesize: number, restrictions: coerce bool}` |
| `audio_sync_event` | array of `{group: string, mastervolume: number, type: "dynamic"\|"static", players: [{playerid: number, id: string}]}` — no consumer |
| `hw_event` | array of `{client_id, event_id, value}` numbers — no consumer |
| `roomfavchanged_event` | array of `{count: number, playerid: number}` |
| `recentlyplayedchanged_event` | array of `{playerid: number, ts: number}` |
| `lineinchanged_event` | array of anything |
| `playlistchanged_event` | array of `{action: "follow"\|"unfollow", cmd: "spotify", id, user}` or `{action: "delete"\|"rename"\|"start"\|"update"\|"create", audiopath, cmd, name, playlistid, user}` — all strings, all required |
| `rescan_event` | array of `{id?: string, status: 0\|1\|2, folders?: number, files?: number}`; `[0]` used |
| `reloadmusicapp_event` | array of `{action: "userdel"\|"useradd"\|"reload", cause: string, reload: coerce bool, user: string}`; `[0]` used |
| `dialog_event` | array of `{ID, buttons: [{title, command?, color?, link?}], cancelbtn?, level: 1\|2\|3, message, messagetype, state, title, ttl: number}` |
| `mastervolumechanged_event` | **object** `{group: coerce string, mastervolume: number}` — no consumer |
| `service_changed_event` | **object** `{action: "serviceschanged"}` |
| `customurl_changed_event` | **object** `{action: "added"\|"delete"\|"changed", id: string}` |
| `usbchanged_event` | **object** `{action: "added"\|"removed"}` |
| `reboot_event`, `restart_event` | **boolean** |
| `command` | optional string |

### `audio_event` (module 267716, `AppHub.js:16322`)

- **Required:** `album`, `artist`, `name`, `audiopath`, `coverurl` (strings); `audiotype`,
  `playerid`, `qindex`, `time`, `volume` (numbers); `mode` ∈ `play|resume|stop|pause`;
  `plrepeat` ∈ 0, 1, 3; `plshuffle` (coerced to boolean); `power` ∈
  `rebooting|updating|starting|on|off|offline`.
- **Optional:** `duration`, `duration_ms` (default 0), `position_ms`, `pbr`, `qid`, `sourceName`,
  `station`, `title`, `parent` (`{id, name, audiopath?}` or null), `eventype` (invalid → -1),
  `type` (FileType, invalid → 0), `icontype` (0–8, invalid → 0).
- Delivered only to a zone whose `AUDIO_ZONE_V2` control has that `playerid`
  (`shared-app.js:19632`, `:20051`).

### Enums (`shared-app.js:24-130`, `:18142`)

- **AudioType:** 0 File, 1 Radio, 2 Playlist, 3 LineIn, 4 AirPlay, 5 Spotify, 6 Bluetooth, 7 Soundsuit.
- **FileType:** 0 Unknown, 1 Folder, 2 File, 3 Playlist, 4 Favorite, 5 SpotifyConnect, 6 LineIn,
  7 PlaylistBrowsable, 8 Search, 11 PlaylistEditable, 12 PlaylistFollowable.
- **RepeatMode:** 0 NoRepeat, 1 Queue, 3 Track.
- **AudioEventType:** -1 Unknown, 0 None, 1 Bell, 2 Buzzer, 3 TTS, 4 ErrorTTS, 5 CustomFile,
  6 CustomPlaylist, 7 UploadedFile, 8 Identify, 9 UpnpBell, 100 Alarm, 101 Fire.
- **LineInIconType:** 0 LineIn, 1 CdPlayer, 2 Computer, 3 iMac, 4 iPod, 5 Mobile, 6 Radio,
  7 Screen, 8 TurnTable.
- **QueueAudioType:** -1 Unknown, 0 File, 1 Stream, 2 Playlist, 3 LineIn, 4 AirPlay, 5 Spotify.
- **RecentlyPlayedType:** `unknown`, `linein`, `spotify`, `soundsuit`, `library`, `tunein`,
  `custom_stream`, `loxoneradio`.
- **AudioItemType** (client-side `itemType`, never sent): 0 Unknown, 1 SpotifyTrack,
  2 SpotifyCategory, 3 SpotifyUserCollection, 4 SpotifyArtist, 5 SpotifyAlbum, 6 SpotifyPodcast,
  7 SpotifyPodcastEpisode, 8 SpotifyPlaylist, 9 SoundsuitSchedule, 10 SoundsuitStation,
  11 RadioStation, 12 RadioFolder, 13 LibraryTrack, 14 LibraryFolder, 15 LineIn, 16 Playlist,
  17 PlaylistTrack, 18 AirPlay, 19 Add, 20 Custom.
- **CustomRadioError:** 1 OTHER, 0 NONE, -1 INVALID_URL, -2 FILE_CREATION_FAILED,
  -3 FILE_NOT_FOUND, -4 MISSING_PAYLOAD, -5 SERVER_TIMEOUT, -6 AUTHENTICATION_FAILED.
- **AudioNASError:** -1 OTHER, 0 NONE, 1 NON_EXISTENT, 2 UNREACHABLE, 9 ADD_SELF, 10 DUPLICATE,
  11 FOLDER_UNREACHABLE, 12 INVALID_CREDS.

---

## 5. Commands

Wire form is after the schema's param transform. `<pid>` is the player id. Line = start of the
module in `shared-app.js`. Unless noted: timeout 20 s, waits for a response, `command` echoed.

### Config and browse (`audio/cfg/…`)

| Schema (line) | Wire | Response |
|---|---|---|
| GetPublicKeyScheme (1722) | `audio/cfg/getkey/full` | `getkey_result?: [{pubkey}]` |
| GetKeySchema (872) | `audio/cfg/getkey` | `getkey_result?: [{exp: number, pubkey}]` — unused by auth |
| DiagnosisSchema (10363) | `audio/cfg/diagnosis` | `diagnosis_result: object` |
| RestartSchema (7602) | `audio/cfg/restart` | `restart_result: "restart"`; does not wait |
| RescanScheme (7511) | `audio/cfg/rescan[/<folder>]` | `rescan_result: boolean` |
| GetLineInSchema (630) | `audio/cfg/getinputs` | `getinputs_result: [{cmd, description?, icontype, id, name, type: 6, as?}]` |
| RenameLineInSchema (5343) | `audio/cfg/input/<id>/rename/<name>` | `input_result: [{action: "ok"}]` |
| ChangeLineInTypeSchema (5504) | `audio/cfg/input/<id>/type/<0-8>` | `input_result: [{action: "ok"}]` |
| GetEqualizerSchema (532) | `audio/cfg/geteq/<pid>` | `geteq_result: [{id, name, low, high, step, value}]` all required |
| SetAllEqualizerLevelsSchema (9921) | `audio/cfg/seteq/<pid>/<v,v,…>` | `seteq_result: [{band, value}]` |
| SetSingleEqualizerLevelSchema (10083) | `audio/cfg/seteq/<pid>/<eqId>/<value>` | `seteq_result: {id, name, type, values: number[]}` |
| DynamicGroupUpdateSchema (149) | `audio/cfg/dgroup/update/<groupId\|new>[/<id,id,…>]` | `dgroup_update_result: {id: string}` |
| GetLocalLibraryScheme (1042) | `audio/cfg/getmediafolder/<folderId>/<start>/<count>` | `getmediafolder_result: [{id, start, totalitems, name?, items}]`; item `type` must be 1 or 2, else the whole response fails |
| GetLocalPlaylistScheme (1356) | `audio/cfg/getplaylists2/lms/nouser/<folderId>/<start>/<count>` | `getplaylists2_result: [{…, items}]`; items `{type: 11, id, name}` or `{type: 2, title, uniqueId}` |
| CreatePlaylistSchema (5764) | `audio/cfg/playlist/create/<cmd>/<user>/<name>` | `playlist_result: [{audiopath, name, playlistid}]` |
| RenamePlaylistSchema (5957) | `audio/cfg/playlist/rename/<cmd>/<user>/<id>/<name>` | `playlist_result: [{action: "rename", name}]` |
| DeletePlaylistSchema (5860) | `audio/cfg/playlist/deletelist/<cmd>/<user>/<id>` | `playlist_result: [{action: "delete"}]`; does not wait |
| StartPlaylistUpdateSchema (6909) | `audio/cfg/playlist/update/<cmd>/<user>/<id>/start` | `playlist_result: [{action: "ok"}]` |
| AddItemToPlaylistSchema (6224) | `…/additem:<itemId>` | `playlist_result: [{action: "ok", items?}]`; item `{id, audiopath, coverurl, name, tag, type}` all required |
| AddBrowsableToPlaylistSchema (6054) | `…/addbrowsable:<itemId>` | same |
| MoveItemInPlaylistSchema (6572) | `…/moveById/<itemId>/before/<nextId\|end>` | `playlist_result: [{action: "ok"}]` |
| RemoveItemFromPlaylistSchema (6746) | `…/removeById/<itemId>` | `playlist_result: [{action: "ok"}]` |
| FinishPlaylistUpdateSchema (6408) | `…/finish` or `…/finishnochanges` | `playlist_result: [{action: "ok"}]`; does not wait |
| GetRoomFavsScheme (1975) | `audio/cfg/getroomfavs/<pid>/<start>/<limit>` | `getroomfavs_result: [{…, items}]`; see favourites |
| RoomFavsAddScheme (7694) | `audio/cfg/roomfavs/<pid>/add/<name>/<serviceUrl>` | `roomfavs_add_result?: {id: number, name}` |
| RoomFavsCopyScheme (7857) | `audio/cfg/roomfavs/<srcPid>/copy/<id,id,…>` | `roomfavs_copy_result?: string` |
| RoomFavsDeleteScheme (8040) | `audio/cfg/roomfavs/<pid>/delete/<favId>` | `roomfavs_delete_result?: {delete_id}` or `roomfav_delete_result?: {delete_id, error: string}` (singular) |
| RoomFavsReorderScheme (8287) | `audio/cfg/roomfavs/<pid>/reorder/<id,id,…>` | `roomfavs_reorder_result?: string` |
| RoomFavsSetIdScheme (8447) | `audio/cfg/roomfavs/<pid>/setid/<cur>/<new>` | `roomfavs_setid_result?: {changed_from, changed_to}` |
| RoomFavsSetNameScheme (8615) | `audio/cfg/roomfavs/<pid>/setname/<slot>/<name>` | `roomfavs_setname_result?: [{rename_slot, rename_to}]` |
| RoomFavsSetT5EnabledScheme (8778) | `audio/cfg/roomfavs/<pid>/setplus/<favId>/<0\|1>` | `roomfavs_setplus_result?: {plus: bool, id}` |
| GetAvailableServicesScheme (409) | `audio/cfg/getavailableservices` | `getavailableservices_result?:` array; only `cmd` `spotify`/`soundsuit` kept; each `{config, helplink, icon, name, registerlink}` |
| GetServiceConfigsScheme (3922) | `audio/cfg/getservices` | `getservices_result?:` array, `cmd` must be `spotify` or `soundsuit` — anything else fails the whole response; `{configerror, id, name, user, asdefault?, icon?, pbr?}` |
| GetServiceFolderScheme (2998) | `audio/cfg/getservicefolder/<service>/<user\|nouser>/<folderId>/<start>/<count>` | `getservicefolder_result: [{…, items}]`; one bad item fails all; `serviceId` is taken from the echoed command's user segment |
| AddServiceScheme (9314) | `audio/cfg/servicecfg/add/spotify` or `…/add/soundsuit/<base64 pw>` | `servicecfg_result?: {action: "added", id, user}` or `{error: 5, errorMsg, id, user}` |
| DeleteServiceScheme (9414) | `audio/cfg/servicecfg/delete/<svc>/<id>` | `servicecfg_result: {action: "deleted", error: 0}` or `{action: "delete", error: 8}` |
| GetLinkSchema (9515) | `audio/cfg/servicecfg/getlink/<svc>` | `servicecfg_result: {link}` |
| SetDefaultUserForServiceAtPlayerScheme (9656) | `audio/cfg/servicecfg/set/<svc>/<user>/asdefault/player/<id,id,…>` | `servicecfg_result: {command: "asdefault", error: number}` |
| UpdateServiceScheme (9819) | `audio/cfg/servicecfg/update/<svc>/<oldUser>/<newUser>/<password>` | `servicecfg_result?: {action: "update", id}` or `{error: 8, errorMsg, id}` |
| FollowSchema (313) | `audio/cfg/follow/<cmd>/<user>/<audioPath>` | `follow_result: {action: "follow", id, error?}` |
| UnfollowSchema (10673) | `audio/cfg/unfollow/<cmd>/<user>/<audioPath>` | `unfollow_result: {action: "unfollow", id, error?}` |
| IsFollowedSchema (5663) | `audio/cfg/isfollowed/<cmd>/<user>/<audioPath>` | `isfollowed_result: {action: "isfollowed", id, isfollowed, isowner}` |
| GetRadioSchema (1881) | `audio/cfg/getradios` | `getradios_result?: [{name, icon, cmd, root}]` all required |
| AddCustomRadioStationSchema (7047) | `audio/cfg/radios/add/<name>/<url>[/?q&<auth>]` | `radios_result: {action: "add", id?, name, url, error, errorInfo?}` |
| ModifyCustomRadioStationSchema (7318) | `audio/cfg/radios/modify/<id>/<name>/<url>[/?q&<auth>]` | `radios_result: {action: "modify", …}` |
| DeleteCustomRadioStationSchema (7221) | `audio/cfg/radios/del/<id>` | `radios_result: {action: "del", id?, error}` |
| StorageListSchema (10555) | `audio/cfg/storage/list` | `storage_result: [{name, server, folder, guest, id?, username?, password?, type?, configerror}]` |
| StorageAddSchema (10179) | `audio/cfg/storage/add/<RSA-encrypted JSON>` | `storage_result:` one entry; timeout 60 s |
| StorageEditSchema (10460) | `audio/cfg/storage/edit/<id>/<payload>` | `storage_result:` one entry; timeout 60 s |
| StorageDeleteSchema (10271) | `audio/cfg/storage/delete/<id>` | `storage_result: {id, error: coerce bool}` |
| GlobalSearchDescribeScheme (4077) | `audio/cfg/globalsearch/describe` | `globalsearch_result: {local?, spotify?, tunein?}`; arrays present must be non-empty |
| GlobalSearchQueryScheme (4249) | `audio/cfg/globalsearch/<scope>/<encodeURIComponent(query)>` | `globalsearch_result: {unique}`; results follow as tickets |
| SearchScheme (8957) | `audio/cfg/search/<service>/<user>/<tag>/<query>/<start>/<count>` | `search_result` or `search_reply_result`: `[{results: [R]}]`, R discriminated on `where` ∈ `spotify\|local\|library\|radio`; `user` effectively required |

Global search scope: parts joined with `|`, each `<source>:<cat>#<limit>,<cat>#<limit>`; Spotify as
`spotify@<serviceId>:…`. Categories singular: `track`, `album`, `artist`, `playlist`, `folder`,
`show`, `episode`, `station`, `custom`. Ticket: `{type, unique, globalsearch_result}`; local and
tunein send the bare category object, Spotify sends `{error?, result: {…categories, user}}`.
Each category `{caption?, link?, totalitems?, items?}`; `topresults` is `{caption?, count?, <cat>?: item[]}`.

### Grouped (`audio/grouped/…`)

| Schema (line) | Wire | Response |
|---|---|---|
| GroupedPlaySchema (10978) | `audio/grouped/play/<id,id,…>` | `grouped_play_result: {players: [{playerid, mode: "play"}]}` |
| GroupedPauseSchema (10820) | `audio/grouped/pause/<id,id,…>` | `grouped_pause_result: {players: [{playerid, mode: "pause"}]}` |
| GroupedVolumeSchema (11316) | `audio/grouped/volume/<0-100\|plus\|minus>/<id,id,…>` | `grouped_volume_result: {players: [{playerid, volume}]}` |
| GroupedPlayUploadedFileSchema (11136) | `audio/grouped/playuploadedfile/<file.wav>/<id[#vol],…>` | `playuploadedfile_result: boolean` |

### Per zone (`audio/<pid>/…`)

| Schema (line) | Wire | Response |
|---|---|---|
| PlaySchema (12459) | `audio/<pid>/play` | `play_result: boolean` |
| PauseSchema (12305) | `audio/<pid>/pause` | `pause_result: boolean` |
| SetVolumeSchema (17744) | `audio/<pid>/volume/<0-100>` or `/+<step>` `/-<step>` (step 3) | `volume_result: boolean` |
| SetPositionScheme (17911) | `audio/<pid>/position/<seconds>` | `position_result: [{position}]` |
| RepeatSchema (16510) | `audio/<pid>/repeat/<0\|1\|3>` | `repeat_result: {repeat}` |
| ShuffleSchema (17570) | `audio/<pid>/shuffle[/enable\|/disable]` | `shuffle_result: {shuffle: boolean}` |
| QueueNextSchema (14581) | `audio/<pid>/queueplus` | `queueplus_result: {action: "queueplus"}` |
| QueuePreviousSchema (14897) | `audio/<pid>/queueminus` | `queueminus_result: {action: "queueminus"}` |
| GetQueueSchema (13162) | `audio/<pid>/getqueue/<offset>/<limit>` (limit default -1) | `getqueue_result: [{id, items, shuffle, start, totalitems}]` |
| QueuePlaySchema (14735) | `audio/<pid>/queue/play/<uniqueId>` | `queue_result: {play: string}` |
| QueueMoveSchema (14413) | `audio/<pid>/queue/move/<uid>/before/<uid>` or `audio/<pid>/queue/move/<uid>/end` | `move_result: unknown` |
| QueueRemoveSchema (15051) | `audio/<pid>/queue/remove/<uniqueId>` | `remove_result: {deleted: string}` |
| QueueAddSchema (13002) | `audio/<pid>/queueadd/<uniqueId>` | `queueadd_result: "ok"` |
| QueueInsertSchema (14253) | `audio/<pid>/queueinsert/<uniqueId>` | `queueinsert_result: "ok"` |
| GetRecentPlayedScheme (15385) | `audio/<pid>/recent` | `recent_result: {items, ts: number}` |
| ClearRecentlyPlayedScheme (15229) | `audio/<pid>/recent/clear` | `recent_result: {items: [], ts}` |
| RoomFavPlayScheme (16685) | `audio/<pid>/roomfav/play/<favId>[/<user>][/noshuffle][/?q&<b64url("enforceUser=true")>]` | `roomfav_result?: [{playerid, playing_slot}]` |
| RoomFavPlusScheme (16876) | `audio/<pid>/roomfav/plus` | `roomfav_result?: [{playerid, playing_slot}]` |
| ServicePlayScheme (17034) | `audio/<pid>/serviceplay/<radio\|spotify\|soundsuit>/<user>/<audioPath>[parentInfo][/noshuffle][/?q&…]` | `serviceplay_result?: "ok"` or `{error, message}` |
| LibraryPlayScheme (11940) | `audio/<pid>/library/play/<id>[/parentid/<id>/<idx> \| /parentpath/<path>/<idx>][/noshuffle]` | `play_result?` |
| PlaylistPlayScheme (12814) | `audio/<pid>/playlist/play/<audioPath>[parentInfo][/noshuffle]` | `linein_result?: {action: "play"}` (sic) |
| PlayUrlScheme (12613) | `audio/<pid>/playurl/<audioPath>[parentInfo][/noshuffle]` | `playurl_result?: {uri}` |
| LineInPlayScheme (12141) | `audio/<pid>/linein/<id>` | `linein_result?: {action: "play"}` |
| GetLoudnessSchema / SetLoudnessSchema (11672 / 17413) | `audio/<pid>/loudness[/<0\|1>]` | `loudness_result: coerce bool` |
| GetCenterGainSchema / SetCenterGainSchema (11518 / 17256) | `audio/<pid>/centergain[/<0\|1>]` | `centergain_result: coerce bool` |

`parentInfo` = `{parentPath?, parentId?, idx}`; `idx = start + i`; set only for item types 1, 7, 13
and 17. A numeric parent id goes in `parentId`, anything else in `parentPath`.

---

## 6. Item schemas — where a response can die

`BaseServiceResultScheme` = `{id: coerce string, start: number, totalitems: number, name?}`.

### Queue items (module 169492, `shared-app.js:13536`)

Raw: `duration: number`, `unique_id: string`, `audiopath: string`, `qindex: number` required;
`album?`, `artist?`, `title?`, `station?`, `user?`, `coverurl?`, `icontype?`, `audiotype`. Unknown
keys stripped. **No per-item catch: one bad item fails the whole `getqueue`.** By `audiotype`:

- **0 File:** `audiopath` must start with `library:local:track:`.
- **1 Stream:** `soundsuit@…` → Soundsuit; otherwise RadioStation, which needs `station`.
- **3 LineIn:** needs `icontype`.
- **5 Spotify:** `audiopath` starts with `spotify:`, second segment `track` or `episode`; a track
  needs `coverurl`.
- **4 AirPlay:** appears unpassable (final schema wants `origin`, never set).
- **2 Playlist, -1:** no branch — fails the whole response.

### Favourites (module 546843, `shared-app.js:2098`; preprocessing 801089)

Raw base: `id` (coerce number), `name`, **`plus: boolean`**, **`slot: number`**, `coverurl?`,
`audiopath` (effectively required). A favourite that fails preprocessing is dropped silently; one
that passes preprocessing but fails the final union fails the whole response.

| Raw `type` | Becomes | Needs |
|---|---|---|
| `library_track` / `library_folder` | LibraryTrack / LibraryFolder | |
| `linein` | LineIn | `icontype` |
| `playlist` | Playlist | |
| `tunein`, `custom_stream`, `loxoneradio` | RadioStation | `title` |
| `normal`, `soundsuit` | Soundsuit | `audiopath` containing `:station:` or `:schedule:`, else whole response fails |
| `spotify_track` | SpotifyTrack | |
| `spotify_playlist` | SpotifyPlaylist | `ownerId` **and** `owner_id` |
| `spotify_collection` | SpotifyUserCollection | `owner`, `owner_id` |
| `spotify_album` / `_artist` / `_show` / `_episode` | matching Spotify type | |

### Recently played (module 492295, `shared-app.js:15717`)

Raw: `audiopath`, `coverurl`, `title` required strings; `service`, `type`, `user?`. Failing items
are dropped silently. Raw `type` must match the service: `library` playlist → 11, `linein` → 6
(and `coverurl` a URL with an `icontype` query param), radio services → 2, `soundsuit` → 3,
`spotify` → the tag's FileType. Library `audiopath` must start with `library:local:track`,
`library:local:folder`, `library:local:album` or `playlist`.

### Service items (modules 12051, 263460, 29748, 359200)

Base: `id?`, `type`, `name`, `coverurl?`, `audiopath?`, `unplayable`. Radio: `type` 1 folder,
2 station. Soundsuit: `type` 3; a schedule needs numeric `id` and `linkurl`. Spotify, by `tag`:
`track` (type 2, **`thumbnail` required**), `category` (1), `playlist`/`album` (12, 11 or 7),
`artist`/`show` (12 or 7), `episode` (2). A `user_collection` item has no preprocessing branch
and fails the response.

### Library and playlist items

Library (`getmediafolder`, module 896212): `type` 1 or 2, `id`, `name` required; `usb`, `nas`,
`external` pick the origin. Playlists (`getplaylists2`, module 243696): `{type: 11, id, name}`
or `{type: 2, title, uniqueId}`.

### Line-in (`getinputs`, module 33801)

`{cmd, icontype, id, name, type: 6}`; the client derives `audioPath = "linein/<id>"`.

---

## 7. Legacy `MediaServerComp` (`scripts10.js`)

Kept for the conventions it shares; it does not connect to an Audioserver.

- **Classes:** `MediaServerComponent` (422), `MediaSocket` (1835), `AudioZone` (1970),
  `ZoneGroupExt` (2360), `VoiceRecorderExt` (2486), search (2596–2980), `AudioZoneSettings` (2984),
  `MiniserverMediaProxy` (3065), `MediaMessageParser` (3134), `CentralCommunicationNode` (3282),
  `Popup` (3560), `DialogExt` (3872), loaders (4111–5197), playlist edit (5198–5707),
  `ServiceHandlerExt` (5712), `InputExt` (6066), `ZoneFavoriteExt` (6216). Constants: `MediaEnum`
  (1–421).
- **Socket:** `new WebSocket("ws://" + host, "remotecontrol")`; first frame must start with
  `LWSS V ` and contain `~API:<maj.min>~`. `apiVersion[0] > 2` → "app outdated".
- **Parser:** first key decides — `_event`, `_result`, `_error`; correlation by the echoed
  `command`, or by the key prefix for `status`, `getqueue`, `getplayersdetails`,
  `getsyncedplayers`, `mac`, `globalsearch`. `*_result` is always an array.
- **On connect:** `audio/cfg/mac`, `audio/cfg/getkey`, `audio/cfg/getplayersdetails`,
  `audio/cfg/getsyncedplayers`, `audio/cfg/scanstatus`.
- **Proxy:** not LOCAL → `jdev/sps/io/<server uuid>/<encodeURIComponent(cmd)>`; replies arrive in
  the Miniserver states `apiVersion` and `audioEvent`.
- **Paging:** `<id>/<start>/<n>`, 50 per page; a result is accepted only when `id` and `start`
  match the request.
- **Commands only this stack uses:** `audio/<pid>/status`, `identifysource`, `queue/<qindex>`,
  `queueandplay/`, `queueundo/`, `queueremove/`, `queuemove/`, `queue/clear`, `playlist/save/`,
  `favoriteplay/`, `serviceplayadd|insert|insertandplay/`, `addurl|inserturl|insertandplayurl/`,
  `roomfav/save*`, `roomfav/delete/`, `sync/`, `unsync`, `mastervolume`,
  `audio/cfg/getfavorites`, `audio/cfg/favorites/*`, `audio/cfg/searchdetails/…`,
  `audio/cfg/input/<id>/enabled|inputvolume|inputvolumesave`, `audio/cfg/audiodelay|maxvolume|defaultvolume|equalizer/<pid>`.
- **Events only this stack knows:** `popup_event`, `goingtostandby_event`,
  `serviceconfigerror_event`, `favoriteschanged_event`.

---

## 8. Against sonn core

Compared with `src/adapters/loxone/commands/router/routeRegistry.ts` and
`src/adapters/loxone/ws/notifier.ts` on 2026-11-15. Read off the code, not tested against the app.

**Client commands with no route:**

- `audio/cfg/servicecfg/set/<svc>/<user>/asdefault/player/<ids>` — the app's "default account
  for this zone". Worth having here in particular: every bridged streaming service shows up in
  the app as a Spotify account, and without `asdefault` the app opens the first one in every
  zone (`getDefaultSpotifyIdForPlayer`, `shared-app.js:20108`). Needs the choice persisted per
  account and returned in `getservices`.
- `PUT audio/cfg/radios/coverurl/<id>` — a picture for a custom station. We have nowhere to
  keep and serve an uploaded cover; the upload is accepted and ignored.
- `audio/cfg/servicecfg/add` and `…/update` — schemas exist in the app, nothing in 17.3.0 calls
  them; account sign-in goes through `getlink`.
- `audio/<pid>/loudness` — only offered from firmware 18.1.0.0; we announce 17.3.11.10.
- `audio/<pid>/centergain` — only offered when the Miniserver's structure file sets the
  `CENTER_GAIN` bit in a zone's `speakerConfig` (`shared-app.js:75888`), i.e. for Loxone's own
  amplifier hardware.
- `dialog_event` — we never send one.

**Closed since the first comparison:** `audio/cfg/search/…` (paged category search),
`audio/<pid>/queue/move/<uid>/end`, `audio/cfg/roomfavs/<pid>/setplus/…`,
`audio/cfg/storage/edit/…`, `audio/cfg/radios/modify/…`. Along the way three answers that the
app could not read were renamed to what its schemas name: `roomfavs_setid_result`,
`roomfavs_setname_result` (an array of `{rename_slot, rename_to}`) and the `storage/delete`
result (`{id, error}`). All of these are pinned in `tests/loxoneClientCommands.test.ts`.

**Events:** `service_changed_event`, `restart_event`, `reboot_event`, `usbchanged_event` and
`customurl_changed_event` were sent as arrays, and `playlistchanged_event` without `name` on
delete/update; the client drops such frames. Corrected in `notifier.ts` together with
`tests/loxoneClientEvents.test.ts`.

**Open points:**

- How `GroupedPlayUploadedFile` joins its id array (JS default `,` — *inferred*).
- Whether the two numeric browse params are start/limit in every command (descriptions are vague).
- `ShuffleSwitch` gating means `shuffle/enable|disable` only appears from firmware 16.1.09.23.
