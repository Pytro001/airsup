import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";

const SYSTEM_PROMPT = `You are Airsup — an expert manufacturing sourcing agent.

Your mission: deeply understand the user's business, company, and projects so you can find them the perfect factory partners. You are friendly, concise, and professional.

## How you work
1. LEARN — Ask about their company, what they make, what they need manufactured, quantities, timelines, budgets, quality standards. Be conversational, not interrogatory. Ask one or two questions at a time.
2. REMEMBER — Use your tools to save everything you learn. Company info, project details, requirements. This knowledge persists forever so you never ask the same thing twice.
3. ACT — Once you understand a project well enough, tell the user you'll start searching for factories. Use search_factories to kick off the process.
4. UPDATE — Keep the user informed about progress. When you find matches, present them clearly with quotes, timelines, and next steps.

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
- Use update_knowledge for preferences and facts that don't fit company/project fields (e.g. "prefers DHL shipping", "had bad experience with Alibaba suppliers")
- Format prices, quantities, and timelines clearly
- Use markdown formatting sparingly — keep responses chat-friendly
- When you already know something about the user from the context below, don't ask again — reference it naturally
- If you have projects from previous sessions, ask for updates rather than starting fresh`;

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
      "Store a specific fact about the user or their business for long-term memory. Use for preferences, past experiences, important context that doesn't fit company/project fields.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Short label for the fact (e.g. 'preferred_shipping', 'past_supplier_issues')" },
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
      "Update the AI-generated summary for a project. Call this after learning significant new details about a project to keep the summary current.",
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
];

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
          .insert({
            user_id: userId,
            name: name || "Unknown",
            industry: industry || "",
            description: description || "",
            location: location || "",
            ai_knowledge: knowledge,
          })
          .select("id")
          .single();
        return `Saved new company "${name}" (id: ${data?.id}).`;
      }
    }

    case "save_project": {
      const { title, description, quantity, budget, timeline, quality_requirements, materials, additional_notes } =
        toolInput as Record<string, string>;

      const { data: company } = await supabaseAdmin
        .from("companies")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();

      const requirements: Record<string, string> = {};
      if (quantity) requirements.quantity = quantity;
      if (budget) requirements.budget = budget;
      if (timeline) requirements.timeline = timeline;
      if (quality_requirements) requirements.quality_requirements = quality_requirements;
      if (materials) requirements.materials = materials;
      if (additional_notes) requirements.additional_notes = additional_notes;

      const { data } = await supabaseAdmin
        .from("projects")
        .insert({
          user_id: userId,
          company_id: company?.id || null,
          title,
          description: description || "",
          requirements,
          status: "intake",
        })
        .select("id")
        .single();

      return `Created project "${title}" (id: ${data?.id}). I'll search for factories once I have enough details.`;
    }

    case "update_knowledge": {
      const { key, value } = toolInput as { key: string; value: string };
      const { data: company } = await supabaseAdmin
        .from("companies")
        .select("id, ai_knowledge")
        .eq("user_id", userId)
        .maybeSingle();

      if (company) {
        const knowledge = { ...(company.ai_knowledge || {}), [key]: value };
        await supabaseAdmin.from("companies").update({ ai_knowledge: knowledge }).eq("id", company.id);
      } else {
        await supabaseAdmin.from("companies").insert({
          user_id: userId,
          name: "Unknown",
          ai_knowledge: { [key]: value },
        });
      }
      return `Remembered: ${key} = ${value}`;
    }

    case "search_factories": {
      const { project_id, criteria } = toolInput as { project_id: string; criteria?: Record<string, unknown> };
      const { data: search } = await supabaseAdmin
        .from("factory_searches")
        .insert({
          project_id,
          search_criteria: criteria || {},
          status: "pending",
        })
        .select("id")
        .single();

      await supabaseAdmin.from("projects").update({ status: "searching" }).eq("id", project_id);

      return `Factory search started (search id: ${search?.id}). I'll work on finding matches — this may take a little while as I reach out to factories and negotiate on your behalf. I'll update you with results.`;
    }

    case "get_project_status": {
      const { project_id } = toolInput as { project_id: string };
      const { data: project } = await supabaseAdmin
        .from("projects")
        .select("title, status, requirements, ai_summary")
        .eq("id", project_id)
        .single();

      if (!project) return "Project not found.";

      const { data: matches } = await supabaseAdmin
        .from("matches")
        .select("id, status, quote, context_summary, factories(name, location)")
        .eq("project_id", project_id);

      return JSON.stringify({ project, matches: matches || [] });
    }

    case "update_project_summary": {
      const { project_id, summary } = toolInput as { project_id: string; summary: Record<string, unknown> };
      await supabaseAdmin
        .from("projects")
        .update({ ai_summary: summary, updated_at: new Date().toISOString() })
        .eq("id", project_id);
      return `Project summary updated.`;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

async function loadContext(userId: string): Promise<string> {
  const parts: string[] = [];

  const { data: company } = await supabaseAdmin
    .from("companies")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

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
        projects
          .map(
            (p) =>
              `- **${p.title}** (${p.status}): ${p.description}${
                p.requirements ? "\n  Requirements: " + JSON.stringify(p.requirements) : ""
              }${p.ai_summary ? "\n  Summary: " + JSON.stringify(p.ai_summary) : ""}`
          )
          .join("\n")
    );
  }

  return parts.length ? "\n\n---\n\n# What you already know about this user\n\n" + parts.join("\n\n") : "";
}

export async function runIntakeAgent(
  userId: string,
  userMessage: string,
  conversationHistory: MessageParam[]
): Promise<{ reply: string; messages: MessageParam[] }> {
  const anthropic = getAnthropicClient();
  const context = await loadContext(userId);
  const systemPrompt = SYSTEM_PROMPT + context;

  const messages: MessageParam[] = [
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  let currentMessages = [...messages];

  // Agent loop: handle tool calls until we get a final text response
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

    if (toolUseBlocks.length === 0) {
      const reply = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n\n");
      currentMessages.push({ role: "assistant", content: response.content });
      return { reply, messages: currentMessages };
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
      return { reply, messages: currentMessages };
    }
  }

  return { reply: "I'm processing that — give me a moment.", messages: currentMessages };
}
