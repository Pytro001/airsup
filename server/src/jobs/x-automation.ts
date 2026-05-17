import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getOpenAIClient } from "../services/openai.js";
import { MODEL_FAST } from "../services/openai.js";
import { postTweet, searchTweets } from "../services/x-api.js";

const HISTORY_FILE = join(process.cwd(), "x-history.json");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ── History ──────────────────────────────────────────────────────────────────

interface History {
  posts: Array<{ text: string; tweetId: string | null; timestamp: number }>;
  replies: Array<{ tweetId: string; replyText: string; timestamp: number }>;
}

function loadHistory(): History {
  if (!existsSync(HISTORY_FILE)) return { posts: [], replies: [] };
  return JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
}

function saveHistory(data: History) {
  writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function getRecentPosts(): string[] {
  const { posts } = loadHistory();
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return posts.filter(p => p.timestamp > cutoff).map(p => p.text);
}

function recordPost(text: string, tweetId: string | null) {
  const data = loadHistory();
  data.posts.push({ text, tweetId, timestamp: Date.now() });
  if (data.posts.length > 100) data.posts = data.posts.slice(-100);
  saveHistory(data);
}

function recordReply(tweetId: string, replyText: string) {
  const data = loadHistory();
  data.replies.push({ tweetId, replyText, timestamp: Date.now() });
  if (data.replies.length > 500) data.replies = data.replies.slice(-500);
  saveHistory(data);
}

function hasRepliedTo(tweetId: string): boolean {
  return loadHistory().replies.some(r => r.tweetId === tweetId);
}

function getRotationIndex(): number {
  return loadHistory().posts.length % 5;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const POST_ROTATION = ["A", "B", "A", "C", "A", "B", "A", "C"];

const SYSTEM_PROMPT_POSTER = `
You are AirX, the X (Twitter) voice for Airsup — a sourcing platform connecting hardware founders with manufacturers worldwide.

Konstantin runs Airsup. He's 21, has been on factory floors in Shenzhen, raised a SAFE, speaks founder-to-founder. Never corporate.

You write three types of posts:

TYPE A — Community engagement / traffic drivers
Goal: get replies, drive traffic, grow community.
Examples:
- "What are you building this weekend?\n\nDrop your project URL\n\nLet's drive some traffic"
- "WHAT DID YOU BUILD TODAY?\n\nDrop your URL — let's send traffic there"
- "What project have you been working on this week?\n\nDrop it here"
- "hey builders — it's the weekend\n\ndon't forget to market your product\n\nDrop it here"
- "What are you building today?\n\nDrop in the replies"
- "Share what you're building and let's connect\n\nI want to exchange ideas with more founders"
Rules:
- Short and simple — 1-2 lines max, plain language
- Always invite people to drop something (URL, project, idea)
- Max 180 characters
- No emojis

TYPE B — Manufacturing / sourcing alpha
Goal: position as insider expert, attract hardware founders and engineers.
Rules:
- Start with a short punchy hook
- Cover: lean manufacturing, SpaceX/Tesla approach, MOQ tactics, factory realities, prototyping speed, supplier red flags, lead times
- Max 220 characters
- No emojis
- Must feel like real insider knowledge, not generic advice

TYPE C — Call out / mention big accounts
Goal: get visibility from large engineering/manufacturing audiences.
Rules:
- Mention relevant large accounts: @elonmusk, @SpaceX, @Tesla, @Isar_Aerospace, or big hardware/eng founders
- Frame it as a genuine observation or question about their manufacturing approach
- Add your own short insight after the mention
- Max 200 characters
- No emojis
- Not sycophantic — founder-to-founder tone

Universal rules:
- No emojis anywhere
- Short and simple beats long and clever
- Never sound like a brand or marketing copy
- No hashtags
- Do NOT repeat recent posts
`.trim();

const SYSTEM_PROMPT_REPLIER = `
You are Konstantin from Airsup, replying on X. You've been on factory floors in Shenzhen, raised funding, know supply chains and hardware development.

Your only job is to add genuine short value to whatever someone posted. One sentence or two max.

Rules:
- Read the post and add ONE specific, useful insight, tip, or observation that actually helps
- If it's about hardware/manufacturing: share a real tactic, number, or lesson from the factory floor
- If it's about building a startup/product: add one concrete thing they might not have considered
- If it's a "drop your project" thread: reply with a short genuine reaction to what they're building
- Never be generic ("great point!", "totally agree", "this is so true")
- Never pitch Airsup unless MENTION_AIRSUP flag is set
- Never drop a link unless asked
- No emojis
- Max 200 characters
- Sound like a sharp founder, not a brand account
`.trim();

const SEED_TEMPLATES_A = [
  "What are you building this weekend?\n\nDrop your project URL\n\nLet's drive some traffic",
  "WHAT DID YOU BUILD TODAY?\n\nDrop your URL — let's send traffic there",
  "What project have you been working on this week?\n\nDrop it here",
  "hey builders — it's the weekend\n\ndon't forget to market your product\n\nDrop it here",
  "What are you building today?\n\nDrop in the replies",
  "Share what you're building and let's connect\n\nI want to exchange ideas with more founders",
  "calling all hardware founders\n\nWhat are you manufacturing or prototyping right now?\n\nDrop it below",
  "Developers, engineers, founders —\n\nWhat did you ship this week?\n\nDrop your project",
  "Want to connect with more builders and founders\n\nDrop what you're working on",
  "What's the hardest part of building your product right now?\n\nDrop it below",
];

const REPLY_TRIGGER_KEYWORDS = [
  "manufacturing", "prototype", "factory", "supplier", "hardware",
  "MOQ", "China sourcing", "sourcing", "physical product", "consumer electronics",
  "what are you building", "drop your startup", "share your project", "drop your url",
  "robotics", "deeptech", "supply chain", "contract manufacturer",
  "pcb", "injection molding", "mass production", "product development",
  "what did you build", "what did you ship", "drop your product", "drop your app",
  "founders", "builders", "buildinpublic",
];

const SEARCH_QUERIES = [
  '"what are you building" founders',
  '"drop your startup" builders',
  '"what did you build" OR "what did you ship" founders',
  "hardware prototype sourcing manufacturer",
  '"building in public" founders engineers',
  '"drop your" project url founders',
  "manufacturing prototype China supplier -spam",
  '"drop your product" OR "drop your app" builders',
];

// ── Poster ────────────────────────────────────────────────────────────────────

async function generatePost(type: string, recentPosts: string[]): Promise<string> {
  const recentContext = recentPosts.length
    ? `\n\nDo NOT repeat or closely resemble any of these recent posts:\n${recentPosts.map(p => `- "${p}"`).join("\n")}`
    : "";

  const userMessage = type === "A"
    ? `Write one Type A engagement hook post. Rotate through different themes — community builder, question, vs/poll, let's connect. Don't use the same theme as recent posts.${recentContext}`
    : type === "C"
    ? `Write one Type C post that mentions a big account like @elonmusk, @SpaceX, @Tesla, @Isar_Aerospace, or a known hardware/engineering founder. Frame it as a genuine observation or question about their manufacturing approach — not a compliment, more like a founder-to-founder take. Add your own manufacturing insight after the mention.${recentContext}`
    : `Write one Type B sourcing alpha post. Share one specific, real, insider insight about hardware manufacturing, China sourcing, supplier vetting, or prototyping. Make it feel like something only someone who's been on a factory floor would know.${recentContext}`;

  const client = getOpenAIClient();
  const msg = await client.chat.completions.create({
    model: MODEL_FAST,
    max_tokens: 300,
    messages: [
      { role: "system", content: SYSTEM_PROMPT_POSTER },
      { role: "user", content: userMessage },
    ],
  });

  return (msg.choices[0]?.message?.content ?? "").trim();
}

export async function runXPoster(): Promise<void> {
  const rotationIndex = getRotationIndex();
  const postType = POST_ROTATION[rotationIndex];
  const recentPosts = getRecentPosts();

  console.log(`[XPoster] Type ${postType} | Rotation ${rotationIndex + 1}/5`);

  let text: string | undefined;

  if (postType === "A" && Math.random() < 0.25) {
    const unused = SEED_TEMPLATES_A.filter(t => !recentPosts.some(r => r.includes(t.slice(0, 30))));
    if (unused.length > 0) {
      text = unused[Math.floor(Math.random() * unused.length)];
      console.log("[XPoster] Using seed template");
    }
  }

  if (!text) text = await generatePost(postType, recentPosts);

  console.log(`[XPoster] Post:\n${text}\n`);

  const result = await postTweet(text);
  const tweetId = result?.data?.id ?? null;
  console.log(`[XPoster] Posted! Tweet ID: ${tweetId}`);
  recordPost(text, tweetId);
}

// ── Replier ───────────────────────────────────────────────────────────────────

const MANUFACTURING_KEYWORDS = [
  "manufacturing", "factory", "supplier", "sourcing", "prototype", "hardware",
  "MOQ", "China sourcing", "supply chain", "contract manufacturer", "pcb",
  "injection molding", "mass production", "product development", "deeptech",
];

function isManufacturingTweet(text: string): boolean {
  const lower = text.toLowerCase();
  return MANUFACTURING_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

async function generateReply(tweetText: string, mentionAirsup: boolean): Promise<string> {
  const client = getOpenAIClient();
  const airsupNote = mentionAirsup
    ? `\n\nMENTION_AIRSUP: Yes — naturally weave in that with Airsup (airsup.dev) founders can 10x their sourcing speed. Keep it one sentence, founder-to-founder, not salesy.`
    : "";
  const msg = await client.chat.completions.create({
    model: MODEL_FAST,
    max_tokens: 120,
    messages: [
      { role: "system", content: SYSTEM_PROMPT_REPLIER },
      { role: "user", content: `Add short genuine value to this post (1-2 sentences max):\n\n"${tweetText}"${airsupNote}` },
    ],
  });
  return (msg.choices[0]?.message?.content ?? "").trim();
}

function isRelevant(text: string): boolean {
  const lower = text.toLowerCase();
  return REPLY_TRIGGER_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

export async function runXReplier(): Promise<void> {
  console.log("[XReplier] Scanning for reply targets...");

  const seen = new Set<string>();
  const tweets: Array<{ id: string; text: string }> = [];

  for (const query of SEARCH_QUERIES) {
    try {
      const results = await searchTweets(query, 10);
      for (const tweet of results) {
        if (!seen.has(tweet.id)) {
          seen.add(tweet.id);
          tweets.push(tweet);
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      console.warn(`[XReplier] Search error for "${query}": ${err.message}`);
    }
  }

  console.log(`[XReplier] Found ${tweets.length} unique tweets across all queries`);

  let replied = 0;
  for (const tweet of tweets) {
    if (hasRepliedTo(tweet.id)) continue;

    // Every 5th reply on a manufacturing topic → mention Airsup
    const mentionAirsup = (replied + 1) % 5 === 0 && isManufacturingTweet(tweet.text);
    const replyText = await generateReply(tweet.text, mentionAirsup);
    console.log(`[XReplier] Replying to ${tweet.id}${mentionAirsup ? " [+airsup]" : ""}:\n  > ${tweet.text.slice(0, 80)}\n  Reply: ${replyText}\n`);

    await postTweet(replyText, tweet.id);
    await new Promise(r => setTimeout(r, 2000));

    recordReply(tweet.id, replyText);
    replied++;

    if (replied >= 5) break;
  }

  console.log(`[XReplier] Done. ${replied} replies sent.`);
}
