/**
 * Frame access through an HTML <video> element. Works everywhere, but
 * Safari's seeking is not frame-accurate, so every grab reports the media
 * time actually shown (via requestVideoFrameCallback where available).
 */

export interface LoadedVideo {
  duration: number;
  width: number;
  height: number;
}

export function waitFor(target: EventTarget, event: string, timeoutMs = 10_000): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    const onEvent = (e: Event) => {
      cleanup();
      resolve(e);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Video error while waiting for "${event}"`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

export async function loadVideo(el: HTMLVideoElement, file: Blob): Promise<LoadedVideo> {
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  if (el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
  el.src = URL.createObjectURL(file);
  await waitFor(el, 'loadedmetadata');
  // iOS ignores preload until playback starts. A muted play() is always
  // allowed and makes Safari start decoding so that seeks produce frames.
  try {
    await el.play();
  } catch {
    /* ignored: some browsers refuse; seeking still works */
  }
  el.pause();
  if (el.readyState < 2) await waitFor(el, 'loadeddata');
  return { duration: el.duration, width: el.videoWidth, height: el.videoHeight };
}

export interface SeekResult {
  requested: number;
  /** Media time of the frame actually presented, if the browser told us. */
  mediaTime?: number;
  /** Whether requestVideoFrameCallback confirmed a new frame. */
  confirmed: boolean;
}

const hasRVFC = () => 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/**
 * Seek and wait until the new frame is actually ready to draw.
 * Waits for "seeked", then up to `frameWaitMs` for requestVideoFrameCallback.
 */
export function seekTo(el: HTMLVideoElement, t: number, frameWaitMs = 150): Promise<SeekResult> {
  return new Promise((resolve) => {
    let seeked = false;
    let frame: number | undefined;
    let rvfcHandle = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (confirmed: boolean) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (!confirmed && rvfcHandle && hasRVFC()) el.cancelVideoFrameCallback(rvfcHandle);
      resolve({ requested: t, mediaTime: frame, confirmed });
    };
    if (hasRVFC()) {
      rvfcHandle = el.requestVideoFrameCallback((_now, meta) => {
        frame = meta.mediaTime;
        rvfcHandle = 0;
        if (seeked) finish(true);
      });
    }
    el.addEventListener(
      'seeked',
      () => {
        seeked = true;
        if (!hasRVFC() || frame !== undefined) finish(frame !== undefined);
        else timer = setTimeout(() => finish(false), frameWaitMs);
      },
      { once: true },
    );
    el.currentTime = t;
  });
}

export interface PlaybackFrame {
  mediaTime: number;
  presentedFrames: number;
}

/**
 * Play the video at `rate` and call `onFrame` for every frame the browser
 * presents. Fast, but the browser may drop frames at high rates.
 */
export async function playThrough(
  el: HTMLVideoElement,
  rate: number,
  onFrame: (el: HTMLVideoElement, f: PlaybackFrame) => void,
): Promise<void> {
  el.pause();
  await seekTo(el, 0);
  el.playbackRate = rate;
  let stopped = false;
  let handle = 0;
  const ended = waitFor(el, 'ended', (el.duration / rate) * 1000 + 15_000);
  if (hasRVFC()) {
    const cb = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      onFrame(el, { mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames });
      handle = el.requestVideoFrameCallback(cb);
    };
    handle = el.requestVideoFrameCallback(cb);
  } else {
    let last = -1;
    const tick = () => {
      if (stopped) return;
      if (el.currentTime !== last) {
        last = el.currentTime;
        onFrame(el, { mediaTime: last, presentedFrames: 0 });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  try {
    await el.play();
    await ended;
  } finally {
    stopped = true;
    if (handle && hasRVFC()) el.cancelVideoFrameCallback(handle);
    el.pause();
    el.playbackRate = 1;
  }
}
