# Scroll & Stitch: Phase 2 Brief

## Still images and the group queue

This brief builds on `SCROLL_AND_STITCH_BRIEF.md`. Everything in that brief still applies: the Apple-inspired visual style, full interaction states, animations, on-device privacy, PWA support and the iPhone constraints. Extend the existing app. Do not rewrite the working video pipeline, and do not break the simple phone flow.

Phase 2 adds two things:

1. **Still image stitching.** The user can give the app a set of ordinary screenshots instead of a screen recording, and it stitches them into one long image.
2. **Groups and a queue.** The user can set up several groups of work (each group is one video or one set of screenshots), then press a single action button to stitch them all and get one long image per group.

---

## Part 1: Still image stitching

### Inputs

- Accept PNG, JPEG and HEIC. Safari decodes HEIC natively but Chrome and Firefox on desktop may not. Research the current support, then either add a lightweight HEIC decoder loaded only when needed or show a friendly message explaining how to export as PNG or JPEG.
- A group of still images needs at least two images. One image on its own is shown as is, with a note that there is nothing to stitch.

### Ordering

Getting the order right matters more than anything else for stills, because there is no video timeline to rely on.

1. **Default order.** Use capture time from EXIF data where available, then the file's last modified time, then natural filename order (so `IMG_2.png` comes before `IMG_10.png`).
2. **Overlap check.** After ordering, check that each image overlaps the next. If the default order produces weak matches, try reordering by overlap: find the image with no match above it (the top) and chain downwards by strongest match. Only use the overlap-based order if it is clearly more confident than the default.
3. **Manual control.** Always let the user reorder thumbnails by dragging before stitching. Show the order the app chose with small numbers on each thumbnail.

### Stitching engine

Reuse the video engine wherever possible, with these differences:

- **Larger offsets.** Consecutive stills can be far apart (often 50 to 90 percent of a screen height), so offset search must cover the full height. Use the same coarse-to-fine approach: row signatures on downscaled images first, then refine on a narrow full-resolution band.
- **Static header and footer.** With only a few images, there are fewer samples to detect fixed bars. Compare all images in the group and treat rows that match across every image as static. If there are only two images, be conservative.
- **No overlap.** If two neighbouring images don't overlap, never fake a join. Place them one after the other, mark the seam clearly in the preview and tell the user which pair has a gap so they can add the missing screenshot.
- **Duplicates.** Detect identical or near-identical images and drop the extras quietly, with a small note.
- **Mixed sizes.** Normalise to the most common width. If images have different orientations or clearly come from different devices or apps, warn the user instead of producing a broken result.
- **Compression noise.** JPEG and HEIC images vary slightly. Matching must tolerate small pixel differences.

The output, preview, trimming controls and Save to Photos flow are the same as for video.

---

## Part 2: Groups and the queue

### The core idea

- **One group equals one output image.**
- A group holds either **one video** or **a set of still images**. Do not mix videos and stills in one group in this phase.
- The user can build up as many groups as they like, then press one action button. The app processes every group in turn and delivers one long image per group.

This is mainly a desktop feature, but it must still work on a phone.

### Layout on desktop

- The main screen becomes a vertical list of **group cards**.
- Each group card has:
  - its own drop zone, which also works as a click-to-browse picker
  - an editable name, defaulting to "Group 1", "Group 2" and so on, or the first file's name
  - a type badge (Video or Screenshots) and a file count
  - a thumbnail strip for stills (reorderable by drag) or a single thumbnail with duration for a video
  - a remove button with a short undo option
  - a status area (Ready, Waiting, Stitching, Done or Needs attention)
- At the end of the list sits a dashed **"+ New group"** card. It is both a button and a drop zone, so dropping files on it creates a new group in one step.
- Cards can be reordered by dragging. Individual images can be dragged from one group to another.

### Smart dropping

The goal is that the app does the obvious thing, so the user rarely has to organise by hand.

- **Dropping files anywhere outside a card** creates new groups:
  - several videos dropped at once become one group per video
  - several images dropped at once become one group
  - a mix of videos and images is split into one group per video plus one group for the images
