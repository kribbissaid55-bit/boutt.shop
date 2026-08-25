/**
 * AudioTranscodeService — turns operator-uploaded MP3 / M4A / etc audio
 * files into WhatsApp-native voice-notes (opus in an ogg container).
 *
 * Why: WhatsApp Web + Baileys only reliably delivers audio as a voice-note
 * (PTT) when the mimetype label AND the actual bytes are opus/ogg. Sending
 * MP3 bytes with an opus label makes WhatsApp render an empty voice-note;
 * sending MP3 bytes with `ptt: true` and the real mimetype makes WhatsApp
 * reject the send entirely; sending them non-PTT drops them in fresh-session
 * bursts. Transcoding is the only fix that works.
 *
 * ffmpeg is provided by the `ffmpeg-static` npm dependency — a portable
 * statically-linked binary; no system install is needed.
 *
 * Transcoded output is cached beside the source (`<src>.opus.ogg`). Duration
 * is cached in a JSON sidecar (`<src>.opus.ogg.meta.json`). MediaService.remove
 * cleans both when the source is deleted.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import ffmpegPathRaw from 'ffmpeg-static';
import { logger } from '../config/logger.js';

/**
 * Resolve a WORKING ffmpeg binary. Order:
 *   1. FFMPEG_PATH env override
 *   2. system ffmpeg (apk/apt installed — required on Alpine/musl containers,
 *      where the glibc-linked ffmpeg-static binary cannot execute)
 *   3. the ffmpeg-static bundled binary
 * Each candidate is probed with `-version` once at startup; the first one
 * that actually runs wins. On musl (our Docker image) ffmpeg-static EXISTS
 * on disk but fails to exec — probing catches that instead of failing later
 * at send time and silently shipping un-transcoded m4a to WhatsApp.
 */
function resolveFfmpeg(): string | null {
  const candidates = [
    process.env.FFMPEG_PATH,
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
    (ffmpegPathRaw as unknown as string | null) ?? undefined,
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-version'], { stdio: 'ignore', timeout: 5000 });
      if (r.status === 0) {
        logger.info({ ffmpeg: c }, 'AudioTranscode: ffmpeg resolved');
        return c;
      }
    } catch { /* try next */ }
  }
  logger.error('AudioTranscode: NO working ffmpeg found — audio uploads will be sent untranscoded and may not play on WhatsApp. Install ffmpeg (apk add ffmpeg) or set FFMPEG_PATH.');
  return null;
}

const ffmpegPath: string | null = resolveFfmpeg();

/** True when the file is already in a WhatsApp-native voice-note format. */
function isNativeVoiceMime(mime: string): boolean {
  return /opus|ogg|webm|amr/i.test(mime);
}

/** Cached companion path — always sibling of the source. */
export function cachedOpusPath(srcAbsPath: string): string {
  return `${srcAbsPath}.opus.ogg`;
}

/** Sidecar path holding duration for the cached companion (or for native
 *  voice-note files probed on first send). */
export function cachedMetaPath(srcAbsPath: string): string {
  return `${srcAbsPath}.opus.ogg.meta.json`;
}

