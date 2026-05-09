import { getAnthropicClient } from "../services/anthropic.js";

interface CallClaudeOptions {
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  expectJSON?: boolean;
}

export async function callClaude({
  model,
  system,
  messages,
  expectJSON = true,
}: CallClaudeOptions): Promise<any> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system,
    messages,
  });

  const text = response.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  if (!expectJSON) return text;

  const cleaned = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { raw: text };
  }
}
