# Scroll & Stitch

Turns an iPhone screen recording of someone scrolling into one long screenshot, entirely on the device. No uploads, no server, no accounts.

**Live:** https://imraansafla.github.io/SCROLL_AND_STITCH/

> Work in progress. The full spec is in [SCROLL_AND_STITCH_BRIEF.md](SCROLL_AND_STITCH_BRIEF.md), with Phase 2 in [SCROLL_AND_STITCH_PHASE_2.md](SCROLL_AND_STITCH_PHASE_2.md) and Phase 3 in [SCROLL_AND_STITCH_PHASE_3.md](SCROLL_AND_STITCH_PHASE_3.md). Build order: Phase 1, then 2, then 3.

## Status

| Milestone | State |
| --- | --- |
| 1. Frame extraction lab (`/lab.html`) | Done, measured on iPhone |
| 2. Offset estimation + test harness | Done |
| 3. Compositing and output (`/harness.html`) | Done, tested on iPhone |
| 4. Interface (the app at `/`) | Done, awaiting iPhone test |
| 5. Animations | |
| 6. PWA, offline, README | |

## Setup

Needs Node 20 or newer.

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN with --host)
npm run build      # type-check and build to dist/
npm test           # unit tests
```

## Synthetic test videos

`scripts/make-sample-video.swift` (macOS only) renders a fake scrolling page with a fixed header and footer, encodes it as HEVC like an iPhone recording, and writes the true scroll offset of every frame to a matching `.json` file.

```bash
swift scripts/make-sample-video.swift public/samples/scroll-demo.mp4 hevc 7 pauses
swift scripts/make-sample-video.swift public/samples/scroll-junk.mp4 hevc 31 pauses junk
```

Styles: `pauses` (scroll, pause, repeat), `continuous`, `fast`. Adding `junk` puts a Control Centre swipe at the start, a stop-recording prompt at the end and the red recording indicator in the status bar. Each video also gets a `.png` of the perfect stitched result, which the harness compares against (by brightness, since video codecs blur colour edges by a row or two).

## Deploy to GitHub Pages

The site is served from the `gh-pages` branch.

```bash
npm run build
GH_TOKEN=<token with repo access> npm run deploy
```

Then in the repo's Settings → Pages, set the source to the `gh-pages` branch (only needed once).

## Using the app

Open the site, tap **Choose a screen recording** (or drop a video anywhere on desktop), wait a few seconds, then **Save to Photos** (iPhone) or **Download image** (desktop). After stitching you can trim the top and bottom (drag the handles or use the steppers), remove the status bar in one tap, drop the fixed top/bottom bars, hide the red recording dot, choose PNG or JPEG, and change which part of the recording is used.

Add `?debug` to the URL for seam markers, per-frame positions and stage timings. `?debug&sample=scroll-junk` loads a bundled test video. `?reader=seek` forces the slower video-seeking reader.

## How the analysis works

See the header comment in [src/pipeline/analyse.ts](src/pipeline/analyse.ts). In short: skim tiny thumbnails at 8 fps, find pauses, read only the sharp frames from each pause at full resolution, match them coarse to fine, and read extra frames only where two anchors don't overlap confidently.

Frames come from WebCodecs (mp4box.js demuxer + hardware decoder) where available, falling back to seeking a `<video>` element. On iPhone (Milestone 1), WebCodecs read full-resolution pixels in 12 ms against 131 ms via the video element.

## Known limitations

- Videos with a rotation flag use the slower seeking path for now.
- Junk detection watches the status bar. A recording that starts or ends in a different app with an identical-looking status bar won't be trimmed automatically; the app will let you nudge the range (Milestone 4).
- Hiding the red recording indicator also removes the clock it surrounds.
- JPEG output taller than 16,384 px is split into parts; PNG never is.
- Safari's toolbar shrinking mid-recording is not handled yet: header and footer are detected once per video.
