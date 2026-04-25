/**
 * Best-effort extraction of chat text from public share pages (ChatGPT, Claude, Grok).
 * HTML layouts change; on failure clients should use paste.
 */

const MAX_BYTES = 2_000_000;
const ABORT_MS = 8000;

export class UnsupportedShareError extends Error {
  override name = "UnsupportedShareError";
  constructor(message: string) {
    super(message);
  }
}

export type ChatProvider = "chatgpt" | "claude" | "grok" | "unknown";

export function detectProvider(u: URL): ChatProvider {
  const h = u.hostname.toLowerCase();
  const path = u.pathname;
  if (h === "chat.openai.com" || h === "chatgpt.com" || h.endsWith(".chatgpt.com")) return "chatgpt";
  if (h === "claude.ai" || h === "www.claude.ai" || h.endsWith(".claude.ai")) return "claude";
  if (path.includes("/share/") && (h.includes("grok") || h === "x.ai" || h.endsWith(".grok.com"))) return "grok";
  if (
    h === "grok.com" ||
    h === "www.grok.com" ||
    h === "grok.x.ai" ||
    h === "www.grok.x.ai" ||
    h === "x.com" ||
    h === "www.x.com" ||
    h === "twitter.com"
  ) {
    return "grok";
  }
  if (h.endsWith("x.ai") && path.includes("/share/")) return "grok";
  return "unknown";
}

type ChatMessage = { role: "user" | "assistant"; content: string };

export async function fetchChatShare(shareUrl: string): Promise<{ provider: ChatProvider; text: string; messages: ChatMessage[] }> {
  const u = new URL(shareUrl);
  const provider = detectProvider(u);
  if (provider === "unknown") {
    throw new UnsupportedShareError("Only shared links from ChatGPT, Claude, or Grok are supported, or paste the conversation as text.");
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ABORT_MS);
  let res: Response;
  try {
    res = await fetch(shareUrl, {
      signal: ac.signal,
      headers: { "User-Agent": "Airsup/1.0 (manufacturing brief import)", Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new UnsupportedShareError("Timed out fetching the share page.");
    throw new UnsupportedShareError("Could not fetch the link. Check that it is public and try again, or paste the chat.");
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    throw new UnsupportedShareError(`Link returned HTTP ${res.status}. The chat may be private, or paste the conversation instead.`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new UnsupportedShareError("The shared page is too large. Copy the relevant parts and paste them instead.");
  }
  const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);

  const messages: ChatMessage[] = [];
  if (provider === "chatgpt") {
    const fromNext = tryParseOpenAINextData(html);
    if (fromNext.length) {
      for (const m of fromNext) messages.push(m);
    }
  } else if (provider === "claude") {
    const fromClaude = tryParseClaude(html);
    if (fromClaude.length) for (const m of fromClaude) messages.push(m);
  } else if (provider === "grok") {
    const fromGrok = tryParseGrok(html);
    if (fromGrok.length) for (const m of fromGrok) messages.push(m);
  }

  if (messages.length === 0) {
    const plain = htmlToVisibleTextPreferred(html);
    if (plain.length < 80) {
      throw new UnsupportedShareError("Could not read messages from that page. It may be private or the layout changed. Paste the chat instead.");
    }
    return { provider, text: plain.slice(0, 200_000), messages: [] };
  }

  const text = messages
    .map((m) => (m.role === "user" ? "User" : "Assistant") + ":\n" + m.content)
    .join("\n\n")
    .slice(0, 200_000);
  return { provider, text, messages };
}

function htmlToVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer main / article / #__next to avoid mostly-nav shell when the page is client-rendered. */
function htmlToVisibleTextPreferred(html: string): string {
  const tryChunk = (chunk: string | undefined): string => {
    if (!chunk || chunk.length < 40) return "";
    return htmlToVisibleText(chunk);
  };
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const tMain = tryChunk(main?.[1]);
  if (tMain.length >= 80) return tMain;
  const art = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const tArt = tryChunk(art?.[1]);
  if (tArt.length > tMain.length) {
    if (tArt.length >= 80) return tArt;
  } else if (tMain.length >= 40) return tMain;
  const role = html.match(/<div[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/div>/i);
  const tRole = tryChunk(role?.[1]);
  if (tRole.length >= 80) return tRole;
  if (tArt.length > tMain.length && tArt.length >= 40) return tArt;
  if (tMain.length >= 40) return tMain;
  return htmlToVisibleText(html);
}

function tryParseOpenAINextData(html: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([^<]+)<\/script>/i);
  if (!m) return out;
  let j: unknown;
  try {
    j = JSON.parse(m[1]);
  } catch {
    return out;
  }

  const walk = (node: unknown, depth = 0): void => {
    if (depth > 32 || out.length > 500) return;
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const el of node) walk(el, depth + 1);
      return;
    }
    if (typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.role && (o.content || o.text || o.message)) {
        const role = String(o.role).toLowerCase();
        const c = o.content ?? o.text ?? o.message;
        const text = extractContentString(c);
        if (text && (role === "user" || role === "assistant" || role === "model")) {
          out.push({ role: role === "user" ? "user" : "assistant", content: text.slice(0, 50_000) });
        }
      }
      for (const v of Object.values(o)) walk(v, depth + 1);
    }
  };

  walk(j, 0);
  if (out.length) return out;

  const linear = findDeepStringPath(j, "linear_conversation");
  if (Array.isArray(linear)) {
    for (const item of linear) {
      if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const role = String(it.role || "").toLowerCase();
        const c = it.content || it.text;
        const text = extractContentString(c);
        if (text && (role === "user" || role === "assistant" || role === "model")) {
          out.push({ role: role === "user" ? "user" : "assistant", content: text.slice(0, 50_000) });
        }
      }
    }
  }
  return out;
}

