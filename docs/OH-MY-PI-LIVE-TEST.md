# Verifying the oh-my-pi integration against a live `omp`

Everything Impeccable knows about oh-my-pi was read from its source, not
observed. The unit tests drive the generated hook module through a stand-in
`pi` object, which proves the module's own logic; they cannot prove that
oh-my-pi loads it, calls it with the payloads we expect, or does anything with
what it returns. This walkthrough closes that gap.

Budget about 15 minutes. Nothing here is destructive outside the scratch
directory it creates.

**Report back:** the numbered checks each have an expected result. Note which
pass, and for anything that fails, paste the actual output. A failure at step
4 or 6 invalidates a design assumption, not just an implementation detail.

## 0. Prerequisites

```bash
omp --version                 # any recent build
node --version                # 20 or newer
cd /home/svnbjrn/projects/mpccbl/integrate-upstream-2026-08
git log --oneline -1          # expect the oh-my-pi integration branch
```

## 1. Build and install into a scratch project

```bash
bun run build:release

SCRATCH=$(mktemp -d)
cd "$SCRATCH"
git init -q .
mkdir -p src
printf '<div style="border-left: 3px solid #666; position: fixed; left: 0">side tab</div>\n' > src/index.html

node /home/svnbjrn/projects/mpccbl/integrate-upstream-2026-08/cli/bin/cli.js skills install --providers omp -y
```

**Check 1.** The skill and the hook are both on disk:

```bash
ls .omp/skills/impeccable/SKILL.md
ls .omp/hooks/post/impeccable.js
head -1 .omp/hooks/post/impeccable.js     # expect the @impeccable-hook-module stamp
```

Before this branch, the second file did not exist after an install. Its absence
is the P0 this work fixes.

**Check 2.** The hook can find the detector it shells out to:

```bash
node -e '
const m = require("fs").readFileSync(".omp/hooks/post/impeccable.js","utf8");
const rel = m.includes("import.meta.url");
console.log(rel ? "self-relative (project scope, expected here)" : "absolute path baked in");
'
ls .omp/skills/impeccable/scripts/hook.mjs
```

## 2. Does oh-my-pi load the hook at all?

This is the assumption nothing in the repo has ever verified.

```bash
omp                      # start a session in $SCRATCH
```

**Check 3.** In the session, run `/extensions` (or whatever the current build
calls its extension inspector). Expect `impeccable` to appear as a loaded
hook from `.omp/hooks/post/`.

If it does not appear, stop and report that: the file location is documented in
oh-my-pi's `docs/config-usage.md`, but documented is not the same as observed,
and everything below depends on it.

## 3. Does the edit hook fire, and does it preserve the tool's output?

In the same session, ask the model to make a small edit to `src/index.html`
(for example: "change the side tab text to 'nav'").

**Check 4.** After the edit lands, expect **both** of these in the transcript:

- the edit tool's own result (the diff or confirmation) still present, and
- an Impeccable finding appended after it, naming `side-tab`.

This is the contract that was wrong before: the hook used to return a bare
string as `content`, and oh-my-pi's executor takes `result.content ?? tool.content`,
so the finding **replaced** the edit output instead of following it. If you see
the finding but the edit output is gone, that regression is back.

