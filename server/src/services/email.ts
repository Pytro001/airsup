/**
 * IONOS email service (SMTP send + IMAP poll) for konstantin@airsup.dev cold outreach.
 *
 * Requires env:
 *   IONOS_SMTP_USER     (e.g. konstantin@airsup.dev)
 *   IONOS_SMTP_PASSWORD
 *   IONOS_SMTP_HOST     (default: smtp.ionos.com)
 *   IONOS_SMTP_PORT     (default: 465)
 *   IONOS_IMAP_HOST     (default: imap.ionos.com)
 *   IONOS_IMAP_PORT     (default: 993)
 *   IONOS_FROM_NAME     (default: "Konstantin · Airsup")
 */

import nodemailer from "nodemailer";
import { ImapFlow, type FetchMessageObject } from "imapflow";

const HOST_SMTP = process.env.IONOS_SMTP_HOST || "smtp.ionos.com";
const PORT_SMTP = parseInt(process.env.IONOS_SMTP_PORT || "465", 10);
const HOST_IMAP = process.env.IONOS_IMAP_HOST || "imap.ionos.com";
const PORT_IMAP = parseInt(process.env.IONOS_IMAP_PORT || "993", 10);
const USER = process.env.IONOS_SMTP_USER || "konstantin@airsup.dev";
const PASS = process.env.IONOS_SMTP_PASSWORD || "";
const FROM_NAME = process.env.IONOS_FROM_NAME || "Konstantin · Airsup";

let transporter: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter {
  if (!PASS) throw new Error("IONOS_SMTP_PASSWORD not set");
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: HOST_SMTP,
      port: PORT_SMTP,
      secure: PORT_SMTP === 465,
      auth: { user: USER, pass: PASS },
    });
  }
  return transporter;
}

export type SendArgs = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  unsubscribeToken?: string;
  bcc?: string;
};

export type SendResult = {
  messageId: string;
};

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const t = getTransport();
  const unsubUrl = args.unsubscribeToken
    ? `https://airsup.dev/api/cold/unsubscribe/${args.unsubscribeToken}`
    : null;

  const headers: Record<string, string> = {};
  if (args.inReplyTo) headers["In-Reply-To"] = args.inReplyTo;
  if (args.references?.length) headers["References"] = args.references.join(" ");
  if (unsubUrl) {
    headers["List-Unsubscribe"] = `<${unsubUrl}>, <mailto:${USER}?subject=unsubscribe>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const result = await t.sendMail({
    from: `"${FROM_NAME}" <${USER}>`,
    to: args.to,
    bcc: args.bcc,
    subject: args.subject,
    text: args.text,
    html: args.html,
    headers,
  });

  return { messageId: String(result.messageId || "").replace(/[<>]/g, "") };
}

export type InboundEmail = {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string;
  subject: string;
  text: string;
  date: Date;
};

/**
 * Fetch unread messages from INBOX, mark them as seen.
 */
export async function fetchUnreadEmails(limit = 50): Promise<InboundEmail[]> {
  if (!PASS) throw new Error("IONOS_SMTP_PASSWORD not set");
  const client = new ImapFlow({
    host: HOST_IMAP,
    port: PORT_IMAP,
    secure: true,
    auth: { user: USER, pass: PASS },
    logger: false,
  });

  const out: InboundEmail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || !uids.length) return out;
      const take = uids.slice(-limit);
      for await (const msg of client.fetch(take, {
        envelope: true,
        source: true,
        bodyStructure: true,
        flags: true,
      }, { uid: true }) as AsyncIterable<FetchMessageObject>) {
        const env = msg.envelope;
        if (!env) continue;
        const text = await extractText(msg);
        const fromAddr = env.from?.[0]?.address || "";
        const toAddr = env.to?.[0]?.address || "";
        const refs = typeof (env as unknown as { references?: string }).references === "string"
          ? ((env as unknown as { references: string }).references).split(/\s+/).filter(Boolean)
          : [];
        out.push({
          messageId: (env.messageId || "").replace(/[<>]/g, ""),
          inReplyTo: (env.inReplyTo || "").replace(/[<>]/g, "") || null,
          references: refs,
          from: fromAddr,
          to: toAddr,
          subject: env.subject || "",
          text,
          date: env.date || new Date(),
        });
        await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return out;
}

async function extractText(msg: FetchMessageObject): Promise<string> {
  if (!msg.source) return "";
  const src = msg.source.toString("utf8");
  // Very rough: find first text/plain section.
  const plainMatch = src.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\nContent-Type:)/i);
  if (plainMatch) return decodeBody(plainMatch[1]).slice(0, 20000);
  // Fall back: strip headers, take body.
  const headerEnd = src.indexOf("\r\n\r\n");
  if (headerEnd >= 0) return src.slice(headerEnd + 4).slice(0, 20000);
  return src.slice(0, 20000);
}

function decodeBody(s: string): string {
  // Strip quoted-printable soft breaks; do not attempt full QP decode.
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
}
