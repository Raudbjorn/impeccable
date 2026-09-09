# Upstream integration

This merge joins the fork's `lets-roll` work with `main` after `main` had
already moved to the Rust engine. An earlier revision of this file recorded the
opposite outcome, that the JavaScript runtime stayed the default and the fork
features had explicitly not been ported. That is no longer true, and the note is
kept rather than deleted because the reasoning it records is what the current
shape has to answer.

## Runtime decision

There is one runtime: the Rust engine behind `skill/scripts/impeccable`. The
JavaScript duplicates of engine verbs are gone.

The merge that produced `lets-roll` had upstream's launcher migration on one
side and the fork's pre-Rust tree on the other, and kept the fork's. Some of
that was collateral: `package.json` went back to 3.6.1 with only puppeteer in
`optionalDependencies` while the commit that made it claimed CLI 4.0.2.

One part was not collateral. The fork's launcher carried an `IMPECCABLE_NATIVE`
bridge that routed each verb to a sibling `.mjs` file, with a comment giving the
reason: concept-seed must never silently select the upstream remote roll
service. That guard is why the JavaScript runtime was still the default, and it
was written to hold "while the native ports are evaluated".

The bridge is now gone, and it is only safe to remove it because the thing it
was guarding has been ported.

## Local retrieval

`crates/context/src/retrieval.rs` is the port of `lib/retrieval-client.mjs`. The
contract is unchanged: a command named under `retrieval` in
`.impeccable/config.local.json` receives one JSON request on stdin and answers
with one JSON response on stdout.

Three properties are worth stating because they are what the guard was
protecting:

- A configured retrieval command wins outright in `concept_seed`. It is checked
  before the local catalog and before the API, and a failure is an error rather
  than a fallback. There is no path where a broken local command quietly becomes
  a remote roll.
- A `.impeccable/config.local.json` that exists but does not parse is an error
  for the same reason. Treating a typo as "not configured" would reintroduce the
  silent fallback through the back door.
- Choice recording (`--chosen`) goes through the retrieval command's `choose`
  op when retrieval is configured, so the remote `/chosen` endpoint is not
  pinged either.

The response is validated rather than trusted: protocol version, session and
round agreement with the request, settings agreement, unique challenger and
composition ids, known well tiers, and a staging that is actually one of the
compositions. A round that fails any of these is rejected where the error can
still name the field, instead of surfacing later as a confusing deck.

`materialize_round` copies every asset the round references into
`.impeccable/retrieval/<session>/` under a content-addressed name and rewrites
the paths, so a later render does not depend on files the retrieval command may
have written somewhere temporary.

## Known gaps

- The Rust port kills a timed-out retrieval command with `kill` on the child
  process. The JavaScript version spawned detached on unix and killed the whole
  process group, so a retrieval command that itself spawns children can still
  leave grandchildren behind on timeout.
- Upstream's `detect_csp` treats `next.config.cjs` and `next.config.cts` as Next
  config files and this fork's does not. The fork's narrower version is
  deliberate and pinned by a test (`apps/legacy/proxy.ts` must not read as
  middleware), so it was kept; the two config extensions are a separate, smaller
  gap that can be closed on their own.
- The fork's `crates/` lead upstream by the `.omp` provider, `omp-hook.js`, the
  label-line-height rule, the live glob tests and now local retrieval, but the
  launcher downloads engine binaries from `pbakaus/impeccable` and this fork
  publishes no engine release. Anyone who does not build from source runs an
  upstream binary without that work, whatever `ENGINE_VERSION` says. The pin
  stays at main's 0.1.0 here: this branch is a merge, not a release, and moving
  the number does not move the binary. Closing the gap means publishing a fork
  engine release and pointing the launcher's download base at it, which is its
  own change with its own release steps.
- Retrieval rounds are the only source that renders compositions without
  `IMPECCABLE_COMPOSITIONS=1`, because a round is validated for a non-empty
  composition list and a staging drawn from it. The flag still gates the other
  sources.
