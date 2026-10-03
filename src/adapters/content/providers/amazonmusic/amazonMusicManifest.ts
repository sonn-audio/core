/**
 * Reading the one kind of DASH manifest Amazon Music serves.
 *
 * It is the on-demand profile: every Representation is a single CENC-encrypted fragmented MP4
 * reached through its own `BaseURL`, so playing one is a plain (ranged) download plus a content
 * key — no segment timeline to follow. That narrowness is why this is a few patterns rather than
 * an XML dependency: it reads the attributes it needs and nothing else.
 *
 * Each adaptation set carries several `ContentProtection` entries. The Widevine one *without* a
 * `value` is the per-track ("web") PSSH that an ordinary CDM gets a content key for; the ones
 * valued `AmzMusic-2019` are entitlement PSSHs that need a key ladder we do not have, so they are
 * ignored.
 */

const WIDEVINE_SCHEME = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';

/** Codecs that carry more than two channels; nothing downstream mixes them down well. */
const SPATIAL_CODECS = /^(ec-3|ac-4|mha1|mhm1)/i;

export type AmazonAudioRepresentation = {
  url: string;
  /** Lower-cased codec family: `flac`, `opus`, `aac`, or the raw codecs string otherwise. */
  codec: string;
  bandwidth: number;
  sampleRate: number;
  bitDepth?: number;
  /** Amazon's own name for the tier: `LD`, `SD`, `HD`, `UHD`… */
  quality: string;
  spatial: boolean;
  /** Base64 PSSH box an ordinary CDM can license, when the manifest offers one. */
  pssh?: string;
  /** 32-hex key id, when declared. */
  defaultKid?: string;
};

const decodeXml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name.replace(/[:]/g, '\\:')}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match ? decodeXml(match[1] ?? '') : undefined;
}

/** Every `<name …>…</name>` or `<name …/>` (any namespace prefix) as [openingTag, inner]. */
function elements(xml: string, name: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`<((?:[\\w-]+:)?${name})\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/\\1>)`, 'gi');
  for (let match = re.exec(xml); match; match = re.exec(xml)) {
    out.push([`<${match[1]}${match[2] ?? ''}>`, match[4] ?? '']);
  }
  return out;
}

function text(xml: string, name: string): string | undefined {
  const first = elements(xml, name)[0];
  const value = first ? decodeXml(first[1].trim()) : '';
  return value || undefined;
}

function codecFamily(codecs: string): string {
  const lower = codecs.toLowerCase();
  if (lower.startsWith('flac')) return 'flac';
  if (lower.startsWith('opus')) return 'opus';
  if (lower.startsWith('mp4a')) return 'aac';
  return lower;
}

function protection(xml: string): { pssh?: string; defaultKid?: string } {
  let pssh: string | undefined;
  let defaultKid: string | undefined;
  for (const [tag, inner] of elements(xml, 'ContentProtection')) {
    const scheme = (attr(tag, 'schemeIdUri') ?? '').toLowerCase();
    const kid = attr(tag, 'cenc:default_KID') ?? attr(tag, 'default_KID');
    if (kid && !defaultKid) defaultKid = kid.replace(/-/g, '').toLowerCase();
    if (scheme === WIDEVINE_SCHEME && !attr(tag, 'value')) {
      pssh = pssh ?? text(inner, 'pssh');
    }
  }
  return { pssh, defaultKid };
}

/** Every audio representation the manifest offers, spatial ones included and flagged. */
export function parseAmazonManifest(mpd: string): AmazonAudioRepresentation[] {
  const out: AmazonAudioRepresentation[] = [];
  for (const [setTag, setXml] of elements(mpd, 'AdaptationSet')) {
    const setProtection = protection(setXml);
    let quality = '';
    for (const [propTag] of elements(setXml, 'SupplementalProperty')) {
      if (attr(propTag, 'schemeIdUri') === 'amz-music:trackType') {
        quality = attr(propTag, 'value') ?? '';
      }
    }
    for (const [repTag, repXml] of elements(setXml, 'Representation')) {
      const url = text(repXml, 'BaseURL');
      if (!url) continue;
      const codecs = attr(repTag, 'codecs') ?? attr(setTag, 'codecs') ?? '';
      const repProtection = protection(repXml);
      const spatial = SPATIAL_CODECS.test(codecs);
      const depthProp = elements(repXml, 'SupplementalProperty')[0];
      const bitDepth = !spatial && depthProp ? Number(attr(depthProp[0], 'value')) : NaN;
      let urlQuality = '';
      try {
        urlQuality = new URL(url).searchParams.get('ql') ?? '';
      } catch {
        // relative or odd URL: no quality hint, which is fine
      }
      out.push({
        url,
        codec: codecFamily(codecs),
        bandwidth: Number(attr(repTag, 'bandwidth')) || 0,
        sampleRate: Number(attr(repTag, 'audioSamplingRate') ?? attr(setTag, 'audioSamplingRate')) || 0,
        bitDepth: Number.isFinite(bitDepth) && bitDepth > 0 ? bitDepth : undefined,
        quality: urlQuality.toUpperCase().startsWith('UHD') ? 'UHD' : quality || urlQuality,
        spatial,
        pssh: repProtection.pssh ?? setProtection.pssh,
        defaultKid: repProtection.defaultKid ?? setProtection.defaultKid,
      });
    }
  }
  return out;
}

const CODEC_RANK: Record<string, number> = { flac: 3, opus: 2, aac: 1 };

/**
 * The representation to play.
 *
 * Stereo only, and only what the subscription can license: lossless needs Unlimited, so a Prime
 * account is held to the lossy streams instead of being handed a FLAC it will be refused a key
 * for. Among what is left the best wins — FLAC over Opus over AAC, then resolution, then bitrate.
 * A representation without a licensable PSSH or key id is skipped: there would be no key for it.
 */
export function pickRepresentation(
  reps: readonly AmazonAudioRepresentation[],
  options: { lossless: boolean; maxSampleRate?: number },
): AmazonAudioRepresentation | null {
  const candidates = reps.filter(
    (rep) =>
      !rep.spatial &&
      CODEC_RANK[rep.codec] !== undefined &&
      (options.lossless || rep.codec !== 'flac') &&
      (!options.maxSampleRate || !rep.sampleRate || rep.sampleRate <= options.maxSampleRate) &&
      (rep.pssh || rep.defaultKid),
  );
  candidates.sort(
    (a, b) =>
      (CODEC_RANK[b.codec] ?? 0) - (CODEC_RANK[a.codec] ?? 0) ||
      b.sampleRate * (b.bitDepth ?? 16) - a.sampleRate * (a.bitDepth ?? 16) ||
      b.bandwidth - a.bandwidth,
  );
  return candidates[0] ?? null;
}
