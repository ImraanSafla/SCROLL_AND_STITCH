# Scroll & Stitch: Claude Code Prompt

Copy everything below the line into Claude Code.

---

## Role and goal

You are building **Scroll & Stitch**, a mobile-first progressive web app (PWA) that turns an iPhone screen recording of someone scrolling into one long, seamless screenshot. It must work in Safari on iOS 27, be installable to the home screen and process everything on the device. No uploads, no server, no accounts.

The user flow is: open the app, pick a screen recording from Photos, wait a few seconds, preview the long image, then save or share it.

## Tech constraints

- Plain static site that can be hosted free on GitHub Pages. Use Vite with vanilla TypeScript unless you have a strong reason otherwise. Explain any framework choice before adding it.
- All processing in the browser. Use an HTML video element plus canvas to extract frames by seeking. Do not rely on ffmpeg.wasm as the main path, because it is heavy and unreliable on iOS. You may offer it as a fallback only if testing proves it necessary.
- Run heavy work in a Web Worker with OffscreenCanvas where Safari supports it, so the interface never freezes. Feature-detect and fall back to the main thread with progress updates.
- Respect iOS memory limits. Process frames in a streaming way, keep only what is needed and never hold the whole video decoded in memory. Very long outputs must be split into multiple images if a single canvas would exceed Safari's maximum canvas size. Research and state the current limit in code comments.
- Include a web app manifest, icons and a service worker so it works offline after first load.

## Stitching algorithm

Implement and document this pipeline:

1. **Frame sampling.** Sample frames at an adaptive rate (start around 6 to 10 per second). Skip near-duplicate frames when nothing has scrolled.
2. **Static region detection.** Compare many frames to find rows that never change at the top and bottom, such as the status bar, navigation bars, Safari's address bar and tab bars. Treat these as fixed header and footer. Keep the header once at the top and the footer once at the bottom of the final image.
3. **Offset estimation.** For each consecutive pair of frames, find the vertical scroll offset within the scrolling region. Start with row-signature matching (for example, per-row grayscale hashes or mean intensities compared with normalised cross-correlation) because it is fast. Refine with pixel comparison on a downscaled strip. Reject matches below a confidence threshold.
4. **Handle hard cases.** Plan explicitly for: scrolling backwards, momentum scroll blur, sticky headers that appear mid-page, animated content like GIFs or video, rubber-band overscroll at the ends, and pages with large blank areas where matching is ambiguous. In ambiguous cases, prefer the offset most consistent with recent scroll velocity.
5. **Compositing.** Append only the newly revealed strip from each frame. Blend or choose the cleanest frame for overlapping seams to avoid visible lines.
6. **Output.** Export as PNG by default, with an option for JPEG at adjustable quality to reduce file size.

## Pause-aware, efficient processing

This takes priority over the sampling in step 1 above. The user knows they are making a screenshot, so they will scroll deliberately and pause on each screenful. Exploit that for speed and accuracy. Never analyse every frame at full resolution.

1. **Cheap skim pass.** Decode frames at a low rate into tiny thumbnails (for example 64 px wide, grayscale). Compute a simple difference score between neighbouring thumbnails to build a motion timeline of the whole video.
2. **Find pauses.** Detect stretches where motion stays near zero for a short time (start around 150 to 300 ms, tunable). Pick the sharpest frame from each pause as an anchor. Anchors are clean, blur-free and the primary source for the final image.
3. **Stitch anchors first.** Estimate offsets between consecutive anchors directly. If two anchors overlap with high confidence, use them and skip everything between.
4. **Fill gaps only when needed.** If neighbouring anchors don't overlap, or confidence is low, sample extra frames from the scroll between them at full resolution, picking the least blurred ones, until coverage is complete. Spend effort only where the cheap pass says it's needed.
5. **No pauses?** Fall back to adaptive sampling based on scroll speed from the motion timeline, so it still works for someone who scrolls continuously.
6. **Coarse to fine matching.** Find offsets on downscaled frames first, then refine on a narrow full-resolution band around the seam.

**Video length.** No hard time limit. Show a gentle warning for very long recordings (over about 20 seconds; typical clips will be around 10 seconds) explaining that memory on iPhone is the real constraint, and keep processing streaming so long videos still work. Report processing time per stage in debug mode so the pause-aware pipeline can be compared against naive sampling for both speed and accuracy.

**Ignore junk at the start and end.** The first and last moments of a screen recording often show something other than the content: the Control Centre closing, the screen-recording indicator or banner, a stop-recording prompt, a dimmed or animating screen, or a different app. Automatically detect and discard these frames before stitching. Find the main stable content by looking for the longest run of frames that share the same static header and footer and whose content matches each other, then drop frames at either end that don't fit it. Also ignore the red recording indicator or status bar pill if it appears inside otherwise good frames. Show the auto-detected start and end in the preview so the user can nudge them if it guessed wrong.

## Interface

**Visual style: clean, modern Apple aesthetic.** Take inspiration from Apple's current design language and the Human Interface Guidelines, without copying Apple logos, icons or trademarks. Use the system font stack (-apple-system, SF Pro), generous white space, a restrained neutral palette with one accent colour, soft rounded corners (around 12 to 20 px on cards and buttons), subtle shadows or translucent blurred surfaces, clear visual hierarchy and smooth, gentle transitions (around 150 to 250 ms). Support light and dark mode properly.

