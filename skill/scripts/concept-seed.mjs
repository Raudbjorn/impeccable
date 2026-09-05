#!/usr/bin/env node
/**
 * External concept seed: the dice half of new-work's complete-direction and
 * established-world surface procedures.
 *
 * Before this script runs, the model retrieves cultural material and derives
 * a grounded shortlist of complete candidate directions from it (see
 * reference/new-work.md). Left alone, it then always builds its #1 —
 * and a single model's resonance ranking is deterministic, so every run
 * in a category ships the same one or two concepts. Measured: 30/35
 * identical concepts across 16 prompt framings; the model cannot roll
 * its own dice.
 *
 * This script rolls them from outside, the same trick that made the
 * palette seed work:
 *   - ASSIGNED INDEX: which entry of the model's own resonance-ordered
 *     shortlist gets built. The assignment is the dice: it never chooses an
 *     ungrounded ingredient, it only refuses the argmax rut. Attended runs
 *     present the assigned direction and offer re-roll instead of a ranked
 *     lineup, because a lineup hands selection back to a taste function
 *     (model or user) and taste functions pick the safest card.
 *   - CHALLENGERS (6): outside forms from concept-ingredients.json, two from
 *     each challenger tier (graphic system, instrument language, atmosphere
 *     world), fused with the product first (challenger supplies form and
 *     system grammar, product supplies every fact, clarity wins conflicts),
 *     then weighed against the derived candidates on audience identification
 *     and product clarity. They win only when they beat the grounded list;
 *     measured behavior is that they lose to strong cultural material and
 *     win over thin categories, which is the intended shape.
 *   - RE-ROLL (--reroll <n>): round n of the same base key. The script
 *     recomputes what rounds 0..n-1 drew, excludes all of it, and rolls a
 *     fresh assigned index, challengers, and compositions. One base key therefore
 *     reproduces the entire chain of rounds.
 *   - REGISTER (--register safer|bolder): the user's steering on the
 *     familiar-to-bold axis, applied to a re-roll round. A register changes
 *     only what this round instructs, never what it dealt: the same key and
 *     reroll count reproduce the same deal whatever the register, so the
 *     exclusion chain never forks. bolder presents the dealt foreign forms
 *     as the whole hand (first-dealt leads, dice-assigned by deal order);
 *     safer spends the dealt hand unseen and presents the familiar register,
 *     the model's conventional grounded candidates plus the canon against
 *     named competitors, the one sanctioned lineup of the model's own list.
 *     Registers are user-requested, never pre-selected by the model.
 *   - RATINGS: the reviewer's approval ratings weight the challenger draw
 *     (3-star doubles the odds, 1-star sits out); the approved pool itself
 *     is unchanged.
 *
 * Usage:
 *   node scripts/concept-seed.mjs --scope direction --mode persuade
 *   node scripts/concept-seed.mjs --scope direction --mode persuade --seed-declined="<user's verbatim skip answer>"
 *   node scripts/concept-seed.mjs --scope surface --mode operate --from <key>
 *   node scripts/concept-seed.mjs --scope surface --mode operate --grain flow
 *   node scripts/concept-seed.mjs --scope direction --candidate-count 6
 *   node scripts/concept-seed.mjs --scope direction --mode persuade --from <key> --reroll 1
 *   node scripts/concept-seed.mjs --scope direction --mode persuade --from <key> --reroll 1 --register bolder
 *   node scripts/concept-seed.mjs --chosen <challenger-id> --kind challenger --from <key> --scope direction
 *   node scripts/concept-seed.mjs --kind assigned --from <key> --scope direction
 *
 * --seed-declined records that the user was offered the document --seed
 * questionnaire on a no-DESIGN.md project and skipped it. The flag carries
 * evidence: its value is the user's verbatim skip answer, quoted from the
 * conversation. Without it, a --scope direction roll on a project with no
 * DESIGN.md refuses to deal and prints the pause directive instead; a bare
 * or empty flag refuses the same way (a real live session self-passed the
 * boolean form without asking, which is why the flag demands the quote).
 * Fabricating or paraphrasing the quote is a contract violation, not a
 * shortcut.
 *
 * --grain names how much of the product is in play: product, flow, view, or
 * region. A docs site, an onboarding flow, a landing page and a data table are
 * four different amounts of product and want different compositions. Grain is a
 * preference: it deals matching compositions first and tops up from the rest of
 * the register, and the rendered seed says how many actually matched so a
 * borrowed structure is never mistaken for a supplied one.
 *
 * --platform names the delivery target (web, android). Unlike grain this is
 * a hard filter: a composition that needs hover or a pointer does not degrade on
 * a phone, it stops working. --mode also gates which worlds are eligible, for
 * worlds whose reviewer marked them as carrying only some modes.
 *
 * --mode names the requested surface's mode (persuade, operate, read,
 * experience) so the appended compositions match its register of work; omitted,
 * they roll from the full approved pool.
 *
 * Configured retrieval takes an explicit task brief and uses the local
 * catalog with Voyage reranking. Sessions freeze the brief and candidate pool;
 * replay and rerolls use saved data. Without retrieval configuration, explicit
 * local JSON remains supported, followed by a disclosed assignment-only seed.
 * Choices are recorded locally against a saved session; no remote roll or
 * anonymous choice service is contacted.
 *
 * Env vars:
 *   IMPECCABLE_CONCEPT_SEED — same as --from; for reproducible eval runs.
 *   IMPECCABLE_CATALOG_DIR  — directory holding the four catalog JSON files.
 *   Local retrieval: configure retrieval.command in .impeccable/config.local.json.
 *   --brief-file starts a session; --session with --reroll continues it; --replay reads it.
 *   IMPECCABLE_SEED_DECLINED — set to 1 to bypass the seed pause without a
 *     quote; the unattended escape for eval and CI harnesses that
 *     legitimately roll direction on a no-DESIGN.md workspace. Never for
 *     attended sessions; the bypass is logged to stderr so it stays auditable.
 */

