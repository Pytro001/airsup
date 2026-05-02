import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";

export const notifyRouter = Router();

notifyRouter.post("/welcome", requireAuth, async (req: AuthRequest, res: Response) => {
  const { phone, name, role } = req.body as { phone?: string; name?: string; role?: string };

  if (!phone?.trim()) {
    res.status(400).json({ error: "phone is required" });
    return;
  }

  const to = phone.trim();

  try {
    if (role === "supplier") {
      await sendWhatsAppMessage(
        to,
        `Hi${name ? " " + name : ""}! Welcome to Airsup. 🎉\n\nWe'll match you with buyer projects that fit your capabilities. When there's a good fit, we'll send you the full brief so you can connect directly with the buyer.\n\nWe'll be in touch soon!`
      );
    } else {
      await sendWhatsAppMessage(
        to,
        `Hi${name ? " " + name : ""}! I'm Supi, your Airsup sourcing agent. 🔍\n\nI'm starting my search for the right suppliers now. Feel free to reply with more files or details about your project — I'll pass everything on to the factories so when you connect with them on WhatsApp, they already know your full brief.`
      );

      setTimeout(async () => {
        try {
          await sendWhatsAppMessage(
            to,
            "I'll be back with the first contacts in 2–5 hours."
          );
        } catch (err) {
          console.error("[notify] second WA message failed:", err);
        }
      }, 3000);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[notify/welcome] error:", err);
    res.status(500).json({ error: "Failed to send welcome message" });
  }
});
