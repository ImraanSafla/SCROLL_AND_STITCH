# Scroll & Stitch: where we are

Handoff notes for picking this up in a new session. Last updated 12 Nov 2026.

Live app: https://imraansafla.github.io/SCROLL_AND_STITCH/ (add `?debug` for technical details)

## The three briefs

| Brief | What it covers | Status |
| --- | --- | --- |
| [Phase 1](SCROLL_AND_STITCH_BRIEF.md) | One screen recording in, one long screenshot out, on iPhone, offline, installable | 4.5 of 6 milestones done |
| [Phase 2](SCROLL_AND_STITCH_PHASE_2.md) | Stitching ordinary screenshots, plus groups and a queue (desktop and mobile) | Not started. Plan to be written after Phase 1 |
| [Phase 3](SCROLL_AND_STITCH_PHASE_3.md) | Ko-fi coffee button (ko-fi.com/imraan97, from Hangout), privacy blur, share target, seam check | Plan approved, build after Phase 2 |

Build order agreed: Phase 1, then Phase 2, then Phase 3.

## Phase 1 milestones

1. **Frame reading lab** (`/lab.html`). Done. Measured on iPhone: WebCodecs reads full frames ~10x faster than the video element; canvas limit 67 million pixels; a 40,000 px PNG saves to Photos fine.
2. **Scroll measuring + test harness** (`/harness.html`). Done.
3. **Building the long image.** Done. Junk trimming (Control Centre, stop prompt), red recording dot removal, clean seams, PNG of any height, JPEG option. Tested on a real iPhone recording: "looked great".
4. **The app interface** (the home page). Done. Drop zone, progress, zoomable preview, crop handles, bar toggles, PNG/JPEG, recording range, Save to Photos.
5. **Look and motion.** Half done.
   - Done: Tropical Cosmic colours ([design/tropical-cosmic-palette.png](design/tropical-cosmic-palette.png)), rounded headings on Apple devices.
   - To do: the animations approved in the original plan (drop zone breathing and lift, stitching thread, seam shimmer, Save button glow and checkmark, error shake, cross-fades, reduced-motion fallbacks).
6. **Install and offline.** To do. Web app manifest, icons, service worker, final README.

## Open issue

On iPhone, unedited recordings hit "VideoDecoder is not configured" inside the background worker. Frame data has been verified correct; the app now falls back through three readers (worker, page, video seeking) and reports the decoder's real error. **Needs a retest on iPhone with `?debug`**: the first line of the Debug section says which reader worked and what failed, which tells us the real fix.

## Agreed for later

- **UI simplification pass** once everything is built: keep the features, make the screens simpler and easier. Best done in a fresh session.
- Revoke the GitHub token used in the first session and use a repo-only one.

## Working notes

- Code: Vite + TypeScript. `npm run dev`, `npm test` (40 tests), `npm run build`, `GH_TOKEN=… npm run deploy` (publishes the `gh-pages` branch).
- Node is at `~/.local/node/bin` (not on PATH).
- Test videos: `swift scripts/make-sample-video.swift …` (see README); the app loads them with `?debug&sample=scroll-junk`.
- If GitHub Pages sticks on "building", POST to `/repos/ImraanSafla/SCROLL_AND_STITCH/pages/builds`.