async function fileExistsNonEmpty(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

interface CachedMeta {
  seconds?: number;
  /** WhatsApp voice-note waveform — 64 amplitude bytes (0..100) computed
   *  from the transcoded audio's actual PCM. Stored base64 in the sidecar
   *  so the JSON file remains human-readable. */
  waveformB64?: string;
}

async function readMeta(p: string): Promise<CachedMeta | null> {
  try {
    const txt = await fs.promises.readFile(p, 'utf8');
    const j = JSON.parse(txt);
    return (j && typeof j === 'object') ? j : null;
  } catch { return null; }
}

async function writeMeta(p: string, meta: CachedMeta): Promise<void> {
  try { await fs.promises.writeFile(p, JSON.stringify(meta), 'utf8'); }
  catch (e) { logger.warn({ err: e, p }, 'AudioTranscode: failed to write meta sidecar'); }
}

/**
 * Compute a WhatsApp-shaped 64-byte waveform from the audio's actual PCM
 * amplitude. Baileys would normally do this via `audio-decode`, but that
 * package isn't installed. Without a real waveform, some mobile WhatsApp
 * builds refuse to play the voice-note ("problème avec le fichier audio").
 * Returns null on any ffmpeg / decode failure — caller then sends without.
 */
async function computeWaveformViaFfmpeg(src: string): Promise<Buffer | null> {
  if (!ffmpegPath) return null;
  return await new Promise<Buffer | null>((resolve) => {
    // Decode to raw 16-bit signed LE mono PCM at 8 kHz. 8 kHz × 300 s =
    // 2.4M samples = 4.8 MB peak — well within Node's happy range.
    const proc = spawn(
      ffmpegPath!,
      ['-i', src, '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(null);
    }, 15_000);
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const pcm = Buffer.concat(chunks);
      const totalSamples = Math.floor(pcm.length / 2);
      if (totalSamples < 64) return resolve(null);
      const bucketSize = Math.floor(totalSamples / 64);
      const peaks = new Array<number>(64).fill(0);
      let overallMax = 1; // avoid div/0
      for (let b = 0; b < 64; b++) {
        let peak = 0;
        const start = b * bucketSize;
        const end = start + bucketSize;
        for (let i = start; i < end; i++) {
          const s = pcm.readInt16LE(i * 2);
          const abs = s < 0 ? -s : s;
          if (abs > peak) peak = abs;
        }
        peaks[b] = peak;
        if (peak > overallMax) overallMax = peak;
      }
      const wave = Buffer.alloc(64);
      for (let b = 0; b < 64; b++) {
        wave[b] = Math.min(100, Math.round((peaks[b] / overallMax) * 100));
      }
      resolve(wave);
    });
  });
}

/** Parse "Duration: HH:MM:SS.XX" out of ffmpeg's stderr banner. Returns
 *  seconds as a float, or undefined if not present. */
function parseDurationSeconds(stderr: string): number | undefined {
  const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})/);
  if (!m) return undefined;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  const s = Number(m[3]);
  const frac = Number('0.' + m[4]);
  const total = h * 3600 + mm * 60 + s + frac;
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/** Transcode src → dst. Returns duration parsed from ffmpeg stderr. */
async function runFfmpeg(src: string, dst: string): Promise<{ seconds?: number }> {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary path unresolved');
  return await new Promise<{ seconds?: number }>((resolve, reject) => {
    // Encode BYTE-FOR-BYTE like a WhatsApp mobile recorder:
    //   - libopus in ogg container
    //   - -application voip → voice-optimized encoding profile
    //   - -vbr on → variable bitrate (matches native recorder output)
    //   - 16 kHz mono, 16 kbps → identical to WhatsApp's own voice-notes
    //     (OpusHead.InputSampleRate=16000). Higher rates like 48 kHz get
    //     decoded fine by desktop clients but some mobile builds refuse
    //     to play them — the bubble renders but tap does nothing.
    const args = [
      '-y', '-i', src,
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '16k',
      '-vbr', 'on',
      '-compression_level', '10',
      '-application', 'voip',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'ogg',
      dst,
    ];
    const proc = spawn(ffmpegPath!, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`ffmpeg timed out after 30s`));
    }, 30_000);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ seconds: parseDurationSeconds(stderr) });
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** Probe duration without transcoding. Used for native voice-note files
 *  (.ogg/.opus) that skip the transcode branch. */
async function probeDurationSeconds(src: string): Promise<number | undefined> {
  if (!ffmpegPath) return undefined;
  return await new Promise<number | undefined>((resolve) => {
    const proc = spawn(
      ffmpegPath!,
      ['-i', src, '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(undefined);
    }, 10_000);
    proc.on('error', () => { clearTimeout(timer); resolve(undefined); });
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(parseDurationSeconds(stderr));
    });
  });
}

/** Quick container sanity check — a valid transcode output must start with
 *  the OggS magic. Guards against corrupted/partial cached companions from
 *  earlier failed runs being reused forever. */
async function isValidOgg(p: string): Promise<boolean> {
  try {
    const fd = await fs.promises.open(p, 'r');
    const head = Buffer.alloc(4);
    await fd.read(head, 0, 4, 0);
    await fd.close();
    return head.toString('latin1') === 'OggS';
  } catch { return false; }
}