import crypto from 'node:crypto';
import { retrievalConfig, callRetrieval, materializeRound } from './lib/retrieval-client.mjs';
import { dirname, join, relative, resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  approvedPoolRevision,
  readConceptCatalog,
  validateConceptCatalog,
  WELL_TIERS,
} from './lib/concept-catalog.mjs';
import { readCompositionCatalog } from './lib/composition-catalog.mjs';
import {
  COMPOSITION_GRAINS,
  COMPOSITION_PLATFORMS,
  runSyncSelection,
  selectApprovedChallengers as selectApprovedChallengersCore,
  selectApprovedCompositions as selectApprovedCompositionsCore,
} from './lib/roll-selection.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// The CLI resolves configured retrieval first. Explicit local JSON remains
// available for compatibility; without either, emit assignment-only output.
const CATALOG_DIR = process.env.IMPECCABLE_CATALOG_DIR || here;
const localStates = new Map();
function loadLocal(catalogDir = CATALOG_DIR) {
  if (localStates.has(catalogDir)) return localStates.get(catalogDir);
  let localState;
  try {
    const catalogState = readConceptCatalog(
      join(catalogDir, 'concept-ingredients.json'),
      join(catalogDir, 'concept-reviews.json')
    );
    const validation = validateConceptCatalog(catalogState.catalog, catalogState.reviewData);
    if (validation.errors.length > 0) {
      throw new Error(`invalid catalog: ${validation.errors.join('; ')}`);
    }
    const compositionState = readCompositionCatalog(
      join(catalogDir, 'composition-ingredients.json'),
      join(catalogDir, 'composition-reviews.json')
    );
    localState = {
      concepts: catalogState.concepts,
      compositions: compositionState.compositions,
    };
  } catch {
    localState = null;
  }
  localStates.set(catalogDir, localState);
  return localState;
}

function requireLocalConcepts() {
  const local = loadLocal();
  if (!local) {
    throw new Error('concept-seed: no local catalog (set IMPECCABLE_CATALOG_DIR or pass sourceConcepts)');
  }
  return local;
}

// Compatibility export: choice recording is local and requires a saved session.
export async function pingChosen({ chosenId, kind, session, round = 0, register = null, key, scope, mode, cwd = process.cwd() }) {
  if (!session) {
    if (retrievalConfig(cwd)) throw new Error('A local retrieval choice requires --session <saved session ID>');
    return false;
  }
  const response = await callRetrieval({ op: 'choose', session, round, register,
    kind: kind || (chosenId ? 'challenger' : undefined), entry: chosenId,
    settings: Object.fromEntries(Object.entries({ key, scope, mode }).filter(([,v]) => v !== undefined)) }, { cwd });
  return response.recorded;
}



export function renderChallenger(concept, index) {
  const system = concept.system.map(rule => `       - ${rule}`).join('\n');
  const board = concept.cardBoard;
  const hero = concept.cardHero;
  return `  ${index + 1}. ${concept.form}
     SOURCE ID: ${concept.id}
     CREATIVE SPARK: ${concept.spark}
     SYSTEM GRAMMAR:
${system}
     WEB LEVERAGE: ${concept.webLeverage}
     ${board || hero ? `QUALITY BAR: ${[board && `board ${board}`, hero && `hero ${hero}`].filter(Boolean).join(' · ')}` : 'REFERENCE IMAGERY: none recorded; do not invent a card URL.'}
${(concept.references || []).map(r => `     ${r.label}: ${r.path}`).join('\n')}
${(concept.evidence || []).map(e => `     EVIDENCE (${e.role}): ${e.source_id || e.source}${e.page_no ? `, page ${e.page_no}` : ''}${e.span_id ? `, span ${e.span_id}` : ''}`).join('\n')}`;
}

export function renderComposition(composition, index = null) {
  const grammar = composition.grammar.map(rule => `       - ${rule}`).join('\n');
  return `  ${index == null ? '' : `${index + 1}. `}${composition.form}
     SOURCE ID: ${composition.id}
     SPARK: ${composition.spark}
     COMPOSITION GRAMMAR:
${grammar}
     WEB LEVERAGE: ${composition.webLeverage}
${(composition.references || []).map(r => `     ${r.label}: ${r.path}`).join('\n')}
${(composition.evidence || []).map(e => `     EVIDENCE (${e.role}): ${e.source_id || e.source}${e.page_no ? `, page ${e.page_no}` : ''}${e.span_id ? `, span ${e.span_id}` : ''}`).join('\n')}`;
}

// Selection itself lives in lib/roll-selection.mjs so this script and the roll
// API run one algorithm rather than two that drifted. These wrappers add only
// what is local to the skill: resolving the catalog when no pool is passed, and
// driving the generator with Node's synchronous hash, which keeps a local render
// synchronous for prepared eval sessions and tests.
function driveSelection(generator) {
  return runSyncSelection(generator, input => crypto.createHash('sha256').update(input).digest('hex'));
}

export function dealCompositions({ scope, key, reroll = 0, mode = null, grain = null, platform = null, sourceCompositions = null, count = 3 }) {
  const compositions = sourceCompositions ?? requireLocalConcepts().compositions;
  return driveSelection(selectApprovedCompositionsCore({ scope, key, reroll, mode, grain, platform, compositions, count }));
}

