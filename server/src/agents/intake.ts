import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";

const SYSTEM_PROMPT = `You are Airsup — an expert manufacturing sourcing agent.

Your mission: deeply understand the user's business, company, and projects so you can connect them directly with the right designer or engineer at a factory — not a sales person. You are friendly, concise, and professional.

## Core philosophy
Airsup eliminates the sales middleman. When we match a buyer with a factory, we connect them directly to the actual designer, engineer, or technical person who will work on their product. The AI provides all the context and briefing that a sales person would — so the designer/engineer can start working immediately. This means faster iteration cycles, lower costs, and shorter time to first prototype or drawing.

## How you work
1. LEARN — Ask about their company, what they make, what they need manufactured, quantities, timelines, budgets, quality standards, design files they have, and how far along the product vision is. Be conversational, not interrogatory. Ask one or two questions at a time.
2. REMEMBER — Use your tools to save everything you learn. Company info, project details, requirements. This knowledge persists forever so you never ask the same thing twice.
3. ACT — Once you understand a project well enough, tell the user you'll start searching for factories. Use search_factories to kick off the process. Emphasize that you'll find them a direct line to the actual person working on their product.
4. UPDATE — Keep the user informed about progress. When you find matches, present them clearly with quotes, timelines, iteration process, and what the first deliverable will be (e.g. initial drawing, CAD model, sample).

## Guided conversation flow
- Use suggest_options to offer 2-4 clickable choices when you ask a question. Make options specific to the user's context (industry, product type). This makes the conversation faster.
- After gathering enough details (product, quantity, timeline), create the project with save_project, start the search with search_factories, and explain what happens next.
- When you kick off a factory search, use suggest_action with action "navigate" and target "connections" to give the user a button to check their connections.
- Explain the process clearly: "I'll handle all communication with factories, negotiate terms, and when there's a match, they'll appear in your Connections where you can chat directly with the engineer."

## Key value props to emphasize naturally
- "You'll work directly with the engineer/designer — no sales people in between"
- Fast iteration cycles — the goal is getting a first design, drawing, or sample back quickly
- Free or low-cost iteration rounds to nail the product vision before committing
- The AI briefs the factory's technical team with full context so nothing gets lost in translation

## Personality
- Direct and efficient — respect the user's time
- Knowledgeable about manufacturing, supply chains, China sourcing
- Honest about what you can and can't do
- Never make up factory information or fake quotes

## Rules
- Always save company/project info as soon as the user shares it (don't wait)
- If the user hasn't told you their company name yet, ask early — it's essential context
- When a user describes what they want manufactured, create a project immediately
- After learning significant new details about a project, update its summary using update_project_summary
- Use update_knowledge for preferences and facts that don't fit company/project fields
- Format prices, quantities, and timelines clearly
- Use markdown formatting sparingly — keep responses chat-friendly
- When you already know something about the user from the context below, don't ask again — reference it naturally
- If you have projects from previous sessions, ask for updates rather than starting fresh
- Ask about their design readiness (CAD files, sketches, reference images) — this helps the factory engineer start faster
- IMPORTANT: Use suggest_options frequently to make the conversation interactive. Every question should ideally have clickable options.`;

const INIT_PROMPT = `The user just completed onboarding and this is their first time in the chat. You already know some details about them from onboarding (see context below). 

Send a warm, personalized greeting that:
1. References their company name and what they told you during onboarding
2. Asks a specific follow-up question to clarify their manufacturing needs
3. Uses suggest_options to give them 2-3 clickable choices relevant to their situation

Keep it concise — 2-3 sentences max before the question. Don't repeat everything they told you, just acknowledge it naturally.`;

