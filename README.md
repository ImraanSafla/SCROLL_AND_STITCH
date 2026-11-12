# Scroll & Stitch

Turns an iPhone screen recording of someone scrolling into one long screenshot, entirely on the device. No uploads, no server, no accounts.

**Live:** https://imraansafla.github.io/SCROLL_AND_STITCH/

> Work in progress. The full spec is in [SCROLL_AND_STITCH_BRIEF.md](SCROLL_AND_STITCH_BRIEF.md), with Phase 2 in [SCROLL_AND_STITCH_PHASE_2.md](SCROLL_AND_STITCH_PHASE_2.md).

## Status

| Milestone | State |
| --- | --- |
| 1. Frame extraction lab (`/lab.html`) | Done, measured on iPhone |
| 2. Offset estimation + test harness (`/harness.html`) | Done, awaiting iPhone results |
| 3. Compositing and output | |
| 4. Interface | |
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
```

Styles: `pauses` (scroll, pause, repeat), `continuous`, `fast`.

## Deploy to GitHub Pages

The site is served from the `gh-pages` branch.

```bash
npm run build
GH_TOKEN=<token with repo access> npm run deploy
```

Then in the repo's Settings → Pages, set the source to the `gh-pages` branch (only needed once).

## How the analysis works

See the header comment in [src/pipeline/analyse.ts](src/pipeline/analyse.ts). In short: skim tiny thumbnails at 8 fps, find pauses, read only the sharp frames from each pause at full resolution, match them coarse to fine, and read extra frames only where two anchors don't overlap confidently.

Frames come from WebCodecs (mp4box.js demuxer + hardware decoder) where available, falling back to seeking a `<video>` element. On iPhone (Milestone 1), WebCodecs read full-resolution pixels in 12 ms against 131 ms via the video element.

## Known limitations

- Videos with a rotation flag use the slower seeking path for now.
- Junk at the start and end of a recording (Control Centre, banners) is not trimmed yet (Milestone 3).
- Safari's toolbar shrinking mid-recording is not handled yet: header and footer are detected once per video.
