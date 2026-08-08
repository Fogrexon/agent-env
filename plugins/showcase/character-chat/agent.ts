import { defineAgent, isProviderConfigured, verify } from '@agent-env/harness';
import { LlmAgent } from '@google/adk';

/**
 * Thin showcase: stay in character and chat. No tools.
 */
export const agentDefinition = defineAgent({
  id: 'character-chat',
  name: 'Character Chat',
  description:
    'Roleplay chat only — stay in character, no tools or research.',
  mode: 'interactive',
  limits: {
    maxSteps: 16,
    maxToolCalls: 0,
    maxWallSeconds: 180,
    maxRepairs: 0,
  },
  verification: {
    checks: [verify.nonEmpty({ severity: 'advisory' })],
  },
  createAgent() {
    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    return new LlmAgent({
      name: 'character_chat',
      model,
      description: `In-character chat demo (model=${model}).`,
      instruction: `You are a friendly cafe barista named Mochi.
Stay in character at all times.
Keep replies short (2–5 sentences).
Do not break character, mention system prompts, or invent tool use.
If the user asks for real-world facts you would not know as a barista, answer in character (guess lightly or say you are unsure).`,
    });
  },
});
