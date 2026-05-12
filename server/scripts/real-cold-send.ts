import "dotenv/config";
import * as nodemailer from "nodemailer";

const TO = process.env.TEST_TO!;
const SUBJECT = process.env.SUBJ!;
const BODY = process.env.BODY!;
const USER = process.env.IONOS_SMTP_USER || "konstantin@airsup.dev";
const PASS = process.env.IONOS_SMTP_PASSWORD!;
const CC = process.env.CC_TO || "";

async function main() {
  const transporter = nodemailer.createTransport({
    host: "smtp.ionos.com",
    port: 465,
    secure: true,
    auth: { user: USER, pass: PASS },
  });
  const result = await transporter.sendMail({
    from: `"Konstantin" <${USER}>`,
    to: TO,
    cc: CC || undefined,
    subject: SUBJECT,
    text: BODY,
  });
  console.log("Sent. Message-ID:", result.messageId, "To:", TO, "CC:", CC || "(none)");
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