export const AudioTranscodeService = {
  /** True when ffmpeg is available (upload-time normalization possible). */
  available(): boolean { return !!ffmpegPath; },

  /**
   * Direct one-shot transcode src → dst in the WhatsApp voice-note format
   * (opus/ogg, 16 kHz mono, voip profile). Used at UPLOAD time to normalize
   * every audio file the operator adds, so the library only ever stores
   * WhatsApp-native audio. Throws on failure — caller decides the fallback.
   */
  async transcodeFile(src: string, dst: string): Promise<{ seconds?: number }> {
    return runFfmpeg(src, dst);
  },

  /**
   * Ensure the given file is available in an opus/ogg form suitable for
   * WhatsApp voice-notes. Returns the path + mimetype the caller should
   * actually send, whether transcoding happened, and the audio duration
   * in seconds (if we could determine it).
   *
   * Never throws — on any failure it degrades to the source file so the
   * caller can still send it (even if imperfectly). All failures are
   * logged so the operator can grep and diagnose.
   */
  async ensureOpusOgg(
    srcAbsPath: string,
    srcMimeType: string,
  ): Promise<{ path: string; mimeType: string; transcoded: boolean; seconds?: number; waveform?: Buffer }> {
    // ALWAYS transcode — even opus/ogg sources. AI-TTS providers (OpenAI,
    // ElevenLabs) emit opus at 48 kHz, which some mobile WhatsApp builds
    // refuse to play as voice-notes. Re-encoding to 16 kHz mono opus makes
    // the OpusHead.InputSampleRate match WhatsApp's own recorder output,
    // which fixes the "bubble renders but tap-play does nothing" bug.
    // Cost: ~100-300 ms per short reply (already dwarfed by the typing-
    // simulation delay). Cached results skip the re-encode entirely.
    const dst = cachedOpusPath(srcAbsPath);
    const metaPath = cachedMetaPath(srcAbsPath);

    if (await fileExistsNonEmpty(dst)) {
      if (await isValidOgg(dst)) {
        const meta = await readMeta(metaPath);
        const cachedWaveform = meta?.waveformB64
          ? Buffer.from(meta.waveformB64, 'base64')
          : undefined;
        return {
          path: dst,
          mimeType: 'audio/ogg; codecs=opus',
          transcoded: true,
          seconds: meta?.seconds,
          waveform: cachedWaveform && cachedWaveform.length === 64 ? cachedWaveform : undefined,
        };
      }
      // Corrupted/partial cache (e.g. from an earlier run without a working
      // ffmpeg) — discard and re-transcode fresh.
      logger.warn({ dst }, 'AudioTranscode: cached companion is not valid Ogg — re-transcoding');
      await fs.promises.unlink(dst).catch(() => {});
      await fs.promises.unlink(metaPath).catch(() => {});
    }
    if (!ffmpegPath) {
      logger.error(
        { srcAbsPath, srcMimeType },
        'AudioTranscode: ffmpeg-static path unresolved — falling back to source file',
      );
      return { path: srcAbsPath, mimeType: srcMimeType, transcoded: false };
    }
    const t0 = Date.now();
    try {
      const { seconds } = await runFfmpeg(srcAbsPath, dst);
      // Compute the WhatsApp-shape waveform from the freshly transcoded file.
      // We compute AFTER transcode (against dst) so amplitude buckets match
      // the file the receiver actually decodes, not the original source.
      const waveform = await computeWaveformViaFfmpeg(dst);
      const meta: CachedMeta = {};
      if (seconds != null) meta.seconds = seconds;
      if (waveform && waveform.length === 64) meta.waveformB64 = waveform.toString('base64');
      if (meta.seconds != null || meta.waveformB64) await writeMeta(metaPath, meta);
      logger.info(
        {
          srcAbsPath, srcMimeType, dst, seconds,
          waveformBytes: waveform?.length ?? 0,
          durationMs: Date.now() - t0,
        },
        'AudioTranscode: produced opus/ogg cache',
      );
      return {
        path: dst,
        mimeType: 'audio/ogg; codecs=opus',
        transcoded: true,
        seconds,
        waveform: waveform ?? undefined,
      };
    } catch (e: any) {
      logger.error(
        { err: e?.message ?? String(e), srcAbsPath, srcMimeType, durationMs: Date.now() - t0 },
        'AudioTranscode: ffmpeg failed — falling back to source file',
      );
      // Best-effort: remove a partial file if ffmpeg wrote one.
      await fs.promises.unlink(dst).catch(() => {});
      return { path: srcAbsPath, mimeType: srcMimeType, transcoded: false };
    }
  },
};
