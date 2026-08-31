# Verifying the oh-my-pi integration against a live `omp`

Everything Impeccable knows about oh-my-pi was read from its source, not
observed. The unit tests drive the generated hook module through a stand-in
`pi` object, which proves the module's own logic; they cannot prove that
oh-my-pi loads it, calls it with the payloads we expect, or does anything with
what it returns. This walkthrough closes that gap.

Budget about 15 minutes. Nothing here is destructive outside the scratch
directory it creates.

**What is already verified, and what is not.** Checks 1, 2, 7, 8, 9 and 10 were
run against omp/18.0.7 on this machine and pass; they exercise the installer,
the detector, and the hook lifecycle without needing a live session. They are
left in so a future change can be re-checked, but they are not the reason this
document exists.

The checks that matter are **3, 4, 5, 6 and 12**, and none of them can be run
without driving a real `omp` session, which is why they are yours. They are the
only evidence that oh-my-pi loads the hook, calls it with the payloads we
assumed, and does anything with what it returns.

**Report back:** the numbered checks each have an expected result. Note which
pass, and for anything that fails, paste the actual output. A failure at step
4 or 6 invalidates a design assumption, not just an implementation detail.

## 0. Prerequisites

```bash
omp --version                 # verified against omp/18.0.7
node --version                # 20 or newer
cd /home/svnbjrn/projects/mpccbl/integrate-upstream-2026-08
git log --oneline -1          # expect the oh-my-pi integration branch
```

**Install from the local build, not the published bundle.** `skills install`
downloads from impeccable.style by default, and the published bundle has no
`.omp` variant yet, so a plain install fails. Every install command below sets
`IMPECCABLE_BUNDLE_PATH` at the freshly built bundle instead. That stops being
necessary once a release ships with oh-my-pi support.

If you forget, the installer now says so rather than leaving you to guess: it
names the bundle it consulted, lists the variants that bundle does carry, and
prints the `IMPECCABLE_BUNDLE_PATH` command to use instead.

**The hook runs degraded, by design.** Skill scripts ship dependency-free, so
`hook.mjs` has no `htmlparser2` and falls back to regex matching. It says so on
every run. The full rule set is what `npx impeccable detect` runs; the hook is
the cheap always-on tier. This matters here only because it changes which test
fixture produces a finding, which is why the one below is a gradient-text
heading rather than the side-tab you might expect.

## 1. Build and install into a scratch project

```bash
bun run build:release
export IMP=/home/svnbjrn/projects/mpccbl/integrate-upstream-2026-08

SCRATCH=$(mktemp -d)
cd "$SCRATCH"
git init -q .
mkdir -p src
printf '<h1 style="background: linear-gradient(90deg,#7c3aed,#ec4899); -webkit-background-clip: text; color: transparent">Hello</h1>\n' > src/index.html

IMPECCABLE_BUNDLE_PATH="$IMP/dist/universal" node "$IMP/cli/bin/cli.js" skills install --providers omp -y
```

Expect three install lines: the skill into `.omp`, the oh-my-pi agents into
`.omp/agents`, and `Installed hooks into: .omp`.

**Check 1.** The skill, the hook, and the agents are all on disk:

```bash
ls .omp/skills/impeccable/SKILL.md
ls .omp/hooks/post/impeccable.js
head -1 .omp/hooks/post/impeccable.js     # expect the @impeccable-hook-module stamp
ls .omp/agents/                            # expect four impeccable-* files
```

Before this branch the hook file did not exist after an install, and there were
no agents. Verified passing on omp/18.0.7.

**Check 2.** The hook can find the detector it shells out to, and the detector
fires on this fixture:

```bash
grep -c import.meta.url .omp/hooks/post/impeccable.js   # expect 1 (project scope)
ls .omp/skills/impeccable/scripts/hook.mjs

node -e '
const {execFileSync}=require("child_process");
const out=execFileSync(process.execPath,[".omp/skills/impeccable/scripts/hook.mjs"],{
  input: JSON.stringify({hook_event_name:"PostToolUse",tool_name:"edit",
    tool_input:{file_path:"src/index.html"},cwd:process.cwd()}),encoding:"utf8"});
console.log(JSON.parse(out||"{}")?.hookSpecificOutput?.additionalContext||"(no findings)");
'
```

Expect a finding naming `gradient-text`. This drives `hook.mjs` directly with
the payload the module sends, so it isolates the detector from oh-my-pi: if
this is clean, nothing downstream can produce findings and the later checks
would fail for the wrong reason. Verified passing.

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
(for example: "change the heading text to Welcome").

**Check 4.** After the edit lands, expect **both** of these in the transcript:

- the edit tool's own result (the diff or confirmation) still present, and
- an Impeccable finding appended after it, naming `gradient-text`.

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
even though the file still has the gradient-text pattern, the Stop channel is not
working and the deep pass is effectively dead on this harness.

Leave the session (`Ctrl-D`) before continuing.

## 5. Lifecycle: off, status, reset

```bash
node "$IMP/skill/scripts/hook-admin.mjs" status
```

**Check 7.** Expect a `wiring:` line naming `.omp`. Verified passing.

```bash
node "$IMP/skill/scripts/hook-admin.mjs" off
omp        # make an edit again, then exit
```

**Check 8.** Expect no Impeccable findings while disabled. Verified passing
when `hook.mjs` is driven directly (it returns empty output). `off` writes
`hook.enabled: false` into `.impeccable/config.json` and deliberately does not
unwire the module: the kill switch is in-band, read by `hook.mjs` from the
project the event names. If findings still appear, that in-band path is broken.

```bash
node "$IMP/skill/scripts/hook-admin.mjs" on      # expect "already installed"
node "$IMP/skill/scripts/hook-admin.mjs" reset
ls .omp/hooks/post/                            # expect the module to be gone
node "$IMP/skill/scripts/hook-admin.mjs" on       # expect "No hook file installed for: .omp"
```

**Check 9.** `reset` removes the module and `on` afterwards reports it missing
rather than claiming success. Verified passing. `on` cannot recreate it, because the content is a
build artifact hook-admin does not carry; re-running the installer restores it.

## 6. Global scope

```bash
IMPECCABLE_BUNDLE_PATH="$IMP/dist/universal" node "$IMP/cli/bin/cli.js" skills install --providers omp --scope global -y
ls ~/.omp/agent/skills/impeccable/SKILL.md     # expect present
ls ~/.omp/skills 2>&1                          # expect no such directory
grep -m1 HOOK_SCRIPT .omp/hooks/post/impeccable.js
```

**Check 10.** The skill lands under `~/.omp/agent/skills` (the path oh-my-pi
actually scans; `~/.omp/skills` is never read), the agents land under
`~/.omp/agent/agents/`, and the project hook carries an **absolute**
`HOOK_SCRIPT` pointing into that directory rather than the self-relative walk,
which cannot reach across the two roots. Verified passing, including running
the detector through that baked path and getting the expected finding.

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
