import { createTransformer } from './factory.js';
import { PROVIDERS } from './providers.js';

// Named exports exist primarily as stable spy targets for the test suite
// (build.test.js uses spyOn(transformers, 'transformGitHub') etc.). build.js
// itself uses createTransformer + PROVIDERS directly, not these.
export const transformClaudeCode = createTransformer(PROVIDERS['claude-code']);
export const transformGemini = createTransformer(PROVIDERS.gemini);
export const transformCodex = createTransformer(PROVIDERS.codex);
export const transformAgents = createTransformer(PROVIDERS.agents);
export const transformGitHub = createTransformer(PROVIDERS.github);
export const transformKiro = createTransformer(PROVIDERS.kiro);
export const transformOpenCode = createTransformer(PROVIDERS.opencode);
export const transformPi = createTransformer(PROVIDERS.pi);
export const transformVibe = createTransformer(PROVIDERS.vibe);
export const transformAntigravity = createTransformer(PROVIDERS.antigravity);
export const transformOmp = createTransformer(PROVIDERS.omp);
export const transformVeto = createTransformer(PROVIDERS.veto);

export { createTransformer, PROVIDERS };
