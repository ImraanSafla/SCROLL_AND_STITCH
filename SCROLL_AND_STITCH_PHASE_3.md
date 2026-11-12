# Scroll & Stitch: Phase 3 Brief

## Buy Me a Coffee button

This brief builds on SCROLL\_AND\_STITCH\_BRIEF.md and SCROLL\_AND\_STITCH\_PHASE\_2.md, which still apply. Add a small, tasteful Buy Me a Coffee donation button at the very bottom of the app, so people who found it useful can support me. Phase 3 may grow later, so keep this addition self-contained.

## Where the existing version lives

I already have this button in another of my apps, **Hangout**, a hang-time training calculator in my GitHub. Find that repo, look at how the button is built (the link, my Buy Me a Coffee username, any embed script or styling) and reuse the same link and account. Do not invent a username or link. If you can't find the Hangout repo or the link, stop and ask me.

## How it should work

- A simple link that opens my Buy Me a Coffee page in a new tab. No payment handling inside the app.
- Prefer a plain styled link over Buy Me a Coffee's embed script or floating widget, so the app stays fast, works offline and loads no third-party tracking. Only use their official script if Hangout does and there's a clear reason.
- Keep the privacy promise intact: nothing about the user's videos or images is ever sent anywhere.
- When offline, the button can still show, but say that it needs a connection if tapped.

## Placement and design

- Sits in a quiet footer at the very bottom of the page, below all content, never competing with Stitch or Save.
- Short friendly line, for example "Found this useful? Buy me a coffee", with a small coffee icon.
- Match the Apple-inspired style from Phase 1: subtle, rounded, light and dark mode, with default, hover (hover-capable devices only), pressed, focus-visible states.
- One gentle animation at most, such as the cup lifting slightly on hover. Respect prefers-reduced-motion.
- Optional: after a successful save, a very subtle one-line mention of the button. Never a popup, never blocking.
- Works on mobile and desktop, with an accessible label.

## Three small extra features

Keep each one light. Build them as separate milestones after the coffee button.

1. **Privacy blur.** In the result preview, a Blur tool lets the user tap or drag over areas (names, emails, notifications) to blur or pixelate them before saving. Blur is baked into the exported PNG, never just a visual layer. Include undo and a clear on/off state.
2. **Share target.** Register the PWA as a Web Share Target so files can be sent to Scroll & Stitch from other apps or the OS share menu and land straight in a new group. Research current support honestly: it works on Android and some desktop browsers, but iOS Safari support is limited. Implement where it works, degrade quietly elsewhere and tell me what you found.
3. **Seam confidence check.** After stitching, mark any seam whose match confidence is below the threshold with a small, subtle indicator in the preview. Tapping it zooms to the seam and offers to nudge the join up or down by a few pixels or to accept it. If every seam is confident, show nothing extra.

**Flags across multiple groups.** The queue never pauses to ask the user anything. It runs every group to the end, then each result card shows a small badge such as "1 seam to check", with no badge when all seams are confident. A single Review button (shown only when there are flags) steps through every flagged seam in queue order across all groups, with next and previous controls and a counter like "2 of 3". Accepting or nudging a seam re-composites only that group, never the whole batch, and its badge updates. Save all stays available but notes gently if seams are unchecked, for example "1 seam not reviewed. Save anyway?".

No accounts, cloud storage or analytics. Everything stays on the device.

## How to work

1. Read the Hangout repo first and tell me what you found: the link, username and how it's implemented.
2. Give me a short plan and wait for approval.
3. Build it, then tell me how to check it on my iPhone and on desktop.

## Definition of done

- The button appears at the bottom of Scroll & Stitch, looks native to the design and opens my real Buy Me a Coffee page.
- No change to app speed, offline support or privacy.
- Phases 1 and 2 still work exactly as before.

## Opening prompt

> Phase 3 of Scroll & Stitch: add a Buy Me a Coffee button, a privacy blur tool, share-target support and a seam confidence check. The brief is in SCROLL\_AND\_STITCH\_PHASE\_3.md, and the earlier briefs still apply. My existing version of this button is in my Hangout repo on GitHub. Find it, check how it's built and reuse the same link. Tell me what you found and give me a short plan before writing any code. Don't break anything from Phases 1 or 2.
