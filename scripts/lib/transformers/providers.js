/**
 * Provider configurations for the transformer factory.
 *
 * Each config specifies:
 * - provider: key into PROVIDER_PLACEHOLDERS (e.g. 'claude-code')
 * - configDir: dot-directory name (e.g. '.claude')
 * - displayName: human-readable name for log output (e.g. 'Claude Code')
 * - providerTags: markdown block tags kept for this target (e.g. <codex>...</codex>)
 * - frontmatterFields: which optional fields to emit beyond name + description
 * - bodyTransform: optional function (body, skill) => transformed body
 */
export const PROVIDERS = {
  'claude-code': {
    provider: 'claude-code',
    providerTags: ['claude-code', 'claude'],
    configDir: '.claude',
    displayName: 'Claude Code',
    frontmatterFields: ['user-invocable', 'argument-hint', 'license', 'compatibility', 'metadata', 'allowed-tools'],
    agentFormat: 'claude-md',
    emitHooks: 'claude',
    // Project-local Claude Code hooks live in `.claude/settings.json`.
    hooksManifestRel: 'settings.json',
  },
  gemini: {
    provider: 'gemini',
    providerTags: ['gemini'],
    configDir: '.gemini',
    displayName: 'Gemini',
    frontmatterFields: [],
  },
  codex: {
    provider: 'codex',
    providerTags: ['codex'],
    configDir: '.codex',
    displayName: 'Codex',
    frontmatterFields: [],
    writeOpenAIMetadata: true,
    // No agentFormat: the Codex subagent ships nested inside the skill's own
    // agents/ folder (see CODEX_SKILL_PROVIDERS in factory.js), which Codex
    // auto-discovers on install. No top-level .codex/agents/ sidecar is emitted.
    emitHooks: 'codex',
    // Codex discovers project-local hooks at `.codex/hooks.json`.
    hooksManifestRel: 'hooks.json',
  },
  agents: {
    provider: 'agents',
    providerTags: ['agents', 'codex'],
    configDir: '.agents',
    displayName: 'Codex Repo Skills',
    placeholderProvider: 'codex',
    frontmatterFields: [],
    writeOpenAIMetadata: true,
  },
  github: {
    provider: 'github',
    providerTags: ['github'],
    configDir: '.github',
    displayName: 'GitHub Copilot',
    placeholderProvider: 'agents',
    frontmatterFields: ['user-invocable', 'argument-hint', 'license', 'compatibility', 'metadata'],
    // Copilot custom agents: `.github/agents/<name>.agent.md` at repo level,
    // `~/.copilot/agents/` at user level (the CLI installer handles placement).
    // The degraded/ fallbacks still ship for Copilot surfaces where the model
    // fails to delegate; the .agent.md files are the real subagent path.
    agentFormat: 'copilot-agent-md',
    emitHooks: 'github',
    // GitHub Copilot discovers repo-level hooks under `.github/hooks/*.json`.
    hooksManifestRel: 'hooks/impeccable.json',
  },
  kiro: {
    provider: 'kiro',
    providerTags: ['kiro'],
    configDir: '.kiro',
    displayName: 'Kiro',
    frontmatterFields: ['license', 'compatibility', 'metadata'],
  },
  opencode: {
    provider: 'opencode',
    providerTags: ['opencode'],
    configDir: '.opencode',
    displayName: 'OpenCode',
    frontmatterFields: ['user-invocable', 'argument-hint', 'license', 'compatibility', 'metadata', 'allowed-tools'],
  },
  pi: {
    provider: 'pi',
    providerTags: ['pi'],
    configDir: '.pi',
    displayName: 'Pi',
    frontmatterFields: ['license', 'compatibility', 'metadata', 'allowed-tools'],
  },
  vibe: {
    provider: 'vibe',
    providerTags: ['vibe'],
    configDir: '.vibe',
    displayName: 'Mistral Vibe',
    frontmatterFields: ['user-invocable', 'license', 'compatibility', 'metadata', 'allowed-tools'],
  },
  antigravity: {
    provider: 'antigravity',
    providerTags: ['antigravity'],
    configDir: '.agent',
    displayName: 'Antigravity',
    frontmatterFields: ['license', 'compatibility', 'metadata', 'allowed-tools'],
  },
  omp: {
    provider: 'omp',
    providerTags: ['omp'],
    configDir: '.omp',
    displayName: 'oh-my-pi',
    frontmatterFields: ['license', 'compatibility', 'metadata', 'allowed-tools'],
    emitHooks: 'omp',
    hooksManifestRel: 'hooks/post/impeccable.js',
  }
};