**Check 5.** Ask for an edit that touches two files at once (for example: "add
a comment to the top of both src/index.html and a new src/other.html"). Expect
a finding for each file that has one.

Before this branch the module read only `event.input.path`, which oh-my-pi
drops entirely once an edit targets two or more files, so multi-file edits were
silently unscanned.

## 4. Does the Stop pass reach the model?

End the turn and let the session settle.

**Check 6.** Expect the deep pass to surface findings and the session to take
another turn rather than settling silently.

This is the second contract fix: `additionalContext` on its own is discarded by
`#sessionStopContinuationContext`, which only carries context when
`continue: true` accompanies it. If the session settles with no findings shown
even though the file still has the `side-tab` pattern, the Stop channel is not
working and the deep pass is effectively dead on this harness.

Leave the session (`Ctrl-D`) before continuing.

## 5. Lifecycle: off, status, reset

```bash
node /home/svnbjrn/projects/mpccbl/integrate-upstream-2026-08/skill/scripts/hook-admin.mjs status
```

**Check 7.** Expect a `wiring:` line naming `.omp`.

```bash
node .../skill/scripts/hook-admin.mjs off
omp        # make an edit again, then exit
```

**Check 8.** Expect no Impeccable findings while disabled. `off` writes
`hook.enabled: false` into `.impeccable/config.json` and deliberately does not
unwire the module: the kill switch is in-band, read by `hook.mjs` from the
project the event names. If findings still appear, that in-band path is broken.

```bash
node .../skill/scripts/hook-admin.mjs on      # expect "already installed"
node .../skill/scripts/hook-admin.mjs reset
ls .omp/hooks/post/                            # expect the module to be gone
node .../skill/scripts/hook-admin.mjs on       # expect "No hook file installed for: .omp"
```

**Check 9.** `reset` removes the module and `on` afterwards reports it missing
rather than claiming success. `on` cannot recreate it, because the content is a
build artifact hook-admin does not carry; re-running the installer restores it.

## 6. Global scope

```bash
node .../cli/bin/cli.js skills install --providers omp --scope global -y
ls ~/.omp/agent/skills/impeccable/SKILL.md     # expect present
ls ~/.omp/skills 2>&1                          # expect no such directory
grep -m1 HOOK_SCRIPT .omp/hooks/post/impeccable.js
```

**Check 10.** The skill lands under `~/.omp/agent/skills` (the path oh-my-pi
actually scans; `~/.omp/skills` is never read), and the project hook now
carries an **absolute** `HOOK_SCRIPT` pointing into that directory rather than
the self-relative walk, which could not reach across the two roots.

**Check 11.** Start `omp` from a *different* directory and confirm the skill is
still offered. That is what a global install is for.

## 7. Native subagents

```bash
ls .omp/agents/                                  # four impeccable-* agents
head -6 .omp/agents/impeccable-asset-producer.md # expect autoloadSkills: impeccable
```

**Check 12.** In an `omp` session, ask it to list available task agents (or
invoke `impeccable-asset-producer` through `task`). Expect the agent to be
discoverable, and when spawned, to already have the impeccable skill loaded
rather than asking what it is.

`autoloadSkills` is documented as doing exactly that; this is the only check
here that exercises it.

## 8. Plugin channel (optional)

```bash
omp plugin marketplace add Raudbjorn/impeccable
omp plugin install impeccable
```

**Check 13.** The skill loads from the plugin channel. Note that plugin-channel
**agents** carry `${CLAUDE_PLUGIN_ROOT}` script paths, which oh-my-pi does not
substitute, so subagents are expected to be broken on this path; the native
`.omp/agents/` install in step 7 is the supported route. Confirming that
expectation is useful either way.

## Cleanup

```bash
rm -rf "$SCRATCH"
rm -rf ~/.omp/agent/skills/impeccable ~/.omp/agent/agents/impeccable-*
```

## What each failure would mean

| Check | If it fails |
|---|---|
| 3 | oh-my-pi does not load `.omp/hooks/post/*.js` as documented. The whole hook approach needs rethinking, not patching. |
| 4 | The `ToolResultEventResult.content` contract was misread, or changed. Re-read `shared-events.ts`. |
| 5 | `normalizeToolEventInput` does not supply `paths` the way its source suggests. |
| 6 | The `session_stop` continuation gate differs from `#sessionStopContinuationContext`. The deep pass is dead on this harness until fixed. |
| 8 | The in-band kill switch does not reach the hook, which would make `off` a no-op for oh-my-pi users. |
| 10 | The user skills root is not `~/.omp/agent/skills`, and the global-install fix is wrong. |
| 12 | `autoloadSkills` does not do what the docs say; native subagents would need the skill named some other way. |
