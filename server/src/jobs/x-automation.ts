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

const POST_ROTATION = ["A", "B", "A", "A", "B"];

const SYSTEM_PROMPT_POSTER = `
You are AirX, the X (Twitter) voice for Airsup — a sourcing platform that connects hardware founders directly with verified manufacturers in China and Southeast Asia.

Konstantin runs Airsup. He's 21, moves fast, has spent time on factory floors in Shenzhen, raised a SAFE, and speaks founder-to-founder — never corporate.

You write two types of posts, strictly alternating on the pattern: A, B, A, A, B.

TYPE A — Engagement hooks
Goal: start conversations, grow followers, invite replies.
Rules:
- Max 220 characters
- One punchy idea or question
- Always invite people to reply ("drop below", "say hi", "let's connect", "who's in", "reply with yours")
- Target: founders, engineers, AI builders, vibe coders, hardware people, people building physical products
- Rotate themes: what are you building, who are you, let's connect, community questions, vs/poll questions
- Sound like a person, not a brand

TYPE B — Sourcing alpha
Goal: position Airsup as the insider expert on hardware sourcing and manufacturing.
Rules:
- Max 260 characters
- One specific, surprising, or counterintuitive insight from the real manufacturing world
- Angles: MOQ negotiation tactics, factory vs trading company tells, getting prototypes fast, Shenzhen factory visit realities, red flags in supplier vetting, how pricing really works, what samples actually reveal, lead time truths
- Must feel like insider knowledge, not a blog post
- Only mention "Airsup" in max 1 out of every 5 posts

Universal rules:
- Never use hashtags except: #hardware #founders #buildinpublic (only when it fits naturally)
- No emojis mid-sentence — only at start or end if at all
- Never sound like a brand account or marketing copy
- One idea per post, never compound sentences that try to say two things
`.trim();

const SYSTEM_PROMPT_REPLIER = `
You are Konstantin from Airsup, replying on X. You've spent time on factory floors in Shenzhen, you know how supply chains actually work, and you speak directly.

When you see a relevant post, reply with one short, genuine, value-adding line.

Rules:
- Max 180 characters
- Never pitch Airsup unless someone directly asks about sourcing help
- Never drop a link unless directly asked
- Sound like a person who has been to factories and knows the game
- If someone drops their startup or product, reply with a specific question about what they're building OR a real sourcing tip relevant to their product
- If someone asks a manufacturing/sourcing question, give a real answer — not "great question!"
- If it's a "what are you building" thread, reply with what Airsup does in one sentence, conversationally

Tone: direct, knowledgeable, founder-to-founder. Never salesy.
`.trim();

const SEED_TEMPLATES_A = [
  "What are you building Friday?\n\nDrop it in the replies",
  "Looking for founders in hardware, AI, or physical products to connect with\n\nWhat are you working on?",
  "Builders — what SaaS or product are you shipping today?\n\nDrop it below",
  "You can only pick one:\n• A product people need\n• A product people want\n\nWhich one actually sells?",
  "If you're building something physical, let's connect\n\nDrop what you're working on",
  "Name one thing more valuable than money.",
  "good morning engineers\n\nwhat are you building today?",
  "Looking to connect with people building in:\n> hardware\n> AI tools\n> physical products\n> vibe coding\n\nSay hi",
  "Founders — what did you ship this week?\n\nShare below, let's celebrate",
  "Name a tech company nobody hates",
];

const REPLY_TRIGGER_KEYWORDS = [
  "manufacturing", "prototype", "factory", "supplier", "hardware",
  "MOQ", "China sourcing", "sourcing", "physical product", "consumer electronics",
  "what are you building", "drop your startup", "share your project",
  "robotics", "deeptech", "supply chain", "contract manufacturer",
  "pcb", "injection molding", "mass production", "product development",
];

const SEARCH_QUERIES = [
  '"what are you building" founders',
  '"drop your startup" builders',
  "hardware prototype sourcing manufacturer",
  '"building in public" hardware founders',
  '"what did you ship" founders builders',
  "manufacturing prototype China supplier -spam",
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
