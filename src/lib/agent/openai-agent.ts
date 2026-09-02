import { ALL_TOOLS, callTool } from '../tools';
import { keyFor } from './key-vault';
import { AGENT_SYSTEM_PROMPT, MAX_TURNS } from './prompt';
import { providerById, type ModelConnection } from './providers';
import type { Agent, AgentRun } from './types';

/**
 * An agent loop for every OpenAI-compatible provider.
 *
 * One adapter covers OpenAI, OpenRouter, Google, Groq, Mistral, Together and
 * DeepSeek, because they all speak the same chat-completions shape. The only
 * differences are the base URL and the model id, which live in the provider
 * registry rather than here.
 *
 * The approval gate is enforced in this loop, exactly as it is in the Anthropic
 * one: when a tool returns `confirmation_required`, the generator suspends and
 * asks the user. The model never sees a confirmation token and cannot redeem
 * one. That property has to hold per adapter, so it is implemented per adapter
 * rather than trusted to a shared convention.
 */

const REQUEST_TIMEOUT_MS = 120_000;

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatResponse {
  choices?: { message?: ChatMessage; finish_reason?: string }[];
  error?: { message?: string };
}

/** Anthropic-shaped tool definitions translated to the OpenAI function shape. */
function toOpenAITools() {
  return ALL_TOOLS.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Arguments arrive as a JSON *string*, and a model can produce a malformed one.
 * Parsing must not throw into the loop — a bad call should be reported back to
 * the model as a tool error so it can correct itself.
 */
function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: raw.trim() === '' ? {} : JSON.parse(raw) };
  } catch {
    return { ok: false, error: 'Arguments were not valid JSON. Send the tool call again.' };
  }
}

export function createOpenAIAgent(connection: ModelConnection): Agent {
  const provider = providerById(connection.provider);

  return {
    id: connection.id,
    label: `${provider.label} · ${connection.model}`,
    blurb: `A real agent loop against ${provider.label}, using your own key.`,
    needsKey: true,

    async *run(datasetId: string): AgentRun {
      // Read at the last possible moment, and never held beyond this call.
      const apiKey = keyFor(connection.id);

      const messages: ChatMessage[] = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Please review and clean the dataset with id "${datasetId}". ` +
            `Scan it, tell me what you find, and propose fixes one at a time.`,
        },
      ];

      async function complete(): Promise<ChatResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(`${provider.baseUrl}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: connection.model,
              messages,
              tools: toOpenAITools(),
              tool_choice: 'auto',
            }),
          });

          if (!response.ok) {
            let detail = '';
            try {
              const body = (await response.json()) as ChatResponse;
              detail = body.error?.message ?? '';
            } catch {
              detail = '';
            }
            if (response.status === 401) {
              throw new Error(`${provider.label} rejected that key.`);
            }
            if (response.status === 404) {
              throw new Error(
                `${provider.label} does not have a model called "${connection.model}".`,
              );
            }
            if (response.status === 429) {
              throw new Error(`${provider.label} is rate limiting this key. Wait and retry.`);
            }
            throw new Error(
              `${provider.label} returned ${response.status}${detail ? `: ${detail}` : ''}.`,
            );
          }

          return (await response.json()) as ChatResponse;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw new Error(`${provider.label} did not respond within two minutes.`);
          }
          // Deliberately not re-thrown with `cause`: a fetch failure carries the
          // request, and the request carries the Authorization header.
          if (error instanceof TypeError) {
            throw new Error(`Could not reach ${provider.label}. Check your connection.`);
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      }

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const response = await complete();
          const message = response.choices?.[0]?.message;

          if (!message) {
            yield { type: 'error', text: `${provider.label} returned an empty response.` };
            return;
          }

          if (typeof message.content === 'string' && message.content.trim()) {
            yield { type: 'say', text: message.content };
          }

          const calls = message.tool_calls ?? [];
          if (calls.length === 0) {
            yield { type: 'done', text: '' };
            return;
          }

          messages.push({
            role: 'assistant',
            content: message.content ?? '',
            tool_calls: calls,
          });

          for (const call of calls) {
            const parsed = parseArgs(call.function.arguments);
            if (!parsed.ok) {
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: parsed.error,
              });
              yield { type: 'result', name: call.function.name, summary: 'Malformed arguments.' };
              continue;
            }

            yield { type: 'tool', name: call.function.name, args: parsed.value };

            try {
              const raw = await callTool(call.function.name, parsed.value, 'model-agent');
              const result = raw as Record<string, unknown>;

              if (result?.['status'] === 'confirmation_required') {
                const approved = yield {
                  type: 'approve',
                  toolName: call.function.name,
                  summary: String(result['summary'] ?? 'Apply this change?'),
                  details: (result['details'] ?? {}) as Record<string, unknown>,
                };

                if (!approved) {
                  messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content:
                      'The user declined this change. Nothing was modified. ' +
                      'Do not retry it; move on or ask what they would prefer.',
                  });
                  yield {
                    type: 'result',
                    name: call.function.name,
                    summary: 'Declined by user.',
                  };
                  continue;
                }

                // Redeemed here. The token is never placed in a message, so it
                // never reaches the model.
                const applied = await callTool(
                  call.function.name,
                  {
                    ...(parsed.value as Record<string, unknown>),
                    confirmation_token: result['confirmation_token'],
                  },
                  'model-agent',
                );

                messages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  content: JSON.stringify(applied),
                });
                yield {
                  type: 'result',
                  name: call.function.name,
                  summary: 'Approved and applied.',
                };
                continue;
              }

              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result),
              });
              yield { type: 'result', name: call.function.name, summary: 'Done.' };
            } catch (error) {
              const text = error instanceof Error ? error.message : String(error);
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: `The tool failed: ${text}`,
              });
              yield { type: 'result', name: call.function.name, summary: `Failed: ${text}` };
            }
          }
        }

        yield {
          type: 'error',
          text: `Stopped after ${MAX_TURNS} turns without finishing.`,
        };
      } catch (error) {
        yield { type: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
