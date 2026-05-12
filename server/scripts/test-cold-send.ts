/**
 * One-shot test: sends a clean cold outreach email (no em-dashes, no slashes,
 * no footer) so you can verify the format.
 *
 *   IONOS_SMTP_PASSWORD='...' TEST_TO='you@gmail.com' npx tsx scripts/test-cold-send.ts
 */
import "dotenv/config";
import * as nodemailer from "nodemailer";

const TO = process.env.TEST_TO || "pytrobusiness@gmail.com";
const USER = process.env.IONOS_SMTP_USER || "konstantin@airsup.dev";
const PASS = process.env.IONOS_SMTP_PASSWORD;

if (!PASS) { console.error("Set IONOS_SMTP_PASSWORD"); process.exit(1); }

const draft = {
  subject: "anker and logitech work",
  body:
    `Hi Lily,\n\n` +
    `Saw Aoxin's site and the customer list (Anker, Logitech, Razer) is what made me write. Most factories we screen cannot show that kind of track record.\n\n` +
    `I run Airsup. We match vetted manufacturers with serious Western founders and product teams. Pre-qualified buyers with real budget, not RFQ spam. It is free for suppliers and we never take commission.\n\n` +
    `If it is worth a look, you can finish onboarding in about 5 minutes here: https://airsup.dev/start\n\n` +
    `Konstantin`,
};

async function main() {
  console.log("--- EMAIL ---");
  console.log("Subject:", draft.subject);
  console.log("\n" + draft.body);
  console.log("--- /EMAIL ---\n");

  console.log(`Sending to ${TO} via IONOS...`);
  const transporter = nodemailer.createTransport({
    host: "smtp.ionos.com",
    port: 465,
    secure: true,
    auth: { user: USER, pass: PASS },
  });

  const result = await transporter.sendMail({
    from: `"Konstantin" <${USER}>`,
    to: TO,
    subject: draft.subject,
    text: draft.body,
  });

  console.log("Sent. Message-ID:", result.messageId);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