function findDeepStringPath(root: unknown, key: string): unknown {
  if (root == null) return undefined;
  if (Array.isArray(root)) {
    for (const el of root) {
      const f = findDeepStringPath(el, key);
      if (f !== undefined) return f;
    }
    return undefined;
  }
  if (typeof root === "object") {
    const o = root as Record<string, unknown>;
    if (key in o) return o[key];
    for (const v of Object.values(o)) {
      const f = findDeepStringPath(v, key);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}

function extractContentString(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: string }).text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (c && typeof c === "object" && "text" in c) return String((c as { text: string }).text);
  return "";
}

function tryParseClaudeFromNextData(html: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([^<]+)<\/script>/i);
  if (!m) return out;
  let j: unknown;
  try {
    j = JSON.parse(m[1]);
  } catch {
    return out;
  }
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 36 || out.length > 500) return;
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const el of node) visit(el, depth + 1);
      return;
    }
    if (typeof node === "object") {
      const o = node as Record<string, unknown>;
      const send = o.sender != null ? String(o.sender).toLowerCase() : "";
      const role = o.role != null ? String(o.role).toLowerCase() : "";
      const t = extractContentString(o.content) || (typeof o.text === "string" ? o.text : "");
      if (t && t.length > 2) {
        if (send === "human" || role === "human" || role === "user") {
          out.push({ role: "user", content: t.slice(0, 50_000) });
        } else if (send === "assistant" || role === "assistant" || role === "claude" || role === "model") {
          out.push({ role: "assistant", content: t.slice(0, 50_000) });
        }
      }
      for (const v of Object.values(o)) visit(v, depth + 1);
    }
  };
  visit(j, 0);
  return out;
}

function tryParseClaude(html: string): ChatMessage[] {
  const fromNext = tryParseClaudeFromNextData(html);
  if (fromNext.length) return fromNext;
  const out: ChatMessage[] = [];
  for (const re of [/"chat_messages"\s*:\s*(\[[\s\S]*?\])\s*[,}]/, /"messages"\s*:\s*(\[[\s\S]*?\])\s*[,}]/]) {
    const m = html.match(re);
    if (m) {
      try {
        const arr = JSON.parse(m[1]) as unknown[];
        for (const item of arr) {
          if (item && typeof item === "object") {
            const o = item as Record<string, unknown>;
            const role = String(o.sender || o.role || "").toLowerCase();
            const t = (o.text as string) || (o.content as string) || extractContentString(o.content);
            if (!t) continue;
            if (role === "human" || role === "user") out.push({ role: "user", content: t.slice(0, 50_000) });
            else if (role === "assistant" || role === "claude") out.push({ role: "assistant", content: t.slice(0, 50_000) });
          }
        }
        if (out.length) return out;
      } catch {
        /* continue */
      }
    }
  }
  return out;
}

/**
 * First balanced `{…}` after marker, skipping braces inside double-quoted JSON strings.
 * `'` strings are a best-effort (non-standard JSON) fallback.
 */
function parseJsonObjectAfterMarker(html: string, marker: string): unknown | null {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf("{", i);
  if (start < 0) return null;
  const endScript = html.toLowerCase().indexOf("</script>", start);
  const endCap = endScript > 0 ? endScript : html.length;
  const slice = html.slice(start, endCap);
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let esc = false;
  for (let j = 0; j < slice.length; j++) {
    const c = slice[j];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\" && inStr === '"') {
        esc = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(slice.slice(0, j + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function tryParseGrokFromInitialState(html: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const st = parseJsonObjectAfterMarker(html, "__INITIAL_STATE__");
  if (st != null) {
    try {
      walkGrokState(st, out);
    } catch {
      /* empty */
    }
  }
  return out;
}

function tryParseGrokFromScriptJsonBlobs(html: string, out: ChatMessage[]): void {
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 200) {
    const body = m[1].trim();
    if (body.length < 80) continue;
    if (!/^\s*[\[{]/.test(body)) continue;
    if (!/role|"user"|"assistant"|"model"|"content"/.test(body)) continue;
    try {
      const j = JSON.parse(body) as unknown;
      const before = out.length;
      walkGrokState(j, out);
      if (out.length > before) return;
    } catch {
      /* continue */
    }
  }
}

function tryParseGrok(html: string): ChatMessage[] {
  const a = tryParseGrokFromInitialState(html);
  if (a.length) return a;
  const out: ChatMessage[] = [];
  const nuxtM = html.match(
    /<script[^>]+id=["']__NUXT__[^"']*["'][^>]*type=["']application\/json["'][^>]*>([^<]+)<\/script>/i
  );
  if (nuxtM) {
    try {
      walkGrokState(JSON.parse(nuxtM[1]) as unknown, out);
    } catch {
      /* empty */
    }
  }
  if (out.length) return out;
  const nuxtInline = parseJsonObjectAfterMarker(html, "__NUXT__");
  if (nuxtInline != null) {
    try {
      walkGrokState(nuxtInline, out);
    } catch {
      /* empty */
    }
  }
  if (out.length) return out;
  const s2: ChatMessage[] = [];
  tryParseGrokFromScriptJsonBlobs(html, s2);
  return s2;
}

function walkGrokState(node: unknown, out: ChatMessage[], depth = 0): void {
  if (depth > 40 || out.length > 200) return;
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const el of node) walkGrokState(el, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.role && o.content) {
      const role = String(o.role).toLowerCase();
      const t = extractContentString(o.content);
      if (t.length > 5 && (role === "user" || role === "assistant" || role === "model")) {
        out.push({ role: role === "user" ? "user" : "assistant", content: t.slice(0, 30_000) });
      }
    }
    for (const v of Object.values(o)) walkGrokState(v, out, depth + 1);
  }
}
