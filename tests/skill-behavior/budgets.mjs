// A minute for startup/thinking, then 30 seconds per permitted model step.
// Full browser workflows supply their own longer timeout explicitly.
export function turnTimeoutMs(maxSteps, override = process.env.IMPECCABLE_SKILL_BEHAVIOR_TURN_TIMEOUT_MS) {
  const timeout = override === undefined ? 60_000 + 30_000 * maxSteps : Number(override);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Skill-behavior turn timeout must be a positive integer in milliseconds');
  return timeout;
}

// S20 permits 14 steps; S4 has two turns of up to 6 steps each. Leave time
// for the client abort diagnostic and fixture cleanup before Node cancels.
export const SCENARIO_TIMEOUT_MS = Math.max(turnTimeoutMs(14), 2 * turnTimeoutMs(6)) + 30_000;
