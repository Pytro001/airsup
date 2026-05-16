import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getAnthropicClient } from "../services/anthropic.js";
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
Goal: get replies, drive traffic, grow community. Model these exactly:
- "What are you building this weekend?\n\nDrop your project URL 👇\n\nLet's drive some traffic"
- "WHAT DID YOU BUILD TODAY?\n\nDrop your URL — let's send traffic there 👇"
- "Morning devs 👋\n\nDrop your apps / products / SaaS / websites below"
- "What project have you been working on this week?\n\nDrop it here 👇"
- "hey builders — it's the weekend\n\ndon't forget to market your product\n\nDrop it here 👇"
- "What are you building today 😁?\n\nDrop in the replies"
- "Share what you're building and let's connect 🤝\n\nI want to exchange ideas with more founders"
Rules:
- Short punchy opener (all caps sometimes), then blank line, then CTA
- Use 1-2 emojis max, only at end of lines
- Always invite people to drop something (URL, project, idea)
- Max 220 characters

TYPE B — Manufacturing / sourcing alpha
Goal: position as insider expert, attract hardware founders and engineers.
Rules:
- Start with a strong hook (1 short punchy line)
- Sometimes use a list format:\n- point 1\n- point 2\n- point 3
- Cover: lean manufacturing, how SpaceX achieves it, MOQ tactics, factory realities, prototyping speed, supplier red flags, lead time truths
- Reference real companies/people when relevant: SpaceX, Tesla, Elon Musk, @elonmusk, Isar Aerospace — to attract their followers
- Max 280 characters
- Must feel like real insider knowledge

TYPE C — Call out / mention big accounts
Goal: get visibility from large engineering/manufacturing audiences.
Rules:
- Mention relevant large accounts: @elonmusk, @SpaceX, @Tesla, @IHSMarkit, @Isar_Aerospace, or big hardware/eng founders
- Frame it as a genuine observation, question, or compliment about their manufacturing approach
- Add your own insight or question after the mention
- Max 240 characters
- Not sycophantic — founder-to-founder tone

Universal rules:
- Never sound like a brand or marketing copy
- Never use hashtags unless: #hardware #buildinpublic #founders (only if it fits naturally)
- Do NOT repeat recent posts
`.trim();

const SYSTEM_PROMPT_REPLIER = `
You are Konstantin from Airsup, replying on X. You've been on factory floors in Shenzhen, know how supply chains work, speak directly.

Rules:
- Max 180 characters
- If it's a "what are you building" / "drop your project" thread — reply enthusiastically, ask what they're building or give a quick genuine compliment
- If someone is building hardware or a physical product — reply with a specific, useful sourcing or manufacturing tip
- If someone asks about manufacturing/sourcing — give a real answer, not "great question!"
- Never pitch Airsup unless directly asked
- Never drop a link unless asked
- Sound like a knowledgeable founder, not a brand

Tone: direct, energetic, founder-to-founder.
`.trim();

const SEED_TEMPLATES_A = [
  "What are you building this weekend?\n\nDrop your project URL 👇\n\nLet's drive some traffic",
  "WHAT DID YOU BUILD TODAY?\n\nDrop your URL — let's send traffic there 👇",
  "Morning devs 👋\n\nDrop your apps / products / SaaS / websites below",
  "What project have you been working on this week?\n\nDrop it here 👇",
  "hey builders — it's the weekend\n\ndon't forget to market your product\n\nDrop it here 👇",
  "What are you building today 😁?\n\nDrop in the replies",
  "Share what you're building and let's connect 🤝\n\nI want to exchange ideas with more founders and builders",
  "calling all hardware founders 👋\n\nWhat are you manufacturing or prototyping right now?\n\nDrop it below",
  "Developers, engineers, founders —\n\nWhat did you ship this week?\n\nDrop your project 👇",
  "Want to connect with more builders and founders\n\nDrop what you're working on and let's exchange ideas 🤝",
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
    : `Write one Type B sourcing alpha post. Share one specific, real, insider insight about hardware manufacturing, China sourcing, supplier vetting, or prototyping. Make it feel like something only someone who's been on a factory floor would know.${recentContext}`;

  const client = getAnthropicClient();
  const msg = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 300,
    system: SYSTEM_PROMPT_POSTER,
    messages: [{ role: "user", content: userMessage }],
  });

  return (msg.content[0] as any).text.trim();
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

async function generateReply(tweetText: string): Promise<string> {
  const client = getAnthropicClient();
  const msg = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 120,
    system: SYSTEM_PROMPT_REPLIER,
    messages: [{ role: "user", content: `Reply to this tweet with one short, genuine line:\n\n"${tweetText}"` }],
  });
  return (msg.content[0] as any).text.trim();
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
      const results = await searchTweets(query, 5);
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

  console.log(`[XReplier] Found ${tweets.length} candidate tweets`);

  let replied = 0;
  for (const tweet of tweets) {
    if (hasRepliedTo(tweet.id)) continue;
    if (!isRelevant(tweet.text)) continue;

    const replyText = await generateReply(tweet.text);
    console.log(`[XReplier] Replying to ${tweet.id}:\n  > ${tweet.text.slice(0, 80)}\n  Reply: ${replyText}\n`);

    await postTweet(replyText, tweet.id);
    await new Promise(r => setTimeout(r, 2000));

    recordReply(tweet.id, replyText);
    replied++;

    if (replied >= 5) break;
  }

  console.log(`[XReplier] Done. ${replied} replies sent.`);
}
