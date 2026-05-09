import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { callClaude } from "../lib/claude.js";
import { messages } from "../lib/messages.js";

export async function qaLoop({ outreachId, question }: { outreachId: string; question: string }) {
  const { data: outreach } = await supabaseAdmin
    .from("wa_outreach")
    .select("*, factories(*), projects(*, profiles!projects_user_id_fkey(*), project_knowledge(*))")
    .eq("id", outreachId)
    .single();

  if (!outreach) return;

  const project = (outreach as any).projects;
  const supplier = (outreach as any).factories;
  const buyer = project?.profiles;
  const knowledge = (project?.project_knowledge ?? [])
    .map((k: any) => `[${k.type}] ${k.content}`)
    .join("\n\n");

  const decision = await callClaude({
    model: "claude-sonnet-4-6",
    system: `You are Supi handling a supplier question. Decide whether to answer directly or escalate to the buyer.

ANSWER DIRECTLY if:
- The answer is clearly in the project knowledge
- It is inferable from context or industry standard (MOQ, payment terms, packaging)
- Getting it wrong would not change product spec, cost > 10%, or compliance

ESCALATE TO BUYER if:
- Material grade or compliance cert (FDA, CE, RoHS) not in brief
- Spec conflict where supplier says current design will not work
- Cost-impacting choice > 10% unit cost
- Custom branding, packaging, or logo placement
- Anything where guessing wrong damages the project

Return JSON only:
{"action": "answer" | "escalate", "answer": "", "reason_for_escalating": ""}`,
    messages: [
      {
        role: "user",
        content: `Project knowledge:\n${knowledge}\n\nSupplier question: ${question}`,
      },
    ],
  });

  if (decision?.action === "answer") {
    if (supplier?.whatsapp_id) {
      await sendWhatsAppMessage(supplier.whatsapp_id, decision.answer);
    }
    await supabaseAdmin.from("project_knowledge").insert({
      project_id: project.id,
      type: "qa_pair",
      content: `Q (from ${supplier?.name}): ${question}\nA: ${decision.answer}`,
    });
    await supabaseAdmin
      .from("wa_outreach")
      .update({ status: "sent", last_message_at: new Date().toISOString() })
      .eq("id", outreachId);
  } else {
    const urgency = /conflict|blocking|cannot proceed/i.test(decision?.reason_for_escalating ?? "")
      ? "urgent"
      : "normal";

    const { data: bq } = await supabaseAdmin
      .from("buyer_questions")
      .insert({
        project_id: project.id,
        outreach_id: outreachId,
        question,
        reason_for_escalating: decision?.reason_for_escalating ?? "",
        urgency,
      })
      .select()
      .single();

    if (urgency === "urgent" && buyer?.whatsapp_id) {
      await sendWhatsAppMessage(
        buyer.whatsapp_id,
        messages.buyer.questionForBuyer(question, decision?.reason_for_escalating ?? "")
      );
      if (bq) {
        await supabaseAdmin
          .from("buyer_questions")
          .update({ status: "asked", asked_at: new Date().toISOString() })
          .eq("id", bq.id);
      }
    }
    // urgency=normal → waits for daily-digest
  }
}
