/**
 * M13 screen share: one frame of the shared screen as a JPEG, taken only when the bridge asks. The current video
 * frame is drawn to a fresh canvas at most 1920 px wide and 4096 px tall (never upscaled, the aspect kept) and
 * encoded at quality 0.8. The bridge checks the same bounds (internal/screenshare).
 */

export const FRAME_MAX_WIDTH = 1920;
export const FRAME_MAX_HEIGHT = 4096;
export const FRAME_QUALITY = 0.8;

/** The size a `vw × vh` source is encoded at. */
export function frameSize(vw: number, vh: number, maxW = FRAME_MAX_WIDTH, maxH = FRAME_MAX_HEIGHT): { w: number; h: number } {
  if (!(vw > 0) || !(vh > 0)) return { w: 0, h: 0 };
  const s = Math.min(1, maxW / vw, maxH / vh);
  return { w: Math.max(1, Math.min(maxW, Math.round(vw * s))), h: Math.max(1, Math.min(maxH, Math.round(vh * s))) };
}

/** Why there is no frame: the code a `screen.frame` carries. */
export class FrameError extends Error {
  constructor(
    readonly code: 'not_sharing' | 'unavailable' | 'stopped' | 'encode_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface FrameSource {
  video: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight' | 'readyState'> & CanvasImageSource;
  track: Pick<MediaStreamTrack, 'readyState' | 'muted' | 'enabled'>;
}

type Canvas = Pick<HTMLCanvasElement, 'width' | 'height' | 'getContext' | 'toBlob'>;

/** 2 = HTMLMediaElement.HAVE_CURRENT_DATA. */
const HAVE_CURRENT_DATA = 2;

/** Whether the source has a frame to give: live, not muted (the OS made it unavailable), with pixels. */
export function frameReady(s: FrameSource): boolean {
  return s.track.readyState === 'live' && !s.track.muted && s.track.enabled && s.video.readyState >= HAVE_CURRENT_DATA && s.video.videoWidth > 0 && s.video.videoHeight > 0;
}

/** Encodes the source's current frame. `alive` is checked again after encoding (a Stop during it drops the frame). */
export async function encodeFrame(s: FrameSource, alive: () => boolean, makeCanvas: () => Canvas = () => document.createElement('canvas')): Promise<{ blob: Blob; w: number; h: number }> {
  if (!frameReady(s)) throw new FrameError('unavailable', s.track.muted ? 'the shared source is paused or hidden right now' : 'the shared source has no picture yet');
  const { w, h } = frameSize(s.video.videoWidth, s.video.videoHeight);
  const canvas = makeCanvas();
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!g) throw new FrameError('encode_failed', 'no 2D canvas to draw the frame on');
  g.drawImage(s.video, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', FRAME_QUALITY));
  if (!alive() || !frameReady(s)) throw new FrameError('stopped', 'screen sharing stopped while the frame was taken');
  // toBlob gives null on failure, and falls back to PNG where JPEG is not supported.
  if (!blob || blob.type !== 'image/jpeg') throw new FrameError('encode_failed', 'the browser could not encode a JPEG');
  return { blob, w, h };
}
