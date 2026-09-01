# Design Context

Loaded by `/impeccable design-context`. Owns the design interview record and its portable form (export/import). The interview itself is created by `/impeccable document` seed mode; this command is everything afterwards.

There is currently no interactive way to reopen or re-run the interview: that
used to be the picker, a browser UI removed from this project along with its
server. `export` and `import` still work; they read and write the store
directly and never launched a UI. See `docs/add-branding.md` for what the
picker was and how a replacement UI (or a new component generally) could be
built the same way.

## Where it lives

One store, under the project root:

```text
.impeccable/design-context/
  context.json    the chat half of the interview: product, audience, brand, interview
  answers.json    the questionnaire's decisions
  assets/         brand files the user supplied
  fonts/          font faces the user uploaded
  cue.png         the chosen cue image, copied at submit
  runtime/        session.json, journal.jsonl, draft.json (local, gitignored)
  exports/        the written-out forms (local, gitignored)
```

`.impeccable/visual-cues/` is separate on purpose: it is the generation workspace, regenerable and gitignored, and the document no longer depends on it. The store is the user's own record and is theirs to commit.

## No argument

Report status in two lines, then act:

- Whether `answers.json` exists, and when it was last written.
- Whether a draft is waiting (`runtime/draft.json`), whether DESIGN.md is seeded, and whether a session is live (`runtime/session.json` naming a running process).

With answers on disk, report the status above and stop; offer `export` if the user wants a portable copy. Without them, say the design context is created by the questionnaire and offer `/impeccable document`. Never start the questionnaire unasked, and never claim the interview can be reopened or re-run in place; it can't right now.

## export

```text
node .vibe/skills/impeccable/scripts/design-context-export.mjs [--out DIR] [--no-assets]
```

`--out` defaults to `.impeccable/design-context/exports/`. Writes two files and prints an `EXPORTED` line for each. Tell the user what each is for, in one line each:

- `design-context.md` is the design context as one readable document. It is what to hand another tool, another agent, or a collaborator who needs to follow this design.
- `design-context.bundle.json` is the same context in a form `/impeccable design-context import` reads, including the files the user supplied.

Do not read the export back into the conversation; the user asked for a file, not a recitation.

## import

```text
node .vibe/skills/impeccable/scripts/design-context-import.mjs <bundle.json> [--design skip|write] [--force]
```

It refuses a project that already has a design context unless `--force`, and refuses either way while `runtime/session.json` names a still-running process (a stale leftover from before the picker's removal; there is no way to "close it" anymore, so treat this as a report-and-stop, not an instruction to relay). Report what it prints:

- `DESIGN_MD carried` with a DESIGN.md already here: ask whether to refresh it from the imported context, overwrite it, or merge by hand, then act.
- `DESIGN_MD carried` with none here: if this is what the user wants, `--design write` has to be on *this* import command, not a follow-up (re-running import afterward hits the existing-context refusal and needs `--force`, which also wipes and re-lands assets and fonts). If the import already ran without it, re-seed DESIGN.md from the now-imported answers through [document.md](document.md) Steps 5-6 instead; that path does not require re-importing.
- `DESIGN_MD absent`: say the bundle carried decisions but no design document, and offer to seed one through document.md's Steps 5-6.

## Pitfalls

- Never drive the questionnaire yourself. The answers are the user's, and a run you filled in is a run they did not make.
- Never claim `open`, `edit`, or any live review of the document is available. It isn't, until a replacement UI exists.
