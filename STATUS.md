# Scroll & Stitch: where we are

Handoff notes for picking this up in a new session. Last updated 13 Nov 2026.

Live app: https://imraansafla.github.io/SCROLL_AND_STITCH/ (add `?debug` for technical details)

## The three briefs

| Brief | What it covers | Status |
| --- | --- | --- |
| [Phase 1](SCROLL_AND_STITCH_BRIEF.md) | One screen recording in, one long screenshot out, on iPhone, offline, installable | Milestones 1–4 done, 5–6 to do |
| [Phase 2](SCROLL_AND_STITCH_PHASE_2.md) | Stitching ordinary screenshots, plus groups and a queue (desktop and mobile) | Not started. Plan to be written after Phase 1 |
| [Phase 3](SCROLL_AND_STITCH_PHASE_3.md) | Ko-fi coffee button (ko-fi.com/imraan97, from Hangout), privacy blur, share target, seam check | Plan approved, build after Phase 2 |

Build order agreed: Phase 1, then Phase 2, then Phase 3.

## Phase 1 milestones

1. **Frame reading lab** (`/lab.html`). Done. Measured on iPhone: WebCodecs reads full frames ~10x faster than the video element; canvas limit 67 million pixels; a 40,000 px PNG saves to Photos fine.
2. **Scroll measuring + test harness** (`/harness.html`). Done.
3. **Building the long image.** Done. Junk trimming (Control Centre, stop prompt), red recording dot removal, clean seams, PNG of any height, JPEG option. Tested on a real iPhone recording: "looked great".
4. **The app interface** (the home page). Done, then simplified at Imraan's request (13 Nov):
   - Original warm colours (orange accent `#e8542a`, dark `#ff6a3d`, warm off-white / near-black). The Tropical Cosmic palette was tried and **rejected**; its reference image stays in `design/` only for history. Do not reapply it.
   - Hidden: zoom buttons (pinch and double-tap zoom still work), format choice (always full-quality PNG), "Recording used" range (only with `?debug`).
   - Status bar removed by default; the "Remove status bar" chip and crop handles undo it.
   - No sticky save bar and no hint line. Three buttons at the end of the page: **Save to Photos** (share sheet; hidden where sharing files isn't supported), **Download PNG** (becomes the main button on desktop), **Make a new stitch**.
5. **Motion.** To do: the animations approved in the original plan (drop zone breathing and lift, stitching thread, seam shimmer, Save button glow and checkmark, error shake, cross-fades, reduced-motion fallbacks), in the original colours. Keep them subtle; the save buttons are no longer sticky, so the Save glow applies to the button at the end of the page.
6. **Install and offline.** To do. Web app manifest, icons, service worker, final README.

## Open issue

On iPhone, unedited recordings hit "VideoDecoder is not configured" inside the background worker. Frame data has been verified correct; the app now falls back through three readers (worker, page, video seeking) and reports the decoder's real error. **Needs a retest on iPhone with `?debug`**: the first line of the Debug section says which reader worked and what failed, which tells us the real fix.

## Agreed for later

- **Further UI simplification pass** once everything is built: keep the features, make the screens simpler and easier. A first round is done (see Milestone 4). Imraan feels stitching accuracy is already high enough, so the focus is simplicity, not more controls. Known rough edge: the Trim row wraps awkwardly on a phone.
- Revoke the GitHub token used in the first session and use a repo-only one.

## Working notes

- Code: Vite + TypeScript. `npm run dev`, `npm test` (40 tests), `npm run build`, `GH_TOKEN=… npm run deploy` (publishes the `gh-pages` branch).
- Node is at `~/.local/node/bin` (not on PATH).
- Test videos: `swift scripts/make-sample-video.swift …` (see README); the app loads them with `?debug&sample=scroll-junk`.
- If GitHub Pages sticks on "building", POST to `/repos/ImraanSafla/SCROLL_AND_STITCH/pages/builds`.
