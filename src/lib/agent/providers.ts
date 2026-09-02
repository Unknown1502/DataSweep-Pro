/**
 * Chat model providers.
 *
 * Every entry here was tested from a browser on this origin before being
 * listed. That matters more than it sounds: a provider without CORS fails with
 * an opaque `TypeError: Failed to fetch` that looks identical to being offline,
 * so offering one the browser cannot reach would be worse than not offering it
 * at all. Two needed their own auth shape to work and are configured for it:
 *
 *   - Anthropic requires `anthropic-dangerous-direct-browser-access: true`.
 *   - Google authenticates with `x-goog-api-key`, not a bearer token — but it
 *     also publishes an OpenAI-compatible endpoint, which is what is used here
 *     so one adapter covers it along with the rest.
 *
 * There is no free-form base-URL field. The destination of a request carrying
 * the user's key is not something to leave open, and an allow-list is the same
 * posture the rest of the application takes.
 */

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'together'
  | 'deepseek'
  | 'google';

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** 'anthropic' uses the Anthropic SDK; everything else is OpenAI-shaped. */
  readonly protocol: 'anthropic' | 'openai';
  readonly baseUrl: string;
  /** Where the user gets a key. Shown as a link, never opened automatically. */
  readonly keysUrl: string;
  /** Shape of the key, used to catch a paste into the wrong provider. */
  readonly keyPrefix?: string;
  readonly models: readonly string[];
  /** Anything the user should know before picking this one. */
  readonly note?: string;
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    models: ['gpt-5.1', 'gpt-5', 'gpt-5-mini', 'o4-mini'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keysUrl: 'https://openrouter.ai/keys',
    keyPrefix: 'sk-or-',
    models: [
      'anthropic/claude-opus-4.5',
      'openai/gpt-5.1',
      'google/gemini-2.5-pro',
      'meta-llama/llama-4-maverick',
    ],
    note: 'One key, many models. Model ids are namespaced by their vendor.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keysUrl: 'https://aistudio.google.com/apikey',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    note: 'Reached through Google’s OpenAI-compatible endpoint.',
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keysUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
    models: ['llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct'],
    note: 'Fast, but smaller models are less reliable at multi-step tool use.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keysUrl: 'https://console.mistral.ai/api-keys',
    models: ['mistral-large-latest', 'mistral-medium-latest'],
  },
  {
    id: 'together',
    label: 'Together',
    protocol: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    keysUrl: 'https://api.together.ai/settings/api-keys',
    models: [
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    keyPrefix: 'sk-',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
];

/**
 * Which provider a key most specifically looks like, if any.
 *
 * "Starts with the selected provider's prefix" is not enough: OpenAI's `sk-` is
 * itself a prefix of Anthropic's `sk-ant-`, so an Anthropic key pasted into the
 * OpenAI field passed that check and failed much later as a bare 401. Matching
 * the LONGEST prefix instead resolves that pair correctly.
 */
export function providerForKey(key: string): Provider | null {
  const trimmed = key.trim();
  let best: Provider | null = null;
  for (const provider of PROVIDERS) {
    if (!provider.keyPrefix || !trimmed.startsWith(provider.keyPrefix)) continue;
    if (!best || provider.keyPrefix.length > best.keyPrefix!.length) best = provider;
  }
  return best;
}

export function providerById(id: ProviderId): Provider {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown provider "${id}".`);
  return found;
}

/**
 * A model the user has configured. The key is deliberately NOT part of this —
 * it lives in the vault, so a connection can be listed, rendered and stored in
 * React state without the credential travelling with it.
 */
export interface ModelConnection {
  readonly id: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly addedAt: string;
}

export function connectionLabel(connection: ModelConnection): string {
  return `${providerById(connection.provider).label} · ${connection.model}`;
}
