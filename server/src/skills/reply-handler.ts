import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { callClaude } from "../lib/claude.js";
import { messages } from "../lib/messages.js";
import { triggerSkill } from "./runner.js";

export async function replyHandler({ supplier, outreach, project, message }: any) {
  const buyer = (project as any).profiles ?? (project as any).buyers;

  const classification = await callClaude({
    model: "claude-haiku-4-5-20251001",
    system: `Classify a supplier's WhatsApp reply. Return JSON only.
Categories:
- "yes_full": agrees to whole project
- "yes_partial": agrees but excludes a part. Extract carve_out.
- "no": declines
- "question": needs clarification before deciding. Extract question.
- "quote": providing pricing. Extract sample_cost, bulk_price, bulk_qty, lead_time_days.
- "other": chitchat, acknowledgment, etc.
Format: {"category": "...", "carve_out": null, "question": null, "sample_cost": null, "bulk_price": null, "bulk_qty": null, "lead_time_days": null}`,
    messages: [{ role: "user", content: message.text }],
  });

  const quantity = project?.quantity ?? 0;

  switch (classification?.category) {
    case "yes_full":
      await supabaseAdmin
        .from("wa_outreach")
        .update({ status: "replied_yes", last_message_at: new Date().toISOString() })
        .eq("id", outreach.id);
      if (supplier.whatsapp_id) {
        await sendWhatsAppMessage(supplier.whatsapp_id, messages.supplier.askForQuote(quantity));
      }
      if (buyer?.whatsapp_id) {
        await sendWhatsAppMessage(buyer.whatsapp_id, messages.buyer.supplierConfirmed(supplier.name));
      }
      break;

    case "yes_partial":
      await supabaseAdmin
        .from("wa_outreach")
        .update({
          status: "replied_yes_partial",
          carve_out: classification.carve_out,
          last_message_at: new Date().toISOString(),
        })
        .eq("id", outreach.id);
      if (supplier.whatsapp_id) {
        await sendWhatsAppMessage(supplier.whatsapp_id, messages.supplier.askForQuote(quantity));
      }
      if (buyer?.whatsapp_id) {
        await sendWhatsAppMessage(
          buyer.whatsapp_id,
          messages.buyer.supplierCarveOut(supplier.name, classification.carve_out)
        );
      }
      return triggerSkill("decompose", {
        projectId: project.id,
        carveOut: classification.carve_out,
      });

    case "no":
      await supabaseAdmin
        .from("wa_outreach")
        .update({ status: "replied_no", last_message_at: new Date().toISOString() })
        .eq("id", outreach.id);
      if (buyer?.whatsapp_id) {
        await sendWhatsAppMessage(buyer.whatsapp_id, messages.buyer.supplierPassed());
      }
      return triggerSkill("try-next-candidate", { projectId: project.id });

    case "question":
      await supabaseAdmin
        .from("wa_outreach")
        .update({ status: "questions_pending", last_message_at: new Date().toISOString() })
        .eq("id", outreach.id);
      return triggerSkill("qa-loop", {
        outreachId: outreach.id,
        question: classification.question,
      });

    case "quote":
      await supabaseAdmin
        .from("wa_outreach")
        .update({
          sample_cost: classification.sample_cost,
          bulk_price: classification.bulk_price,
          bulk_qty: classification.bulk_qty,
          lead_time_days: classification.lead_time_days,
          status: "quoted",
          last_message_at: new Date().toISOString(),
        })
        .eq("id", outreach.id);
      return triggerSkill("quote-summary", { outreachId: outreach.id });

    default:
      break;
  }
}
