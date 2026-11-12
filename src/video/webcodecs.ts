/**
 * Frame-accurate decoding with WebCodecs. mp4box.js reads the MP4/MOV
 * container (sample table, codec config), then VideoDecoder decodes every
 * frame in order using the hardware decoder. No seeking, so every frame is
 * seen exactly once with its true timestamp.
 *
 * Note: VideoFrames are NOT rotated by the track matrix, unlike <video>.
 * `ContainerInfo.rotation` tells the caller how to rotate them.
 */
import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import type { ISOFile, Movie, Sample, Track } from 'mp4box';

/** Our own copy of a compressed sample, independent of mp4box's buffers. */
export interface EncodedSample {
  number: number;
  cts: number;
  duration: number;
  timescale: number;
  isSync: boolean;
  data: Uint8Array<ArrayBuffer>;
}

export interface ContainerInfo {
  brands: string[];
  fragmented: boolean;
  /** Video, audio and other tracks in the file. */
  tracks: string;
  /** Sample count declared by the container (0 for fragmented files). */
  declaredSamples: number;
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** Display rotation from the track matrix, in degrees (0, 90, 180, 270). */
  rotation: number;
  durationSec: number;
  frameCount: number;
  avgFps: number;
  minFrameMs: number;
  maxFrameMs: number;
  /** True if frame durations vary by more than 10%. */
  variableFrameRate: boolean;
  keyframes: number;
  description?: Uint8Array;
}

const CHUNK = 4 * 1024 * 1024;

function rotationFromMatrix(m: ArrayLike<number> | undefined): number {
  if (!m || m.length < 4) return 0;
  // ISO BMFF matrix is 16.16 fixed point: [a b u c d v x y w]
  const a = m[0] / 65536;
  const b = m[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

function getDescription(file: ISOFile, track: Track): Uint8Array | undefined {
  const trak = file.getTrackById(track.id) as unknown as {
    mdia: { minf: { stbl: { stsd: { entries: Array<Record<string, { write(s: DataStream): void } | undefined>> } } } };
  };
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.hvcC ?? entry.avcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      // Strip the 8-byte box header; WebCodecs wants just the payload.
      return new Uint8Array((stream as unknown as { buffer: ArrayBuffer }).buffer, 8);
    }
  }
  return undefined;
}

function summarise(file: ISOFile, info: Movie, track: Track, samples: EncodedSample[]): ContainerInfo {
  const durations = samples.map((s) => (s.duration / s.timescale) * 1000).filter((d) => d > 0);
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const durationSec = track.duration / track.timescale || info.duration / info.timescale;
  const spread = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] / Math.max(0.001, sorted[Math.floor(sorted.length * 0.1)]) : 1;
  return {
    brands: info.brands,
    fragmented: info.isFragmented,
    tracks: info.tracks.map((t) => `${t.type ?? '?'}:${t.codec}`).join(', '),
    declaredSamples: track.nb_samples,
    codec: track.codec,
    codedWidth: track.video?.width ?? track.track_width,
    codedHeight: track.video?.height ?? track.track_height,
    rotation: rotationFromMatrix(track.matrix as unknown as ArrayLike<number>),
    durationSec,
    frameCount: samples.length || track.nb_samples,
    avgFps: durationSec ? (samples.length || track.nb_samples) / durationSec : 0,
    minFrameMs: sorted[0] ?? median,
    maxFrameMs: sorted[sorted.length - 1] ?? median,
    variableFrameRate: spread > 1.1,
    keyframes: samples.filter((s) => s.isSync).length,
    description: getDescription(file, track),
  };
}

/**
 * Read the container and return the video track's samples (compressed data
 * included). Reads the file in 4 MB slices.
 *
 * Unedited iPhone screen recordings put the index (moov) after the frame
 * data (mdat). mp4box drops data it has already parsed past, so reading
 * straight through loses every frame before the index arrives. Instead we
 * read wherever mp4box asks next: it skips over the frame data to the
 * index, then asks for the frame data once it knows what to extract.
 */
