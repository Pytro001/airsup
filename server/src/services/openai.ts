import OpenAI from "openai";

let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  }
  return client;
}

// Model constants
export const MODEL_CHAT = "gpt-4.5";          // user-facing chat + WhatsApp
export const MODEL_HEAVY = "gpt-4o";          // negotiation, visit planning, complex reasoning
export const MODEL_FAST = "gpt-4o-mini";      // background tasks: matching, sourcing, cold outreach
