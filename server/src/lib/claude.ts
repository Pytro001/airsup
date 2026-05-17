import { getOpenAIClient } from "../services/openai.js";

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
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model,
    max_tokens: 2048,
    messages: [
      { role: "system", content: system },
      ...messages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    ],
  });

  const text = response.choices[0]?.message?.content ?? "";

  if (!expectJSON) return text;

  const cleaned = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { raw: text };
  }
}