**Every interactive element needs complete states.** Design and implement default, hover, active (pressed), focus-visible and disabled states for all buttons, the drop zone and any controls. Hover only applies on devices that support it (use the hover media query), so touch devices get clear pressed feedback instead, such as a slight scale-down or darker tint. The drop zone also needs a drag-over state. Include a loading state on buttons that trigger processing. Keep all states consistent through shared CSS variables.

### Animations: subtle but beautiful

Motion should feel calm, physical and purposeful, like Apple's own apps. Use spring-like easing, short durations and only animate transform and opacity so it stays at 60 fps on iPhone. Build this as its own milestone after the core works, so animation never slows down development of the stitching.

1. **Drop zone.** At rest, a soft dashed outline with a gently breathing icon. On drag-over, the zone lifts slightly, the outline turns solid in the accent colour and the icon nudges up. On drop or selection, the zone springs back, and the video thumbnail scales and fades into place.
2. **Stitching in progress.** A signature "stitching" animation: a thin thread or needle line that runs down a growing stack of screenshot strips, with each strip sliding in and joining the one above as real progress happens. Tie it to actual pipeline stages (reading, finding pauses, stitching) so it reflects real progress, never a fake loop. Show the stage name underneath in small text.
3. **Reveal.** When finished, the strips settle into one seamless image with a quick, soft shimmer along the seams, then the preview eases in.
4. **Save button.** The Save to Photos button arrives with a gentle spring and a soft glow that pulses slowly two or three times, then rests at a subtle glow so it never feels nagging. On tap, it presses down, then shows a smooth checkmark morph when saving succeeds.
5. **Micro-interactions.** Smooth state changes on every button, gentle error shakes for invalid files, and soft cross-fades between screens.
6. **Accessibility.** Respect prefers-reduced-motion: replace movement with simple fades and drop the pulsing glow.

Before building, describe the animation plan and timings to me in a short list for approval.

- Mobile-first, thumb-friendly, one main screen. Large "Choose recording" button using a file input that accepts video.
- Clear progress indicator with stages: reading video, analysing, stitching, done.
- Scrollable preview of the result with pinch zoom.
- Simple manual controls after stitching: trim top and bottom, toggle whether to keep the header and footer, and a crop handle.
- Save and share using the Web Share API with files, so the user can tap Save Image to put it in Photos. Provide a download link as fallback.
- Short in-app tips: scroll slowly and steadily, avoid tapping during the recording, and trim the start and end of the recording in Photos first.
- Respect light and dark mode. Keep it accessible with proper labels and contrast.

**Video picker: tap on mobile, drag and drop on desktop.** Make the main area one large drop zone that doubles as the picker. On a phone, tapping anywhere in it opens the file input set to accept video, so iOS shows the Photos library and the user picks the recording. On desktop, the same zone accepts drag and drop like Google Drive: highlight it clearly while a file is dragged over, accept a drop anywhere on the page, and still allow clicking to browse. Validate that the file is a video, show a friendly error otherwise, and show a thumbnail and duration once a video is loaded. Support replacing the video without reloading the page.

**Saving to Photos is the priority action.** As soon as stitching finishes, show one large, obvious "Save to Photos" button at the bottom of the screen, within thumb reach. It exports a PNG and opens the iOS share sheet with the file, where Save Image puts it straight into the Photos app. Web apps cannot write to Photos silently, so make this a single tap to the share sheet with no extra steps, and add a one-line hint the first time: "Tap Save Image". Keep the file name meaningful, such as the page title or date. Show a clear success state afterwards. Make sure the PNG is full resolution and that very long images split into parts are all shared together.

## Quality and testing

- Build a small test harness that runs the stitcher on sample videos and reports the detected offsets, confidence and processing time. Generate your own synthetic test videos (a tall image scrolled at varying speeds with a fixed header) so the algorithm can be checked without real recordings.
- Write unit tests for offset estimation and static region detection.
- Include a debug mode, toggled by a URL parameter, that overlays detected seams and shows per-frame offsets.
- Target: a 10 second recording processes in under 5 seconds on a recent iPhone.

## How to work

1. Before writing code, give me a short plan covering architecture, the algorithm and the main risks on iOS Safari. Wait for my approval.
2. Build in small, testable milestones: frame extraction, then offset estimation with the test harness, then compositing, then the interface, then PWA and deployment.
3. After each milestone, tell me what works, what doesn't and how to test it on my iPhone.
4. Add a README with setup, how to deploy to GitHub Pages and known limitations.
5. If you hit a platform limitation, say so plainly and propose alternatives rather than quietly working around it.

## Extra context about iPhone recordings

- iPhone screen recordings are usually HEVC (H.265) MP4 or MOV files with a variable frame rate, sometimes 60 fps, often around 1170 to 1320 px wide. Test that Safari decodes them and handle the variable frame rate when seeking.
- Seeking a video element is not frame-accurate on Safari. Prefer requestVideoFrameCallback where available, verify each extracted frame actually changed and never assume a seek landed exactly.
- Recordings can be portrait or landscape. Detect orientation and handle both.
- Some recordings include a dynamic island or notch area, rounded corners and the home indicator bar. Treat them as part of the static header and footer.
- Colour and brightness can shift slightly between frames because of compression. Make matching tolerant of small pixel noise.
- Privacy is a feature: state in the interface that videos never leave the phone.

## Definition of done

- I can open the site on my iPhone, add it to my home screen, pick a 10 second recording of a Safari page and save a clean long PNG to Photos in under 10 seconds total.
- No visible seams, duplicated rows, missing strips, recording banners or Control Centre frames in the result.
- The same flow works on desktop with drag and drop.
- It works offline after the first visit.
