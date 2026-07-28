import OpenAI from 'openai';
import type { ProviderAttachment } from './media.js';
import { toOpenAiMessages } from './openai-chat.js';
import type { ProviderMessage, ProviderToolDefinition } from './types.js';

/**
 * How to shrink accumulated tool history when the running prompt approaches
 * the model context window.
 * - `truncate`              : progressively cut oldest tool results only.
 * - `summarize`             : replace the oldest assistant/tool block with one
 *                             LLM-generated summary.
 * - `truncate-then-summarize`: truncate first; summarize only if still over.
 */
export type ContextOverflowStrategy =
  | 'truncate'
  | 'summarize'
  | 'truncate-then-summarize';

export interface OpenAiToolContextOptions {
  /** Total token budget of the model context window (e.g. 262144). */
  contextWindow: number;
  /** Tokens kept free for the model's answer. Default 8192. */
  reserveOutputTokens?: number;
  /** Max chars kept per tool result when first appended. Default 8000. */
  maxToolResultChars?: number;
  /** Safety cap on tool-call rounds. Default 8. */
  maxIterations?: number;
  /** History-shrink policy when near the window. Default 'truncate-then-summarize'. */
  overflow?: ContextOverflowStrategy;
  /** Rough token estimator over a string. Default ~ceil(len / 4). */
  estimateTokens?: (text: string) => number;
}

export interface OpenAiToolLoopOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  systemInstruction?: string;
  messages: ProviderMessage[];
  attachments?: readonly ProviderAttachment[];
  tools: ProviderToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  context: OpenAiToolContextOptions;
}

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.ChatCompletionTool;

const DEFAULT_RESERVE_OUTPUT_TOKENS = 8192;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 8000;
const DEFAULT_MAX_ITERATIONS = 8;
/** Do not truncate a single tool result below this many chars. */
const TRUNCATE_FLOOR_CHARS = 500;
/** Messages kept verbatim at the tail during summarization. */
const SUMMARIZE_KEEP_RECENT = 6;
const TRUNCATION_MARKER = '\n…[truncated]';

/**
 * Approximate token count shared with harness ContextBuilder defaults
 * (~ceil(chars / 4)). Inject a better estimator when available.
 */
export function estimateTokensApprox(text: string): number {
  return Math.ceil(text.length / 4);
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result ?? null);
  } catch {
    return String(result);
  }
}

function capChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return text.slice(0, head) + TRUNCATION_MARKER;
}

function toolsToOpenAi(tools: ProviderToolDefinition[]): ChatTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: (tool.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
    },
  }));
}

/** Approximate token weight of one chat message (content + tool-call args). */
function messageText(message: ChatMessage): string {
  const parts: string[] = [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && 'text' in part) {
        parts.push(String((part as { text?: unknown }).text ?? ''));
      }
    }
  }
  const toolCalls = (message as { tool_calls?: unknown[] }).tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const args = (call as { function?: { arguments?: string } })?.function
        ?.arguments;
      if (typeof args === 'string') parts.push(args);
    }
  }
  return parts.join(' ');
}

function estimateMessagesTokens(
  messages: ChatMessage[],
  estimate: (text: string) => number,
): number {
  let total = 0;
  for (const message of messages) total += estimate(messageText(message)) + 4;
  return total;
}

/**
 * Progressively cut the oldest tool results down to a floor until the running
 * prompt fits the budget. Only mutates `role:'tool'` content, so the required
 * assistant(tool_calls) → tool(result) pairing stays intact.
 */
function compactByTruncation(
  messages: ChatMessage[],
  budget: number,
  estimate: (text: string) => number,
): boolean {
  if (estimateMessagesTokens(messages, estimate) <= budget) return true;
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    if (
      typeof message.content === 'string' &&
      message.content.length > TRUNCATE_FLOOR_CHARS
    ) {
      message.content = capChars(message.content, TRUNCATE_FLOOR_CHARS);
      if (estimateMessagesTokens(messages, estimate) <= budget) return true;
    }
  }
  return estimateMessagesTokens(messages, estimate) <= budget;
}

/**
 * Replace the oldest contiguous assistant/tool block with a single
 * LLM-generated summary. Block boundaries land on assistant messages so no
 * tool result is ever orphaned from its assistant(tool_calls) turn.
 */