const TOOLS: Tool[] = [
  {
    name: "save_company_info",
    description:
      "Save or update the user's company information. Call this whenever the user shares details about their business.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Company name" },
        industry: { type: "string", description: "Industry or sector" },
        description: { type: "string", description: "What the company does" },
        size: { type: "string", description: "Company size (employees, revenue range, stage)" },
        location: { type: "string", description: "Where the company is based" },
        website: { type: "string", description: "Company website" },
      },
      required: ["name"],
    },
  },
  {
    name: "save_project",
    description:
      "Create or update a sourcing project. Call this when the user describes something they want manufactured.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short project title" },
        description: { type: "string", description: "What needs to be manufactured" },
        quantity: { type: "string", description: "Desired quantity / MOQ" },
        budget: { type: "string", description: "Budget range or target unit price" },
        timeline: { type: "string", description: "When they need it by" },
        quality_requirements: { type: "string", description: "Quality standards, certifications needed" },
        materials: { type: "string", description: "Materials or specifications" },
        additional_notes: { type: "string", description: "Any other requirements" },
      },
      required: ["title", "description"],
    },
  },
  {
    name: "update_knowledge",
    description:
      "Store a specific fact about the user or their business for long-term memory.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Short label for the fact" },
        value: { type: "string", description: "The information to remember" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "search_factories",
    description:
      "Start searching for matching factories for a project. Only call this when you have enough info about the project (at minimum: what to manufacture and rough quantity).",
    input_schema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string", description: "The project UUID to search for" },
        criteria: {
          type: "object",
          description: "Search criteria",
          properties: {
            category: { type: "string" },
            location_preference: { type: "string" },
            min_quantity: { type: "string" },
            certifications: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "get_project_status",
    description: "Get the current status of a project including any matches found.",
    input_schema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string", description: "The project UUID" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "update_project_summary",
    description:
      "Update the AI-generated summary for a project after learning significant new details.",
    input_schema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string", description: "The project UUID" },
        summary: {
          type: "object",
          description: "Structured summary of what's known about this project",
          properties: {
            product: { type: "string", description: "What's being manufactured" },
            quantity: { type: "string" },
            budget: { type: "string" },
            timeline: { type: "string" },
            key_requirements: { type: "array", items: { type: "string" } },
            ideal_factory_profile: { type: "string", description: "What kind of factory would be ideal" },
            readiness: { type: "string", description: "How ready is this project for factory search (low/medium/high)" },
          },
        },
      },
      required: ["project_id", "summary"],
    },
  },
  {
    name: "suggest_options",
    description:
      "Present clickable quick-reply options to the user. Use this when asking a question to make the conversation faster. Options should be specific to the user's context. The user will click one and it becomes their response.",
    input_schema: {
      type: "object" as const,
      properties: {
        options: {
          type: "array",
          description: "2-4 options for the user to choose from",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short label shown on the button" },
              value: { type: "string", description: "The full text sent as the user's message when clicked" },
            },
            required: ["label", "value"],
          },
        },
      },
      required: ["options"],
    },
  },
  {
    name: "suggest_action",
    description:
      "Show an action button to the user (e.g. navigate to a page). Use after kicking off a factory search to direct the user to Connections.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: "Action type: 'navigate'" },
        target: { type: "string", description: "Navigation target: 'connections', 'projects'" },
        label: { type: "string", description: "Button label shown to the user" },
      },
      required: ["action", "target", "label"],
    },
  },
];

interface AgentResult {
  reply: string;
  messages: MessageParam[];
  options?: Array<{ label: string; value: string }>;
  action?: { action: string; target: string; label: string };
}

async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  userId: string
): Promise<string> {
  switch (toolName) {
    case "save_company_info": {
      const { name, industry, description, size, location, website } = toolInput as Record<string, string>;
      const { data: existing } = await supabaseAdmin
        .from("companies")
        .select("id, ai_knowledge")
        .eq("user_id", userId)
        .maybeSingle();

      const knowledge: Record<string, string> = existing?.ai_knowledge || {};
      if (size) knowledge.size = size;
      if (website) knowledge.website = website;

      if (existing) {
        const updates: Record<string, unknown> = { ai_knowledge: knowledge };
        if (name) updates.name = name;
        if (industry) updates.industry = industry;
        if (description) updates.description = description;
        if (location) updates.location = location;
        await supabaseAdmin.from("companies").update(updates).eq("id", existing.id);
        return `Updated company "${name || "your company"}" info.`;
      } else {
        const { data } = await supabaseAdmin
          .from("companies")
          .insert({ user_id: userId, name: name || "Unknown", industry: industry || "", description: description || "", location: location || "", ai_knowledge: knowledge })
          .select("id")
          .single();
        return `Saved new company "${name}" (id: ${data?.id}).`;
      }
    }

    case "save_project": {
      const { title, description, quantity, budget, timeline, quality_requirements, materials, additional_notes } =
        toolInput as Record<string, string>;
      const { data: company } = await supabaseAdmin.from("companies").select("id").eq("user_id", userId).maybeSingle();
      const requirements: Record<string, string> = {};
      if (quantity) requirements.quantity = quantity;
      if (budget) requirements.budget = budget;
      if (timeline) requirements.timeline = timeline;
      if (quality_requirements) requirements.quality_requirements = quality_requirements;
      if (materials) requirements.materials = materials;
      if (additional_notes) requirements.additional_notes = additional_notes;

      const { data } = await supabaseAdmin
        .from("projects")
        .insert({ user_id: userId, company_id: company?.id || null, title, description: description || "", requirements, status: "intake" })
        .select("id")
        .single();
      return `Created project "${title}" (id: ${data?.id}).`;
    }

    case "update_knowledge": {
      const { key, value } = toolInput as { key: string; value: string };
      const { data: company } = await supabaseAdmin.from("companies").select("id, ai_knowledge").eq("user_id", userId).maybeSingle();
      if (company) {
        const knowledge = { ...(company.ai_knowledge || {}), [key]: value };
        await supabaseAdmin.from("companies").update({ ai_knowledge: knowledge }).eq("id", company.id);
      } else {
        await supabaseAdmin.from("companies").insert({ user_id: userId, name: "Unknown", ai_knowledge: { [key]: value } });
      }
      return `Remembered: ${key} = ${value}`;
    }

    case "search_factories": {
      const { project_id, criteria } = toolInput as { project_id: string; criteria?: Record<string, unknown> };
      const { data: search } = await supabaseAdmin
        .from("factory_searches")
        .insert({ project_id, search_criteria: criteria || {}, status: "pending" })
        .select("id")
        .single();
      await supabaseAdmin.from("projects").update({ status: "searching" }).eq("id", project_id);
      return `Factory search started (search id: ${search?.id}). The background worker will find and negotiate with matching factories.`;
    }

    case "get_project_status": {
      const { project_id } = toolInput as { project_id: string };
      const { data: project } = await supabaseAdmin.from("projects").select("title, status, requirements, ai_summary").eq("id", project_id).single();
      if (!project) return "Project not found.";
      const { data: matches } = await supabaseAdmin.from("matches").select("id, status, quote, context_summary, factories(name, location)").eq("project_id", project_id);
      return JSON.stringify({ project, matches: matches || [] });
    }

    case "update_project_summary": {
      const { project_id, summary } = toolInput as { project_id: string; summary: Record<string, unknown> };
      await supabaseAdmin.from("projects").update({ ai_summary: summary, updated_at: new Date().toISOString() }).eq("id", project_id);
      return `Project summary updated.`;
    }

    case "suggest_options":
      return "Options presented to user.";

    case "suggest_action":
      return "Action button presented to user.";

    default:
      return `Unknown tool: ${toolName}`;
  }
}