// Array-returning form, which is what every caller wanted before the match
// report existed.
export function selectApprovedCompositions(options) {
  return dealCompositions(options).picks;
}

// Compatibility for callers that need a single smoke-test sample.
export function selectApprovedComposition(options) {
  return selectApprovedCompositions({ ...options, count: 1 })[0] ?? null;
}

export function selectApprovedChallengers({ scope, key, reroll = 0, mode = null, sourceConcepts = null }) {
  const source = sourceConcepts ?? requireLocalConcepts().concepts;
  const { approved, picks } = driveSelection(selectApprovedChallengersCore({ scope, key, reroll, mode, concepts: source }));
  return {
    approved,
    picks,
    poolRevision: approvedPoolRevision(source),
    catalogCount: source.length,
  };
}

const SEED_MODES = new Set(['persuade', 'operate', 'read', 'experience']);

export function renderConceptSeed({
  scope = 'surface',
  key = process.env.IMPECCABLE_CONCEPT_SEED || crypto.randomBytes(4).toString('hex'),
  reroll = 0,
  register = null,
  mode = null,
  grain = null,
  platform = null,
  candidateCount = 7,
  catalogDir = CATALOG_DIR,
  _resolvedData = undefined,
} = {}) {
  if (scope !== 'surface' && scope !== 'direction') {
    throw new Error('concept-seed: --scope must be direction or surface');
  }
  if (!Number.isInteger(reroll) || reroll < 0) {
    throw new Error('concept-seed: --reroll must be a non-negative integer');
  }
  if (register !== null && register !== 'safer' && register !== 'bolder') {
    throw new Error('concept-seed: --register must be safer or bolder');
  }
  if (register !== null && reroll < 1) {
    throw new Error('concept-seed: --register steers a re-roll round; pass --reroll <n> with it');
  }
  if (register !== null && scope !== 'direction') {
    throw new Error('concept-seed: --register applies to direction rounds only');
  }
  if (mode !== null && !SEED_MODES.has(mode)) {
    throw new Error('concept-seed: --mode must be persuade, operate, read, or experience');
  }
  // Grain needs no mode: how much of the product is in play is independent of
  // which register of work it is.
  if (grain !== null && !COMPOSITION_GRAINS.includes(grain)) {
    throw new Error(`concept-seed: --grain must be one of ${COMPOSITION_GRAINS.join(', ')}`);
  }
  if (platform !== null && !COMPOSITION_PLATFORMS.includes(platform)) {
    throw new Error(`concept-seed: --platform must be one of ${COMPOSITION_PLATFORMS.join(', ')}`);
  }
  if (!Number.isInteger(candidateCount) || candidateCount < 5 || candidateCount > 7) {
    throw new Error('concept-seed: --candidate-count must be an integer from 5 to 7');
  }
  const unit = (salt) => {
    const h = crypto.createHash('sha256').update(`${scope}:${salt}:${key}`).digest();
    return h.readUInt32BE(0) / 0xffffffff;
  };
  const indexSalt = reroll === 0 ? 'index' : `index:reroll-${reroll}`;
  const buildIndex = 3 + Math.floor(unit(indexSalt) * (candidateCount - 2)); // 3..candidateCount
  // Surface scope deals a hand of three grounded structures: one card is not
  // a choice, and the full ranked list would hand selection back to the
  // model's taste. The dice pick all three; the primary index leads. The
  // no-lineup rule stays direction-only, where it was written for worlds.
  const dealtIndices = [buildIndex];
  for (let draw = 0; scope === 'surface' && dealtIndices.length < Math.min(3, candidateCount); draw += 1) {
    const idx = 1 + Math.floor(unit(`${indexSalt}:deal-${draw}`) * candidateCount);
    if (!dealtIndices.includes(idx)) dealtIndices.push(idx);
    if (draw > 64) { // hash repeats cannot stall the deal
      for (let fill = 1; dealtIndices.length < Math.min(3, candidateCount); fill += 1) {
        if (!dealtIndices.includes(fill)) dealtIndices.push(fill);
      }
    }
  }

  // CLI retrieval supplies resolved data. Direct callers retain local JSON
  // and a disclosed assignment-only seed. The assigned index is pure local
  // math, so even a fully offline run keeps the anti-argmax mechanism.
  let data = _resolvedData ?? null;
  if (_resolvedData === undefined) {
    const local = loadLocal(catalogDir);
    if (local) {
      const { approved, picks, poolRevision, catalogCount } = selectApprovedChallengers({
        scope,
        key,
        reroll,
        mode,
        sourceConcepts: local.concepts,
      });
      data = {
        source: 'local',
        poolRevision,
        approvedCount: approved.length,
        catalogCount,
        challengers: picks,
        ...(() => {
          const dealt = dealCompositions({ scope, key, reroll, mode, grain, platform, sourceCompositions: local.compositions });
          return { compositions: dealt.picks, compositionMatch: dealt.match };
        })(),
      };
    } else {
      data = null; // No remote fallback. A configured backend is resolved by the CLI.

    }
  }

  const promotedInstruction = scope === 'direction'
    ? `After ordering the grounded directions by resonance, build candidate
  ${buildIndex} of your own grounded list; the assignment never points at a
  challenger. The assignment is the roll, not a suggestion: your top-ranked
  direction is what every run would ship, so the script decides which grounded
  direction gets built. Each direction joins a durable visual system to a
  concrete expression for the requested first surface, decided as one. It must
  survive the current task plus navigation, quiet and dense content,
  interaction and state, and a substantially different future surface. In an
  attended run, present the assigned direction fully committed and offer
  re-roll. You may add ONE card for your top-ranked grounded candidate when
  it is not the assigned direction, kicker IMPECCABLE’S PICK, with an honest risk line
  naming its familiarity; one pick card, never a ranked lineup, and the pick
  never takes the lead position. When the assignment IS your top candidate,
  there is no pick card. Re-roll yourself only
  on named factual grounds, when the assignment cannot carry the product's
  truth or task; taste is never grounds.`
  : `After ordering the task's grounded structural candidates by resonance,
  deal candidates ${dealtIndices.join(', ')} of your own grounded list to the
  table; index ${buildIndex} leads, and the deal never points at a challenger.
  The deal is the roll, not a suggestion: the dice decide which structures
  reach the user, so the ranking rut stays broken while the user still gets a
  real choice, and the full ranked list stays yours. In an attended run,
  present the three dealt structures as full cards of equal salience, the
  lead carrying kicker THE ROLL, with steer and re-roll, and let the user
  lock one in; the world is already settled, so this choice is composition.
  Visualize every dealt card: with image generation available and a
  comp-led default (.impeccable/config.json buildPath; the page toggle
  handles the exception), declare a comp per card and generate after
  serving, lead first; otherwise author each card's wireframe field (see
  serve-question --schema) and the page draws the schematic. Carry the
  recorded default in the payload as buildPath with toggle: true. Locking a card
  approves its comp: a surface round that put three visualized structures on
  the table replaces the three-option comp round in visualize.md. Re-roll
  yourself only when every dealt structure fails audience identification or
  product clarity on named factual grounds.`;

  const challengerInstruction = scope === 'direction'
    ? `Fuse each challenger before judging it: the challenger supplies the form
  and its system grammar, the product supplies every fact, and clarity wins
  conflicts. Weigh the fused result against the assigned direction on exactly
  two axes, audience identification and product clarity. Losing to strong
  grounded material is a valid outcome; beating a thin or tool-monoculture
  list is the point. A fused challenger that wins both axes becomes the build.
  Close the weighing with a verdict per challenger, decided before any
  borrowing is considered: wins (beats the assigned direction on both axes),
  competitive (holds one axis), or declined (loses both). A declined
  challenger is not spent: name the one discipline of its system the assigned
  direction lacks, and raise the assigned direction to match before
  presenting it. A donation transfers ambition and system discipline, never
  the challenger's clothes; one world owns the page. Write each raise as its
  own named line on the presented direction, and carry every verdict, kept
  line, and raise into the decision page payload.`
  : `A challenger wins only when its fused result beats the grounded list on
  audience identification and product clarity. It may change task topology or
  interaction, but never the committed visual identity.`;

  const authorityInstruction = scope === 'direction'
    ? `PRODUCT.md and explicit incumbent brand commitments constrain every direction.
The seed never chooses exact colors, fonts, tokens, or a user preference, and
it never permits the world and first surface to be selected independently.`
  : `PRODUCT.md and DESIGN.md constrain every surface candidate's identity
vocabulary; they do not cancel task-level composition. The seed never
authorizes a new palette, type system, material world, or unfamiliar control
behavior.`;

  const richnessInstruction = `The CREATIVE SPARK is a complete visual system, not a theme or decorative
reference. Translate every supplied system rule into the product: palette and
material, type and composition, topology, controls and states, and adaptation.
Keep the source's visible character, scale, rhythm, and interaction instead of
reducing vivid grammar to generic nouns. When the source is already a credible
interface language, commit to it across navigation, content, controls, and
states. Otherwise keep a literal carrier only when it becomes functional.
Ambitious motion, spatial media, or interaction is welcome when it strengthens
the product without weakening semantics, performance, or fallback behavior.`;

  if (!data) {
    // A degraded roll can still serve the safer register, which needs no
    // catalog at all: the assignment machinery is suppressed entirely, the
    // same as the non-degraded safer round, because emitting both "the user
    // picks" and a mandatory numbered build order hands the model two
    // contradicting instructions and the mandatory one tends to win. The
    // bolder register is exactly the thing degradation took away, so it
    // falls back to a plain grounded round, disclosed.
    const degradedHeader = `${scope.toUpperCase()} CONCEPT SEED (key: ${key}; mode: ${mode ?? 'unscoped'}; source: degraded; rerun with --scope ${scope}${mode ? ` --mode ${mode}` : ''} --from ${key}${reroll > 0 ? ` --reroll ${reroll}` : ''}${register ? ` --register ${register}` : ''} --candidate-count ${candidateCount})`;
    if (register === 'safer') {
      return `${degradedHeader}
SAFER REGISTER (user-requested): the assigned index is suspended this
  round; the user picks, and no candidate is mandated. Present the familiar
  register: your remaining grounded candidates from the conventional end, at
  most three, as full cards with an honest risk line each, plus the canon
  executed against two or three named competitors. This is the one sanctioned
  lineup of your own ranked candidates; it exists only by this explicit
  request. When the user voices a standing preference for it, record a brand
  commitment in PRODUCT.md.
${authorityInstruction}
A user- or brief-pinned decision beats the roll, always.
REGISTER (restated for truncated readers): safer, user-requested; the
assigned index is suspended this round and the user picks; seed key ${key}.
`;
    }
    const degradedRegister = register === 'bolder'
      ? `BOLDER REGISTER UNAVAILABLE: bolder deals foreign forms, and this roll ran
  degraded with no catalog and no roll service, so there is nothing bold to
  deal. Tell the user, then run this round as a plain grounded re-roll; the
  assignment below applies.
`
      : '';
    return `${degradedHeader}
${degradedRegister}${scope === 'direction' ? `ASSIGNED INDEX: ${buildIndex}` : `DEALT INDICES: ${dealtIndices.join(', ')} (index ${buildIndex} leads)`}
  ${promotedInstruction}
  The assignment exists to refuse the model's ranking rut, never to outrank
  the user or the brief. Never expose assignment metadata in user-facing labels.
No challengers this run: no local catalog or retrieval backend is configured.
Configure retrieval.command in .impeccable/config.local.json to use the local
catalog, or set IMPECCABLE_CATALOG_DIR for explicit JSON compatibility.
No remote roll service is contacted. This run
ran degraded, with no challengers and no quality-bar boards; do not present
the outcome as a full roll. A degraded roll changes the cards, not the
channel: when a browser can open, present the direction on the decision page
(serve-question.mjs, text-only card); the structured question tool remains
the no-browser fallback.
${authorityInstruction}
A user- or brief-pinned decision beats the roll, always.
${scope === 'direction'
    ? `ASSIGNED INDEX (restated for truncated readers): ${buildIndex}. Build candidate
${buildIndex} of your own grounded list; seed key ${key}.`
    : `DEALT INDICES (restated for truncated readers): ${dealtIndices.join(', ')}; index
${buildIndex} leads. Present all three dealt structures; seed key ${key}.`}
`;
  }

  // Field order is the migration: `compositions` is current, `stagings` is what
  // the API emitted while these were called stagings, and `staging` is the
  // single-pick shape from before it dealt three. Older installs keep working.
  // Compositions are pulled from the deal until the expanded catalog is
  // ready for prime time: the current pool crowds the decision more than it
  // widens it. IMPECCABLE_COMPOSITIONS=1 re-enables rendering for catalog
  // development; the draw machinery, axes, and grain report stay intact.
  const compositionsEnabled = data.source === 'retrieval' || process.env.IMPECCABLE_COMPOSITIONS === '1';
  const compositions = !compositionsEnabled ? []
    : Array.isArray(data.compositions)
      ? data.compositions
      : Array.isArray(data.stagings)
        ? data.stagings
        : data.staging ? [data.staging] : [];
  // The grain report. A top-up keeps the deal at three, which is right, but it
  // must not read as three on-target inputs: a flow request answered entirely by
  // view-grain compositions means the model has to derive the flow's own
  // structure and borrow only their sequence law. Silence here would reproduce
  // the exact failure this axis exists to fix.
  const match = data.compositionMatch ?? null;
  const grainNote = (() => {
    if (!match?.grain) return '';
    if (match.grainAvailable === 0) {
      return `\nNONE of these sit at the requested ${match.grain} grain, because the catalog holds no ${match.grain}-grain composition yet. Derive that structure yourself and borrow only their sequence and attention laws.`;
    }
    if (match.atGrain === 0) {
      return `\nNONE of these sit at the requested ${match.grain} grain, though ${match.grainAvailable} exist; these were topped up from the rest of the register. Treat their structure as borrowed.`;
    }
    if (match.atGrain < compositions.length) {
      return `\n${match.atGrain} of ${compositions.length} sit at the requested ${match.grain} grain; the rest were topped up from the register and their structure is borrowed.`;
    }
    return '';
  })();
  const compositionBlock = compositions.length > 0
    ? `\n${scope === 'direction' ? 'FIRST-SURFACE COMPOSITION INPUTS (identity-free; test them with shortlisted worlds and keep world plus composition one decision):' : 'COMPOSITION CHALLENGERS (identity-free; dress them in the committed visual identity before judging):'}
${compositions.map((composition, index) => renderComposition(composition, index)).join('\n')}
Each one asks the same question of this build: what is the cleverest way to
present, organize, or make interactive the problem in front of you? They carry
structure only, never a palette, typeface, or material. Treat them as serious
rivals to your habitual layout, and keep only what makes this product clearer.${grainNote}\n`
    : '';
  const rerollBlock = reroll > 0
    ? `RE-ROLL ROUND ${reroll}${register ? ` (${register.toUpperCase()} REGISTER, user-requested)` : ''}: ${data.reusedIds?.length ? 'The frozen catalog pool has exhausted fresh options; the explicitly listed reused catalog entries may return. Grounded candidates must still be new.' : 'every candidate presented in earlier rounds, grounded and challenger alike, is eliminated and may not return reworded.'}${register ? '' : ` Derive
  genuinely new grounded candidates from unexplored angles before judging
  these fresh challengers.`}\n`
    : '';
  // A register swaps the round's presentation, never its deal: the assigned
  // index and challenger fetch stay identical so the chain reproduces, and
  // only the instructions change.
  const saferBlock = `SAFER REGISTER: the user asked for the familiar end of the spectrum, so this
  round's dealt hand is spent unseen, stays excluded from future rounds, and
  is not printed. The assigned index is suspended this round; the user picks. Present the familiar register: your remaining grounded
  candidates from the conventional end, at most three, as full cards with an
  honest risk line each, plus the canon executed against two or three named
  competitors. This is the one sanctioned lineup of your own ranked
  candidates; it exists only by this explicit request. When the user voices a
  standing preference for it, record a brand commitment in PRODUCT.md.`;
  const bolderBlock = `BOLDER REGISTER: the user asked for foreign forms at full commitment, so no
  grounded direction is presented this round and the assigned index is
  suspended. The hand is every dealt challenger below, each fused with the
  product and presented as a full card; the FIRST dealt challenger leads, an
  assignment by deal order, so the dice still choose. Verdicts and donations
  apply between the challengers, weighed against the leader. The pick card
  sits out; the canon stays, as always.`;
  // A retrieved direction records its choice before opening build phases.
  const sessionArgs = data.session ? ` --session ${data.session} --reroll ${reroll}` : '';
  const registerArgs = register ? ` --register ${register}` : '';
  const nextCommand = scope === 'direction'
    ? `AFTER THE CHOICE, run exactly one command and follow what it prints (do not suppress its output; do not write page code before it):
  node ${relative(process.cwd(), here) || '.'}/build-phase.mjs start --direction ${key} --kind <assigned|pick|challenger|canon>${data.session ? ' [--chosen <challenger-id>]' : ''}${sessionArgs}${registerArgs}
  It records a retrieved choice locally and opens the build phases: on a comp-led build the comp round is the first gate (three comps, one approved); on a code-led build it prints the contract step.\n`
    : data.session
      ? `AFTER THE CHOICE, record it locally: node ${relative(process.cwd(), here) || '.'}/concept-seed.mjs --kind <assigned|pick|challenger|canon> [--chosen <challenger-id>]${sessionArgs}${registerArgs}. Follow its NEXT instruction.\n`
      : `AFTER THE CHOICE: the locked card's comp is the approved comp; run node ${relative(process.cwd(), here) || '.'}/build-phase.mjs start --comp <that comp> and follow what it prints.\n`;
  const choiceBlock = nextCommand;
  const assignedBlock = register === null
    ? `${scope === 'direction' ? `ASSIGNED INDEX: ${buildIndex}` : `DEALT INDICES: ${dealtIndices.join(', ')} (index ${buildIndex} leads)`}
  ${promotedInstruction}
  The assignment exists to refuse the model's ranking rut, never to outrank
  the user or the brief. Never expose assignment metadata in user-facing labels.`
    : register === 'safer' ? saferBlock : bolderBlock;
  // A bolder round has no assigned grounded direction, so the generic
  // weighing instruction (which measures against the assignment) would
  // contradict the register; the bolder variant weighs against the leader.
  const bolderChallengerInstruction = `Fuse each challenger before judging it: the challenger supplies the form
  and its system grammar, the product supplies every fact, and clarity wins
  conflicts. Weigh every fused challenger against the fused LEADER, the first
  dealt, on exactly two axes, audience identification and product clarity;
  verdicts and donations apply between the challengers, and one that beats
  the leader on both axes presents as the hand's strongest alternate.`;
  const roundChallengerInstruction = register === 'bolder' ? bolderChallengerInstruction : challengerInstruction;
  const challengerSection = register === 'safer'
    ? ''
    : `CHALLENGERS:
${data.challengers.map(renderChallenger).join('\n')}
${compositionBlock}${roundChallengerInstruction}
Open recorded QUALITY BAR imagery or source references for the challengers
you weigh seriously. Source pages document an origin; generated specimen
drafts still require review. Neither is an approved mockup of this product.
When no imagery is recorded, work from the supplied text and evidence.
`;
  const restated = register === null
    ? (scope === 'direction'
      ? `ASSIGNED INDEX (restated for truncated readers): ${buildIndex}. Build candidate
${buildIndex} of your own grounded list; seed key ${key}.`
      : `DEALT INDICES (restated for truncated readers): ${dealtIndices.join(', ')}; index
${buildIndex} leads. Present all three dealt structures; seed key ${key}.`)
    : `REGISTER (restated for truncated readers): ${register}, user-requested; the
assigned index is suspended this round; seed key ${key}.`;
  return `${scope.toUpperCase()} CONCEPT SEED (key: ${key}; mode: ${mode ?? 'unscoped'}; source: ${data.source}; approved pool: ${data.poolRevision}; ${data.approvedCount}/${data.catalogCount} human-approved; rerun with ${data.session ? `--session ${data.session} --reroll ${reroll}${registerArgs} --replay` : `--scope ${scope}${mode ? ` --mode ${mode}` : ''} --from ${key}${reroll > 0 ? ` --reroll ${reroll}` : ''}${registerArgs} --candidate-count ${candidateCount}`} to reproduce this roll against this catalog revision)
${rerollBlock}${assignedBlock}
${challengerSection}${authorityInstruction}
${richnessInstruction}
${choiceBlock}A user- or brief-pinned decision beats the roll, always.
${restated}
`;
}

