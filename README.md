# sonn core

**The open audio server.** sonn core is a complete multiroom audio solution: a self-hosted server
that collects your music — local files, streaming services, radio, line-in — and plays it in sync on
the speakers you already own, over almost any protocol they speak. Run it as a pure content server,
or as a whole-home multiroom system with fixed zones. Fully Loxone compatible, Home Assistant friendly.

> **Status: 4.0 beta.** In active use and actively developed. Releases are tagged from the `beta`
> branch, and breaking changes can still land between betas — check the release notes before updating.

**Website:** [sonn-audio.github.io](https://sonn-audio.github.io/) ·
**Documentation:** [sonn-audio.github.io/docs](https://sonn-audio.github.io/docs/)

## Quick start

```bash
docker compose up -d
```

Then open `http://<server-ip>:7090`, create your admin account, and walk the three steps: **Content**
— add your music. **Access** — switch on how to reach it. **Zones** — only if you want rooms. The
first two steps are already a working audio server.

Details — docker run, bridge networking, running without Docker, ports, persistence — live in the
[install guide](https://sonn-audio.github.io/docs/install/).

## Documentation

The documentation lives on the website — this readme deliberately does not duplicate it:

- [What sonn is](https://sonn-audio.github.io/docs/) — the three sides: Content, Access, Zones
- [Install](https://sonn-audio.github.io/docs/install/) and [first setup](https://sonn-audio.github.io/docs/setup/)
- [Content](https://sonn-audio.github.io/docs/content/) — library, streaming services, radio, line-in
- [Zones & outputs](https://sonn-audio.github.io/docs/zones/) — Sendspin and the signal path, receivers, grouping, power management, Beoremote One
- [Loxone](https://sonn-audio.github.io/docs/loxone/) — pairing a Miniserver with the built-in Audioserver implementation
- [Access](https://sonn-audio.github.io/docs/access/) — DLNA, Subsonic, WebDAV, the web player
- [Troubleshooting](https://sonn-audio.github.io/docs/troubleshooting/)

The one exception is the API: **[INTEGRATING.md](INTEGRATING.md)** in this repository is the public
API's single source of truth, kept next to the code it describes. The website renders it at
[/docs/reference/](https://sonn-audio.github.io/docs/reference/).

For contributors working on Loxone compatibility there is one more document here:
**[docs/loxone-client-map.md](docs/loxone-client-map.md)** maps the Loxone app's Audioserver
client — connection, authentication, every command and event, and what it requires of a server.
It sits next to the tests that enforce it.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under
[Apache-2.0](LICENSE).