export async function loadContext(userId: string): Promise<string> {
  const parts: string[] = [];

  const { data: company } = await supabaseAdmin.from("companies").select("*").eq("user_id", userId).maybeSingle();
  if (company) {
    parts.push(`## Known company info\nName: ${company.name}\nIndustry: ${company.industry || "unknown"}\nDescription: ${company.description || "unknown"}\nLocation: ${company.location || "unknown"}`);
    if (company.ai_knowledge && Object.keys(company.ai_knowledge).length > 0) {
      parts.push("## Additional knowledge\n" + Object.entries(company.ai_knowledge).map(([k, v]) => `- ${k}: ${v}`).join("\n"));
    }
  }

  const { data: projects } = await supabaseAdmin
    .from("projects")
    .select("id, title, description, status, requirements, ai_summary")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (projects?.length) {
    parts.push(
      "## Active projects\n" +
        projects.map((p) =>
          `- **${p.title}** (${p.status}): ${p.description}${p.requirements ? "\n  Requirements: " + JSON.stringify(p.requirements) : ""}${p.ai_summary ? "\n  Summary: " + JSON.stringify(p.ai_summary) : ""}`
        ).join("\n")
    );
  }

  return parts.length ? "\n\n---\n\n# What you already know about this user\n\n" + parts.join("\n\n") : "";
}

export async function runIntakeAgent(
  userId: string,
  userMessage: string,
  conversationHistory: MessageParam[],
  extraSystemInstruction?: string
): Promise<AgentResult> {
  const anthropic = getAnthropicClient();
  const context = await loadContext(userId);
  let systemPrompt = SYSTEM_PROMPT + context;
  if (extraSystemInstruction) systemPrompt += "\n\n" + extraSystemInstruction;

  const messages: MessageParam[] = [
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  let currentMessages = [...messages];
  let collectedOptions: Array<{ label: string; value: string }> | undefined;
  let collectedAction: { action: string; target: string; label: string } | undefined;

  for (let i = 0; i < 5; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages: currentMessages,
    });

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const textBlocks = response.content.filter((b) => b.type === "text");

    for (const block of toolUseBlocks) {
      if (block.type === "tool_use") {
        if (block.name === "suggest_options") {
          const input = block.input as { options: Array<{ label: string; value: string }> };
          collectedOptions = input.options;
        } else if (block.name === "suggest_action") {
          collectedAction = block.input as { action: string; target: string; label: string };
        }
      }
    }

    if (toolUseBlocks.length === 0) {
      const reply = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n\n");
      currentMessages.push({ role: "assistant", content: response.content });
      return { reply, messages: currentMessages, options: collectedOptions, action: collectedAction };
    }

    currentMessages.push({ role: "assistant", content: response.content });

    const toolResults: ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.type === "tool_use") {
        const result = await handleToolCall(block.name, block.input as Record<string, unknown>, userId);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }
    currentMessages.push({ role: "user", content: toolResults });

    if (response.stop_reason === "end_turn") {
      const reply = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n\n");
      return { reply, messages: currentMessages, options: collectedOptions, action: collectedAction };
    }
  }

  return { reply: "I'm processing that — give me a moment.", messages: currentMessages };
}

export const INIT_SYSTEM_INSTRUCTION = INIT_PROMPT;