/**
 * What the model must do next, once a direction (or surface structure) is
 * chosen. Read from the same config the boot directive reads:
 * `.impeccable/config.local.json` over `.impeccable/config.json`,
 * `buildPath` comp|code; with neither, comp-led whenever image generation
 * exists (an OpenAI key here; a harness-native image tool is invisible to
 * this script, so the text names it too), code-led otherwise.
 */
export function nextStepAfterChoice({ key, scope, cwd = process.cwd(), env = process.env } = {}) {
  let buildPath = null;
  for (const name of ['config.json', 'config.local.json']) {
    try {
      const raw = JSON.parse(readFileSync(resolve(cwd, '.impeccable', name), 'utf8'));
      if (raw?.buildPath === 'comp' || raw?.buildPath === 'code') buildPath = raw.buildPath;
    } catch { /* absent */ }
  }
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scripts = relative(cwd, scriptsDir) || '.';
  const imageGen = !!env.OPENAI_API_KEY;
  const seed = key ? ` --direction ${key}` : '';
  if (buildPath === 'code') {
    return `NEXT (code-led, from .impeccable config): write the direction contract, then build; no comp round. Load reference/new-work.md section 5 and 6.\n`;
  }
  const why = buildPath === 'comp' ? 'from .impeccable config' : imageGen ? 'default: image generation is available' : 'default: comp-led unless no image tool exists; if your harness truly has none and there is no OpenAI key, this is code-led and you say so in one line';
  if (scope === 'surface') {
    return `NEXT (comp-led, ${why}): the locked card's comp is the approved comp. Run: node ${scripts}/build-phase.mjs start --comp <that comp> and follow its NEXT lines. Do not write page code before build-phase.mjs advance has closed the spec, plates, and hero gates.\n`;
  }
  return `NEXT (comp-led, ${why}): the world is chosen; the composition is not. Run: node ${scripts}/build-phase.mjs start${seed} and follow its NEXT lines: it opens the comps phase (three comps under .impeccable/mocks/, one approved by the user through the decision page or structured question, sidecar "approved": true), then spec, plates, hero, sections, motion, responsive, review. Do not write page code before those gates close. Reference: reference/visualize.md for the comp round.\n`;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // Node resolves import.meta.url through symlinks but leaves argv[1] as the
    // invoked path. Compare real paths so a linked skill still runs its CLI.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  const scopeIdx = args.indexOf('--scope');
  const rerollIdx = args.indexOf('--reroll');
  const registerIdx = args.indexOf('--register');
  const modeIdx = args.indexOf('--mode');
  const grainIdx = args.indexOf('--grain');
  const platformIdx = args.indexOf('--platform');
  const candidateCountIdx = args.indexOf('--candidate-count');
  const chosenIdx = args.indexOf('--chosen');
  const kindIdx = args.indexOf('--kind');
  const value = name => args.indexOf(name) < 0 ? undefined : args[args.indexOf(name) + 1];
  const session = value('--session');
  const replay = args.includes('--replay');
  // --seed-declined carries evidence: the user's verbatim skip answer, in
  // either --seed-declined="<answer>" or --seed-declined <answer> form. A
  // bare or empty flag does not count; a live session self-passed the
  // boolean form without asking the user, so the flag demands the quote.
  let seedDeclinedAnswer = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--seed-declined') {
      const next = args[i + 1];
      seedDeclinedAnswer = next !== undefined && !next.startsWith('--') ? next : '';
    } else if (args[i].startsWith('--seed-declined=')) {
      seedDeclinedAnswer = args[i].slice('--seed-declined='.length);
    }
  }
  const seedDeclinedByEnv = process.env.IMPECCABLE_SEED_DECLINED === '1';
  const seedDeclined = Boolean(seedDeclinedAnswer && seedDeclinedAnswer.trim()) || seedDeclinedByEnv;
  try {
    if (chosenIdx !== -1 || kindIdx !== -1) {
      // Choice records are local. A failed write must not report success.
      const sent = await pingChosen({
        session, round: Number(value('--reroll') || 0),
        chosenId: chosenIdx !== -1 ? args[chosenIdx + 1] : undefined,
        key: fromIdx !== -1 ? args[fromIdx + 1] : undefined,
        scope: scopeIdx !== -1 ? args[scopeIdx + 1] : undefined,
        mode: modeIdx !== -1 ? args[modeIdx + 1] : undefined,
        kind: kindIdx !== -1 ? args[kindIdx + 1] : undefined,
        register: registerIdx !== -1 ? args[registerIdx + 1] : undefined,
      });
      process.stdout.write(sent ? 'choice recorded\n' : 'choice ping skipped\n');
      // The choice is resolved; this is the last script output the model
      // reads before it decides what to do next, and every run that skipped
      // the comp round did so right here: prose 20 KB into new-work.md lost
      // to "direction locked, building now". So the ping prints the next
      // mandatory step from the recorded build path, and the phase machine
      // takes it from there.
      const savedChoice = session ? await callRetrieval({ op: 'replay', session, round: Number(value('--reroll') || 0), register: value('--register') || null }) : null;
      process.stdout.write(nextStepAfterChoice({
        key: savedChoice?.settings.key ?? (fromIdx !== -1 ? args[fromIdx + 1] : undefined),
        scope: savedChoice?.settings.scope ?? (scopeIdx !== -1 ? args[scopeIdx + 1] : undefined),
      }));
    } else {
      // Mechanical init gate: prose alone does not keep a model from dealing
      // before init, and fresh repos produced exactly that skip (the model
      // rolled directions with no PRODUCT.md, so nothing grounded the fusion).
      // Choice recording above does not require product initialization.
      const { loadContext } = await import('./context.mjs');
      const ctx = loadContext(process.cwd());
      if (!ctx.hasProduct && !replay) {
        process.stdout.write([
          'NO_PRODUCT_MD: the dice stay in the cup until product truth exists.',
          'Complete the init ask round and write PRODUCT.md first (reference/init.md), then re-run this exact command.',
          'Challengers fuse their form with facts from PRODUCT.md; without it every direction is ungrounded.',
        ].join(' ') + '\n');
        process.exit(1);
      }
      // Mechanical seed-pause gate: prose alone did not keep a model from
      // rolling a direction before offering the seed questionnaire (a real
      // session read a stale reference file and dealt straight after init),
      // and a boolean flag did not either (the next session self-passed it
      // without asking). A direction roll invents the visual world, so on a
      // project with no DESIGN.md the user gets the choice first; a seed
      // DESIGN.md counts as present, so a post-questionnaire re-entry never
      // re-asks. The flag now carries the user's verbatim skip answer.
      const sessionInfo = session && !replay ? await callRetrieval({ op: 'replay', session, round: 0 }) : null;
      const effectiveScope = sessionInfo?.settings.scope || value('--scope');
      if (effectiveScope === 'direction' && !ctx.hasDesign && !seedDeclined && !replay) {
        process.stdout.write([
          'NO_DESIGN_MD: the dice stay in the cup until the user answers the seed question.',
          'First action: create a tracked todo "Ask user: document --seed or skip" with the harness todo tool and start no other todo until it is answered; with no todo tool, state this gate to the user in chat before anything else.',
          'Then ask one question: recommend `document --seed`, the guided interview (reference/document.md, seed mode), because a world built from the user\'s own choices beats one assigned to them; offer the skip in the same breath.',
          'User accepts: run document seed mode; its seed DESIGN.md reads as an established world, so no direction roll happens.',
          'User skips: re-run this exact command with --seed-declined="<their verbatim skip answer>" quoting the user\'s actual words from this conversation.',
          'The original build request is never a skip answer, a bare or empty flag refuses again, and a fabricated or paraphrased quote is a contract violation.',
        ].join(' ') + '\n');
        process.exit(1);
      }
      if (scopeIdx !== -1 && args[scopeIdx + 1] === 'direction' && !ctx.hasDesign && seedDeclinedByEnv && !(seedDeclinedAnswer && seedDeclinedAnswer.trim())) {
        // Auditable trace for the unattended escape; stderr keeps the seed
        // output clean for the agent.
        process.stderr.write('seed pause bypassed via IMPECCABLE_SEED_DECLINED (unattended harness escape)\n');
      }
      let retrieved = null;
      if (retrievalConfig() || session || replay || value('--brief-file')) {
        const request = { op: replay ? 'replay' : session ? 'round' : 'start', session,
          round: Number(value('--reroll') || 0), register: value('--register') || null };
        const provided = Object.fromEntries(Object.entries({ key: value('--from'), scope: value('--scope'), mode: value('--mode'), grain: value('--grain'), platform: value('--platform'), candidateCount: value('--candidate-count') === undefined ? undefined : Number(value('--candidate-count')) }).filter(([,v]) => v !== undefined));
        if (!session) {
          if (!value('--brief-file')) throw new Error('Local retrieval requires --brief-file <task brief> for the first round');
          request.brief = readFileSync(resolve(value('--brief-file')), 'utf8');
          request.settings = { ...provided, key: provided.key || process.env.IMPECCABLE_CONCEPT_SEED || crypto.randomBytes(4).toString('hex') };
        } else {
          if (value('--brief-file')) throw new Error('A session brief is fixed; omit --session to start with a new brief');
          request.settings = provided;
        }
        retrieved = materializeRound(await callRetrieval(request));
      }
      const output = await renderConceptSeed({

        _resolvedData: retrieved ? { ...retrieved, ...retrieved.record } : undefined,
        scope: retrieved?.settings.scope ?? (scopeIdx !== -1 ? args[scopeIdx + 1] : 'surface'),
        key: retrieved?.settings.key ?? (fromIdx !== -1
          ? args[fromIdx + 1]
          : (process.env.IMPECCABLE_CONCEPT_SEED || crypto.randomBytes(4).toString('hex'))),
        reroll: rerollIdx !== -1 ? Number(args[rerollIdx + 1]) : 0,
        register: registerIdx !== -1 ? args[registerIdx + 1] : null,
        mode: retrieved?.settings.mode ?? (modeIdx !== -1 ? args[modeIdx + 1] : null),
        grain: retrieved?.settings.grain ?? (grainIdx !== -1 ? args[grainIdx + 1] : null),
        platform: retrieved?.settings.platform ?? (platformIdx !== -1 ? args[platformIdx + 1] : null),
        candidateCount: retrieved?.settings.candidateCount ?? (candidateCountIdx !== -1 ? Number(args[candidateCountIdx + 1]) : 7),
      });
      // A dealt roll leaves a marker the build phase clears: context.mjs and
      // detect.mjs read it and refuse to treat page work as done while a
      // direction is chosen but the build never started (COMP_ROUND_OPEN).
      // Written only after every gate above has passed (or been bypassed):
      // writing it earlier left a phantom marker behind a NO_PRODUCT_MD or
      // NO_DESIGN_MD refusal, which never dealt anything, so a later
      // context.mjs/detect.mjs run reported COMP_ROUND_OPEN for a roll that
      // never happened.
      try {
        const { mkdirSync, writeFileSync: wf } = await import('node:fs');
        if (!replay && (retrieved?.settings.scope || value('--scope')) === 'direction') {
          mkdirSync(resolve(process.cwd(), '.impeccable', 'build'), { recursive: true });
          wf(resolve(process.cwd(), '.impeccable', 'build', 'pending.json'), JSON.stringify({ scope: 'direction', at: new Date().toISOString() }, null, 2));
        }
      } catch { /* marker is best-effort */ }
      if (retrieved) process.stdout.write(`RETRIEVAL SESSION: ${retrieved.session}; round ${retrieved.round}; catalog ${retrieved.poolRevision}\nRERUN: --session ${retrieved.session} --reroll ${retrieved.round} --replay\n${retrieved.reusedIds.length ? `POOL EXHAUSTION: reused ${retrieved.reusedIds.join(', ')}\n` : ''}`);
      process.stdout.write(output);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  // A raced-out fetch may still hold a socket; exit explicitly so the CLI
  // never lingers on a dead network path after output is written.
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (dispatcher && typeof dispatcher.destroy === 'function') {
    try { await dispatcher.destroy(); } catch { /* exit regardless */ }
  }
  process.exit(process.exitCode ?? 0);
}