export async function demux(blob: Blob, chunkSize = CHUNK): Promise<{ info: ContainerInfo; samples: EncodedSample[] }> {
  const file = createFile();
  let track: Track | undefined;
  let movie: Movie | undefined;
  const samples: EncodedSample[] = [];
  let failure: Error | undefined;
  file.onError = (_mod: string, msg: string) => {
    failure = new Error(msg);
  };
  file.onReady = (info: Movie) => {
    movie = info;
    track = info.videoTracks[0];
    if (!track) {
      failure = new Error('No video track found');
      return;
    }
    file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
    file.start();
  };
  file.onSamples = (_id: number, _user: unknown, batch: Sample[]) => {
    // Copy the bytes out: releaseUsedSamples() frees mp4box's copy.
    for (const s of batch) {
      samples.push({
        number: s.number,
        cts: s.cts,
        duration: s.duration,
        timescale: s.timescale,
        isSync: s.is_sync,
        data: s.data!.slice(),
      });
    }
    if (batch.length) file.releaseUsedSamples(track!.id, batch[batch.length - 1].number + 1);
  };

  let pos = 0;
  let reads = 0;
  const seen = new Set<number>();
  while (pos < blob.size && !failure) {
    // Guard against a loop if mp4box keeps asking for the same place.
    if (seen.has(pos) || ++reads > 100_000) break;
    seen.add(pos);
    const ab = await blob.slice(pos, pos + chunkSize).arrayBuffer();
    const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, pos));
    const declared = track?.nb_samples ?? 0;
    if (declared && samples.length >= declared) break;
    pos = typeof next === 'number' && next !== pos ? next : pos + ab.byteLength;
  }
  file.flush();
  if (failure) throw failure;
  if (!movie || !track) throw new Error('Could not read the video container (moov box missing?)');
  return { info: summarise(file, movie, track, samples), samples };
}

export interface DecodeStats {
  framesOut: number;
  config: VideoDecoderConfig;
}

/**
 * Decode every sample in order. `onFrame` gets each VideoFrame and its
 * presentation time in seconds; the frame is closed right after it returns.
 */
export async function decodeAll(
  info: ContainerInfo,
  samples: EncodedSample[],
  onFrame: (frame: VideoFrame, timeSec: number) => void,
): Promise<DecodeStats> {
  if (typeof VideoDecoder === 'undefined') throw new Error('WebCodecs is not supported');
  const config: VideoDecoderConfig = {
    codec: info.codec,
    codedWidth: info.codedWidth,
    codedHeight: info.codedHeight,
    description: info.description,
    optimizeForLatency: false,
  };
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`Decoder does not support ${info.codec}`);

  let framesOut = 0;
  let error: Error | undefined;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        onFrame(frame, frame.timestamp / 1e6);
        framesOut++;
      } finally {
        frame.close();
      }
    },
    error: (e) => {
      error = e instanceof Error ? e : new Error(String(e));
    },
  });
  decoder.configure(config);

  const waitForQueue = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        decoder.removeEventListener('dequeue', done);
        resolve();
      };
      decoder.addEventListener('dequeue', done);
      setTimeout(done, 50);
    });

  for (const s of samples) {
    if (error) break;
    // Keep the decoder fed but never let decoded frames pile up in memory.
    while (decoder.decodeQueueSize > 8) await waitForQueue();
    decoder.decode(
      new EncodedVideoChunk({
        type: s.isSync ? 'key' : 'delta',
        timestamp: Math.round((s.cts / s.timescale) * 1e6),
        duration: Math.round((s.duration / s.timescale) * 1e6),
        data: s.data,
      }),
    );
  }
  if (!error) await decoder.flush();
  decoder.close();
  if (error) throw error;
  return { framesOut, config };
}
