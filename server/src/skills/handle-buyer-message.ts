import { supabaseAdmin } from "../services/supabase.js";
import { callClaude } from "../lib/claude.js";
import { triggerSkill } from "./runner.js";

export async function handleBuyerMessage({ buyer, project, knowledge, message }: any) {
  // File upload
  if (message.type === "document" || message.type === "image") {
    await supabaseAdmin.from("project_knowledge").insert({
      project_id: project.id,
      type: "file",
      content: `[${message.type} uploaded via WhatsApp]`,
      metadata: { raw: message.raw },
    });
    return;
  }

  // Check for pending question we asked the buyer
  const { data: pendingQ } = await supabaseAdmin
    .from("buyer_questions")
    .select("*")
    .eq("project_id", project.id)
    .eq("status", "asked")
    .order("asked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const intent = await callClaude({
    model: "claude-haiku-4-5-20251001",
    system: `Classify the buyer's message. Return JSON only.
Categories:
- "confirm_understanding": buyer is confirming the summary you sent (yes / sounds good / proceed)
- "answer_question": buyer is answering a question Supi asked them
- "status_check": buyer wants to know where the project is
- "new_info": buyer is adding info or context to the project
- "decision": buyer is making a decision on a quote (proceed / find cheaper / pick option X)
- "chitchat": general conversation
Return: {"intent": "...", "extracted": "..."}`,
    messages: [
      {
        role: "user",
        content: `Pending question: ${pendingQ?.question || "none"}\nBuyer message: ${message.text}`,
      },
    ],
  });

  switch (intent?.intent) {
    case "confirm_understanding":
      return triggerSkill("kickoff-research", { projectId: project.id });

    case "answer_question":
      if (pendingQ) {
        return triggerSkill("relay-buyer-answer", {
          questionId: pendingQ.id,
          answer: intent.extracted,
        });
      }
      break;

    case "status_check":
      return triggerSkill("send-status", { projectId: project.id, buyer });

    case "new_info":
      await supabaseAdmin.from("project_knowledge").insert({
        project_id: project.id,
        type: "note",
        content: message.text,
      });
      break;

    case "decision":
      return triggerSkill("handle-buyer-decision", {
        projectId: project.id,
        buyer,
        decision: intent.extracted,
      });

    default:
      break;
  }
}