async function compactBySummary(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  budget: number,
  estimate: (text: string) => number,
  abortSignal?: AbortSignal,
): Promise<ChatMessage[]> {
  if (estimateMessagesTokens(messages, estimate) <= budget) return messages;

  const firstAssistant = messages.findIndex((m) => m.role === 'assistant');
  if (firstAssistant < 0) return messages;

  // Keep the tail verbatim, but never start the tail on a `tool` message
  // (that would strand it from its assistant turn).
  let suffixStart = Math.max(
    firstAssistant + 1,
    messages.length - SUMMARIZE_KEEP_RECENT,
  );
  while (suffixStart > firstAssistant && messages[suffixStart]?.role === 'tool') {
    suffixStart -= 1;
  }

  const block = messages.slice(firstAssistant, suffixStart);
  if (block.length === 0) return messages;

  const transcript = block
    .map((m) => `[${m.role}] ${capChars(messageText(m), 4000)}`)
    .join('\n');

  let summary = '';
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'system',
            content:
              'Compress the following earlier tool-call transcript into dense notes. ' +
              'Preserve every concrete finding, number, name, and source URL. ' +
              'Drop only chatter and duplication. Output notes only.',
          },
          { role: 'user', content: transcript },
        ],
        max_tokens: 1500,
        temperature: 0,
      },
      { signal: abortSignal },
    );
    summary = completion.choices[0]?.message?.content?.trim() ?? '';
  } catch {
    // Summary call failed (e.g. offline): fall back to hard truncation.
    summary = capChars(transcript, 4000);
  }

  const summaryMessage: ChatMessage = {
    role: 'assistant',
    content: `Summary of earlier tool results (older context compacted):\n${summary}`,
  };

  return [
    ...messages.slice(0, firstAssistant),
    summaryMessage,
    ...messages.slice(suffixStart),
  ];
}

async function ensureWithinBudget(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  budget: number,
  estimate: (text: string) => number,
  overflow: ContextOverflowStrategy,
  abortSignal?: AbortSignal,
): Promise<ChatMessage[]> {
  let current = messages;
  if (overflow === 'truncate' || overflow === 'truncate-then-summarize') {
    compactByTruncation(current, budget, estimate);
  }
  const stillOver = estimateMessagesTokens(current, estimate) > budget;
  if (
    stillOver &&
    (overflow === 'summarize' || overflow === 'truncate-then-summarize')
  ) {
    current = await compactBySummary(
      client,
      model,
      current,
      budget,
      estimate,
      abortSignal,
    );
  }
  return current;
}

/**
 * OpenAI-compatible Chat Completions tool loop.
 *
 * Runs the model, executes any returned `tool_calls` via the provided
 * {@link ProviderToolDefinition}s, appends their results, and repeats until the
 * model answers with plain text (or `maxIterations` is reached). Between rounds
 * it keeps the running prompt inside `contextWindow - reserveOutputTokens`
 * using the configured overflow strategy.
 */
export async function openAiChatWithTools(
  options: OpenAiToolLoopOptions,
): Promise<{ text: string; model?: string }> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  const ctx = options.context;
  const reserve = ctx.reserveOutputTokens ?? DEFAULT_RESERVE_OUTPUT_TOKENS;
  const maxToolResultChars =
    ctx.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const maxIterations = ctx.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const overflow = ctx.overflow ?? 'truncate-then-summarize';
  const estimate = ctx.estimateTokens ?? estimateTokensApprox;
  const budget = Math.max(1024, ctx.contextWindow - reserve);

  let messages: ChatMessage[] = toOpenAiMessages(
    options.systemInstruction,
    options.messages,
    options.attachments ?? [],
  );
  const openAiTools = toolsToOpenAi(options.tools);
  const toolByName = new Map(options.tools.map((t) => [t.name, t]));

  let lastModel: string | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    messages = await ensureWithinBudget(
      client,
      options.model,
      messages,
      budget,
      estimate,
      overflow,
      options.abortSignal,
    );

    const completion = await client.chat.completions.create(
      {
        model: options.model,
        messages,
        tools: openAiTools,
        tool_choice: 'auto',
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      },
      { signal: options.abortSignal },
    );
    lastModel = completion.model ?? lastModel;

    const choice = completion.choices[0]?.message;
    if (!choice) {
      return { text: '', model: lastModel };
    }

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { text: choice.content?.trim() ?? '', model: lastModel };
    }

    // Preserve the assistant turn (carries the tool_calls) before results.
    messages.push(choice as ChatMessage);

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const tool = toolByName.get(call.function.name);
      let content: string;
      if (!tool) {
        content = `Error: unknown tool "${call.function.name}".`;
      } else {
        try {
          const args = call.function.arguments
            ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
            : {};
          const result = await tool.execute(args);
          content = capChars(stringifyToolResult(result), maxToolResultChars);
        } catch (err) {
          content = `Error executing tool "${call.function.name}": ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  // Iterations exhausted — force a final text answer without more tool calls.
  messages = await ensureWithinBudget(
    client,
    options.model,
    messages,
    budget,
    estimate,
    overflow,
    options.abortSignal,
  );
  const final = await client.chat.completions.create(
    {
      model: options.model,
      messages,
      tools: openAiTools,
      tool_choice: 'none',
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    },
    { signal: options.abortSignal },
  );
  return {
    text: final.choices[0]?.message?.content?.trim() ?? '',
    model: final.model ?? lastModel,
  };
}
