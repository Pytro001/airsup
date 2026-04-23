const WA_API_VERSION = "v21.0";
const WA_BASE = `https://graph.facebook.com/${WA_API_VERSION}`;

function getConfig() {
  return {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    token: process.env.WHATSAPP_ACCESS_TOKEN || "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "airsup-verify",
  };
}

export async function sendWhatsAppMessage(
  to: string,
  text: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { phoneNumberId, token } = getConfig();
  if (!phoneNumberId || !token) {
    console.warn("[WhatsApp] Not configured, skipping send");
    return { success: false, error: "WhatsApp not configured" };
  }

  try {
    const res = await fetch(`${WA_BASE}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data.error?.message || `HTTP ${res.status}` };
    }
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function sendMatchIntro(
  buyerPhone: string,
  factoryPhone: string,
  context: {
    buyerName: string;
    factoryName: string;
    projectTitle: string;
    summary: string;
    quote: Record<string, unknown>;
    nextSteps: string;
  }
): Promise<{ buyerSent: boolean; factorySent: boolean }> {
  const buyerMsg = [
    `Hi ${context.buyerName}! Great news from Airsup.`,
    ``,
    `We found a match for your project "${context.projectTitle}":`,
    `**${context.factoryName}**`,
    ``,
    context.summary,
    ``,
    `Quote: ${context.quote.unit_price || "TBD"} per unit, ${context.quote.lead_time || "TBD"} lead time`,
    ``,
    `Next steps: ${context.nextSteps}`,
    ``,
    `The factory contact has been notified and is expecting your message. You can discuss details directly here on WhatsApp.`,
  ].join("\n");

  const factoryMsg = [
    `Hi! This is Airsup, the manufacturing sourcing platform.`,
    ``,
    `We have a buyer interested in working with ${context.factoryName}:`,
    `**Project: ${context.projectTitle}**`,
    ``,
    context.summary,
    ``,
    `Buyer: ${context.buyerName}`,
    ``,
    `They'll be reaching out to discuss details. The project has been pre-qualified and the buyer is serious.`,
  ].join("\n");

  const [buyerResult, factoryResult] = await Promise.all([
    buyerPhone ? sendWhatsAppMessage(buyerPhone, buyerMsg) : Promise.resolve({ success: false, error: "No phone" }),
    factoryPhone ? sendWhatsAppMessage(factoryPhone, factoryMsg) : Promise.resolve({ success: false, error: "No phone" }),
  ]);

  return { buyerSent: buyerResult.success, factorySent: factoryResult.success };
}

export function verifyWebhook(mode: string, token: string, challenge: string): string | null {
  const { verifyToken } = getConfig();
  if (mode === "subscribe" && token === verifyToken) return challenge;
  return null;
}

export interface IncomingWhatsAppMessage {
  from: string;
  text: string;
  messageId: string;
  timestamp: string;
}

export function parseWebhookPayload(body: Record<string, unknown>): IncomingWhatsAppMessage[] {
  const messages: IncomingWhatsAppMessage[] = [];
  try {
    const entry = (body.entry as any[]) || [];
    for (const e of entry) {
      const changes = e.changes || [];
      for (const c of changes) {
        const msgs = c.value?.messages || [];
        for (const m of msgs) {
          if (m.type === "text") {
            messages.push({
              from: m.from,
              text: m.text?.body || "",
              messageId: m.id,
              timestamp: m.timestamp,
            });
          }
        }
      }
    }
  } catch {
    // malformed payload
  }
  return messages;
}