- **Dropping into an existing card** adds to that group, if the file type fits. If it doesn't fit (a video into a screenshots group), offer to create a new group for it instead of refusing.
- **Smart split suggestion.** If a group of images looks like it contains more than one page (images that don't overlap at all and fall into separate clusters), show a gentle suggestion: "These look like 2 separate pages. Split into 2 groups?" Never split automatically.
- A full-page drop overlay appears while files are dragged over the window, with the card or "+ New group" target highlighted under the cursor.

### The action button

- One primary button, sticky at the bottom of the screen, labelled with the count: **"Stitch all (3)"**. With a single group it simply reads **"Stitch"**.
- Disabled with a clear reason when nothing is ready ("Add a video or screenshots to start").
- While running, it becomes a progress control with a Cancel option.

### Running the queue

- Process groups **one at a time**, in list order, to keep memory low on phones. Release all frames and canvases after each group and keep finished results as compressed Blobs, not canvases.
- Each card shows its own progress with a small version of the stitching animation. The sticky button shows overall progress ("Stitching 2 of 3").
- If one group fails, mark it Needs attention with a plain explanation, then carry on with the rest. Never stop the whole queue for one bad group.
- Groups added while the queue is running join the end of the queue.

### Results and saving

- When a group finishes, its card turns into a result card with a preview, trim controls and its own Save button.
- When the whole queue finishes, the sticky button becomes **"Save all (3)"** with the same soft glow as the Phase 1 Save button.
- **On desktop**, Save all downloads one ZIP of PNGs, named after each group. Use a small, fast ZIP library such as fflate. Individual Save buttons download a single PNG.
- **On iPhone**, Save all opens the share sheet with every PNG at once, so Save Images puts them all in Photos in one tap. If the browser can't share multiple files, fall back to saving them one by one with clear guidance.
- Offer "Clear finished" to tidy up the list after saving.

### Mobile behaviour

- Keep the Phase 1 phone flow as the default: one big drop zone, pick a video or screenshots, stitch, save. Do not show the queue interface until it is needed.
- After the first group is added, show a small **"Add another group"** button. Once there are two or more groups, the screen becomes the same card list as desktop, adapted to a single narrow column.
- On iOS, the picker should allow selecting several images from Photos at once.

### Keeping the queue safe

- Warn before leaving or refreshing the page if there are unsaved results.
- Optionally keep the queue in IndexedDB so a refresh doesn't lose work. Wrap all storage in try/catch and make the app work without it.

---

## Design, states and animation

Follow the Phase 1 visual style and state rules exactly. New elements need the same full set of states: default, hover (on hover-capable devices only), pressed, focus-visible, disabled, drag-over and loading.

New animations, kept subtle and at 60 fps using transform and opacity only:

1. **Cards arriving.** New group cards spring in from slightly below with a fade.
2. **Files landing.** Dropped files fly into the target card as small thumbnails, then settle into the strip.
3. **Reordering.** Smooth position changes when cards or thumbnails are reordered (use the FLIP technique).
4. **Queue progress.** The active card gently lifts and shows the mini stitching animation. Waiting cards stay calm and slightly dimmed.
5. **Completion.** Each card gets a soft seam shimmer as it finishes. When everything is done, Save all arrives with the glow from Phase 1.
6. **Removing.** Cards collapse smoothly, with the rest of the list closing the gap.
7. **Reduced motion.** Respect prefers-reduced-motion: replace movement with simple fades.

---

## Testing

- **Still image test sets.** Generate synthetic sets by cutting a tall image into overlapping crops with varied overlap (from about 10 to 90 percent, plus zero), a fixed header and footer, shuffled file order, duplicates, JPEG compression and one mixed-width image. Check order detection, offsets and gap handling.
- **Queue tests.** A queue of five groups mixing videos and stills, including one deliberately broken group, to confirm that failures don't stop the run and memory is released between groups.
- **Regression.** The Phase 1 single-video flow on iPhone must work exactly as before.
- Extend debug mode to show the chosen image order, match confidence per pair and per-group timing.

---

## How to work

1. Read this brief and the Phase 1 brief, then look at the current codebase before planning.
2. Give me a short plan covering: the data model for groups, how the still image engine reuses the video engine, the queue runner, the desktop and mobile layouts, and the main risks. Wait for my approval.
3. Build in milestones:
   1. Still image stitching for a single group
   2. Group data model and the card list on desktop
   3. Smart dropping and reordering
   4. The queue runner with per-group and overall progress
   5. Results, Save all (ZIP on desktop, share sheet on iPhone)
   6. Mobile adaptation
   7. Phase 2 animations
4. After each milestone, tell me what works, what doesn't and exactly how to test it on my iPhone and on desktop.
5. If a browser limitation gets in the way, say so plainly and suggest alternatives.

---

## Definition of done

- On desktop, I can drop three screen recordings and a folder's worth of screenshots onto the page, see them sorted into sensible groups, press Stitch all and download one ZIP containing a clean long PNG per group.
- On iPhone, I can pick several screenshots from Photos, stitch them and save the result to Photos, and the single-video flow still works as before.
- Image order is right without manual help in normal cases, and easy to fix by dragging when it isn't.
- Gaps between non-overlapping screenshots are flagged, never hidden.
- One failed group never stops the rest of the queue.
