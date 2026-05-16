import crypto from "crypto";

const BASE_URL = "https://api.twitter.com/2";

function oauthHeader(method: string, url: string, creds: {
  apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const sortedKeys = Object.keys(oauthParams).sort();
  const paramString = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join("&");

  const sigBase = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramString)].join("&");
  const signingKey = `${encodeURIComponent(creds.apiSecret)}&${encodeURIComponent(creds.accessTokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(sigBase).digest("base64");

  oauthParams.oauth_signature = signature;

  return "OAuth " + Object.entries(oauthParams)
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
    .join(", ");
}

function getCreds() {
  return {
    apiKey: process.env.X_API_KEY!,
    apiSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  };
}

export async function postTweet(text: string, replyToId?: string): Promise<any> {
  const creds = getCreds();
  const url = `${BASE_URL}/tweets`;
  const body: any = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };

  const auth = oauthHeader("POST", url, creds);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X API error ${res.status}: ${err}`);
  }
  return res.json();
}

export async function searchTweets(query: string, maxResults = 10): Promise<Array<{ id: string; text: string }>> {
  const params = new URLSearchParams({
    query: `${query} -is:retweet lang:en`,
    max_results: String(maxResults),
    "tweet.fields": "author_id,created_at,text",
  });

  const res = await fetch(`${BASE_URL}/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X search error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.data || [];
}
