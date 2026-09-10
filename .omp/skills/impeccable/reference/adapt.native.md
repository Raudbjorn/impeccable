> **Additional context needed**: target devices and usage contexts.

Adapt an existing **native** design (`android` / `adaptive`) to a different context: another device class, orientation, or origin. The trap is treating adaptation as scaling. The job is rethinking the experience for the new context, inside the platform conventions of [android.md](android.md); read it before planning if Setup hasn't already.

## Assess Adaptation Challenge

1. **Source context**: what was it designed for, and what assumptions did it make? (Phone-only? Portrait-only? A website?)
2. **Target context**: which device class (phone, tablet, foldable), orientation, and usage posture (one-handed on the go vs two-handed at rest)?
3. **What breaks**: navigation that doesn't fit the target, layouts that stretch instead of restructure, gestures or controls that don't exist there?

## Adaptation Strategies

### Phone → Tablet (large screens)

- **Restructure, don't stretch.** A scaled-up phone UI on a tablet is the failure mode. Use window size classes to switch structure.
- **Navigation changes shape**: the navigation bar becomes a rail or drawer on expanded width.
- **Use the width**: split view / master-detail (list + detail side by side), multi-column grids, popovers where phones used sheets.
- **Multitasking is a size, not an edge case**: Android multi-window can hand you a phone-width window on a tablet; size-class-driven layout handles it for free.

### Orientation & foldables

- Landscape restructures (side-by-side panes, repositioned controls); never clip or letterbox. Lock orientation only when the task truly demands it.
- Foldables: react to posture and hinge via window size classes; test folded, unfolded, and tabletop.

### Web → native (porting a website or web app)

Reconform, don't reflow. Replace web navigation with the platform's model, HTML-shaped controls with platform controls, hover affordances with touch-first ones, and px-based type with sp. Then treat the result to the full platform reference; the slop test there is the acceptance bar.

## Implement & Verify

- Drive structure from **window size classes**, never from device-model checks.
- Respect safe areas and window insets in every new configuration (hinge, status bar, keyboard, display cutouts).
- Test on simulators for breadth, then real hardware for truth: at least one phone and one tablet, both orientations, split-screen where supported.

When the adaptation feels native to each context, hand off to `/skill:impeccable polish` for the final pass.

**NEVER**:
- Ship a stretched phone layout on a tablet
- Hide core functionality on smaller devices (if it matters, make it work)
- Lock orientation to dodge a layout bug
- Trust simulators alone (posture, gestures, and performance need hardware)
