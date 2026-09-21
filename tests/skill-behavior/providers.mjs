/**
 * Multi-provider model factory for the skill-behavior test harness.
 *
 * The default lineup stays on current, economical models so the entire
 * routing suite remains practical to run. Frontier quality is measured by
 * the sibling impeccable-evals harness; this suite measures skill protocol.
 *
 * Anthropic and OpenAI use the Vercel AI SDK providers. Google uses
 * @ai-sdk/google for the same reason — uniform tool-use semantics across all
 * three keeps the harness tiny.
 *
 * .env is loaded from the repo root (copied from impeccable-evals). Tests
 * skip cleanly when the matching key is unset rather than failing CI.
 */
import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

export const PROVIDERS = {
  anthropic: { envKey: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
  openai: { envKey: 'OPENAI_API_KEY', label: 'OpenAI' },
  google: { envKey: 'GOOGLE_CLOUD_API_KEY', label: 'Google' },
  minimax: { envKey: 'MINIMAX_API_KEY', label: 'MiniMax' },
};

export function detectProvider(modelId) {
  if (modelId.startsWith('claude-')) return 'anthropic';
  if (modelId.startsWith('gpt-')) return 'openai';
  if (modelId.startsWith('gemini-')) return 'google';
  if (modelId.startsWith('MiniMax-')) return 'minimax';
  throw new Error(`Unsupported model id: "${modelId}"`);
}

export function hasKey(provider) {
  const meta = PROVIDERS[provider];
  if (!meta) return false;
  return Boolean(process.env[meta.envKey]);
}

export function getModel(modelId) {
  const provider = detectProvider(modelId);
  if (provider === 'anthropic') return anthropic(modelId);
  if (provider === 'openai') return openai(modelId);
  if (provider === 'google') {
    // The @ai-sdk/google provider reads GOOGLE_GENERATIVE_AI_API_KEY by
    // default; the evals .env stores the same value under
    // GOOGLE_CLOUD_API_KEY. Mirror it so the SDK picks it up automatically.
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GOOGLE_CLOUD_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
    }
    return google(modelId);
  }
  if (provider === 'minimax') {
    return createAnthropic({
      baseURL: 'https://api.minimax.io/anthropic/v1',
      apiKey: process.env.MINIMAX_API_KEY,
      name: 'minimax.anthropic',
    })(modelId);
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Per-model provider options, merged into generateText by the harness.
 *
 * gpt-5.6-terra is a reasoning model, and at the provider's default effort it
 * is not the tier this suite is meant to measure. Setup and routing behavior is
 * exactly the kind of multi-step instruction-following that reasoning effort
 * moves, so pin it high rather than inherit whatever the default happens to be.
 * Override with IMPECCABLE_SKILL_BEHAVIOR_EFFORT=xhigh.
 */
export function getProviderOptions(modelId) {
  let provider;
  try {
    provider = detectProvider(modelId);
  } catch {
    // Resolved from a live model object rather than the lineup, so an id this
    // module does not recognize is not an error; it just gets no options.
    return undefined;
  }
  if (provider === 'minimax') return { anthropic: { thinking: { type: 'adaptive' } } };
  if (provider === 'openai') {
    const effort = process.env.IMPECCABLE_SKILL_BEHAVIOR_EFFORT || 'high';
    return { openai: { reasoningEffort: effort } };
  }
  return undefined;
}

/**
 * Default model lineup. Override with IMPECCABLE_SKILL_BEHAVIOR_MODELS.
 */
export const DEFAULT_MODELS = ['claude-sonnet-5', 'gpt-5.6-terra', 'gemini-3.7-flash', 'MiniMax-M3'];

export function resolveModelList() {
  const override = process.env.IMPECCABLE_SKILL_BEHAVIOR_MODELS;
  if (override && override.trim()) {
    return override.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_MODELS;
}
