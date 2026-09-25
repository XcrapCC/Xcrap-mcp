/**
 * XCrap's MCP tools, defined once.
 *
 * Two servers expose these: the stdio one in `index.js`, which people run
 * through npx, and the hosted Streamable HTTP one at https://xcrap.cc/mcp. Both
 * build their server here, so a tool's name, arguments, wording and error
 * advice cannot drift between them. The only thing each supplies is how a
 * request reaches the API: over the network for stdio, and in-process on the
 * host, where a tool call goes through the same route and the same per-IP
 * budget as the API call it wraps.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ── Constants ────────────────────────────────────────────────────────────────

export const VERSION = '1.3.0';

/**
 * Maximum characters in any single tool result.
 *
 * A tool result is spent directly out of the model's context window, so a
 * runaway 200 KB timeline is not "a big response", it is a destroyed session.
 * 25,000 characters is roughly 6k tokens: large enough for a hundred-post
 * timeline, small enough to survive several calls in one conversation.
 */
const CHARACTER_LIMIT = 25_000;


/** Mirrors config.bulkMaxUrls on the server; validated here so a bad batch never leaves the process. */
const BULK_MAX_URLS = 50;

/**
 * DEFAULT FORMAT IS MARKDOWN, NOT JSON — deliberately.
 *
 * This server exists to feed a model's context window, and XCrap's markdown
 * rendering of the same post is roughly 10x smaller than its JSON: the JSON
 * carries every null metric, every media variant, every entity offset and the
 * full provenance block, while the markdown carries the author, the timestamp,
 * the text and the numbers that a reader actually uses. Markdown is also what
 * the model can read without a parsing step. JSON stays one parameter away for
 * the cases that genuinely need field-level access (ids, media URLs, cursors).
 */
const DEFAULT_FORMAT = 'markdown';

const FormatSchema = z
  .enum(['markdown', 'json'])
  .default(DEFAULT_FORMAT)
  .describe(
    "Output format. 'markdown' (default) is compact, human-readable and costs roughly a tenth " +
      "of the tokens of the same data as JSON — prefer it for reading and summarising. Use 'json' " +
      'only when you need exact field access: numeric ids, media URLs, per-metric values, or ' +
      'provenance metadata.',
  );

// ── Input validation ─────────────────────────────────────────────────────────

/**
 * A post reference in any form XCrap accepts: a full URL on x.com, twitter.com
 * or a front-end mirror, or a bare numeric id. Validated here rather than at the
 * API so an obviously wrong argument costs zero requests and zero rate budget.
 */
const TWEET_REF_PATTERN =
  /^(?:\d{1,25}|(?:https?:\/\/)?[^/\s]*\/?(?:[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d{1,25}|i\/(?:web\/)?status\/\d{1,25})\b.*)$/;

const TweetRefSchema = z
  .string()
  .trim()
  .min(1, 'A post URL or numeric id is required')
  .max(500, 'That does not look like a post URL')
  .refine((value) => TWEET_REF_PATTERN.test(value), {
    message:
      'Not a recognisable post reference. Pass a URL such as ' +
      'https://x.com/jack/status/20 (twitter.com and mirror hosts also work) or the bare ' +
      'numeric post id, e.g. "20".',
  });

/** A handle, an @handle, or a profile URL. X handles are 1-15 word characters. */
const HandleSchema = z
  .string()
  .trim()
  .min(1, 'A handle is required')
  .max(200)
  .refine(
    (value) =>
      /^@?[A-Za-z0-9_]{1,15}$/.test(value) ||
      /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]{1,15}\/?$/i.test(value),
    {
      message:
        'Not a recognisable X handle. Pass "jack", "@jack" or "https://x.com/jack". ' +
        'Handles are 1-15 letters, digits or underscores — a display name is not a handle.',
    },
  );

// ── API errors ───────────────────────────────────────────────────────────────

/** An XCrap API error, carrying enough for the error mapper to be specific. */
export class XcrapApiError extends Error {
  constructor(status, { code = null, reason = null, message, hint = null, retryAfter = null } = {}) {
    super(message ?? `XCrap returned HTTP ${status}`);
    this.name = 'XcrapApiError';
    this.status = status;
    this.code = code;
    /** Why a post cannot be read, on a 404, when X said: `post_deleted`… */
    this.reason = reason;
    this.hint = hint;
    this.retryAfter = retryAfter;
  }
}

/**
 * Pull the error detail out of a failed response.
 *
 * XCrap answers errors in whatever format the request asked for, so a failed
 * markdown request yields a markdown error document rather than JSON. Both are
 * handled: JSON first, then the one field of the markdown rendering that
 * matters. If neither parses, the status alone still produces a useful message.
 */
export function parseErrorBody(body) {
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error;
    if (error && typeof error === 'object') {
      return {
        code: error.code ?? null,
        reason: error.reason ?? null,
        message: error.message ?? null,
        hint: error.hint ?? null,
      };
    }
  } catch {
    // Not JSON — fall through to the markdown rendering.
  }
  const message = /\*\*message\*\*:\s*(.+)/.exec(body)?.[1]?.trim() ?? null;
  const hint = /\*\*hint\*\*:\s*(.+)/.exec(body)?.[1]?.trim() ?? null;
  const code = /\*\*code\*\*:\s*(.+)/.exec(body)?.[1]?.trim() ?? null;
  const reason = /\*\*reason\*\*:\s*(.+)/.exec(body)?.[1]?.trim() ?? null;
  return { code, reason, message, hint };
}

// ── Centralised error handling ───────────────────────────────────────────────

/**
 * Turn any failure into one paragraph a model can act on.
 *
 * Every branch answers the same two questions: what went wrong, and what should
 * the caller do differently. A status code alone answers neither.
 */
function describeError(error, { subject = 'that request', transportAdvice = 'Retry once in a few seconds.' } = {}) {
  if (error?.name === 'XcrapTransportError') {
    return (
      `Error: ${error.message} ` +
      (error.timedOut
        ? 'X was probably slow to answer. Retry once; if it keeps timing out, ask for less data ' +
          '(a lower max_tweets or count, or a smaller bulk batch).'
        : transportAdvice)
    );
  }

  if (error instanceof XcrapApiError) {
    const upstream = error.message ? ` XCrap said: "${error.message}".` : '';
    switch (error.status) {
      case 400:
        return (
          `Error: XCrap rejected the arguments for ${subject}.${upstream} ` +
          'Fix the argument and retry — do not retry unchanged. Post references must be an x.com ' +
          'status URL or a numeric id; handles must be 1-15 letters, digits or underscores.'
        );
      case 404:
        // X said why (deleted, protected, suspended…): the message already
        // says it in a sentence the model can pass straight on.
        if (error.reason && error.reason !== 'unavailable') {
          return (
            `Error: ${subject} cannot be read.${upstream} ` +
            'This is final — retrying will not help. Tell the user why, in those terms.'
          );
        }
        return (
          `Error: ${subject} could not be found.${upstream} ` +
          'The post or account is deleted, suspended, private, or never existed. This is final — ' +
          'retrying will not help. Check the id or handle for a typo, or tell the user it is gone.'
        );
      case 429: {
        const wait = error.retryAfter ? `${error.retryAfter} seconds` : 'about a minute';
        return (
          `Error: rate limited by XCrap on ${subject}.${upstream} ` +
          `Wait ${wait} before calling this tool again. Budgets are per endpoint (45/min for ` +
          'posts and profiles, 15/min for threads and timelines, 6 per 5 min for bulk), so a ' +
          'different tool may still work. Prefer xcrap_bulk over many xcrap_get_tweet calls, and ' +
          'the budgets are documented at /docs. Products that need more capacity can ask about the enterprise plan: https://xcrap.cc/enterprise.'
        );
      }
      case 451:
        return (
          `Error: this account has opted out of extraction through XCrap.${upstream} ` +
          'XCrap honours that opt-out, so no tool here can return this account or its posts. ' +
          'Do not retry or work around it — tell the user the account is excluded by request.'
        );
      case 500:
        return (
          `Error: XCrap hit an internal error handling ${subject}.${upstream} ` +
          'It has been reported on their side. Retry once in a few seconds.'
        );
      case 502:
      case 503:
        return (
          `Error: XCrap could not fetch ${subject} from X right now.${upstream} ` +
          'This is usually transient. ' +
          'Retry once after a short pause. If it persists, the post may be restricted rather than ' +
          'missing.'
        );
      case 504:
        return (
          `Error: X took too long to answer for ${subject}.${upstream} ` +
          'Retry in a minute, and ask for less at a time (lower max_tweets or count).'
        );
      default:
        return (
          `Error: XCrap returned HTTP ${error.status} for ${subject}.${upstream}` +
          (error.hint ? ` ${error.hint}` : '')
        );
    }
  }

  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`);
    return `Error: invalid arguments for ${subject}. ${issues.join(' ')}`;
  }

  return `Error: unexpected failure handling ${subject}: ${error instanceof Error ? error.message : String(error)}`;
}

// ── Response shaping ─────────────────────────────────────────────────────────

/**
 * Enforce the character cap.
 *
 * Never a silent cut: the model is told that it was cut, by how much, and which
 * argument to change to get a result that fits. A truncated answer the model
 * believes is complete is worse than an error.
 */
function capLength(text, advice, reserved = 0) {
  const limit = CHARACTER_LIMIT - reserved;
  if (text.length <= limit) return text;

  const notice =
    `\n\n---\n**[TRUNCATED]** This response was cut from ${text.length.toLocaleString('en-US')} ` +
    `to ${limit.toLocaleString('en-US')} characters to protect the context window. ` +
    `The content above is incomplete — the tail is missing. ${advice}`;

  const budget = limit - notice.length;
  const head = text.slice(0, Math.max(0, budget));
  // Prefer a clean break at a line boundary rather than mid-sentence.
  const lastBreak = head.lastIndexOf('\n');
  const body = lastBreak > budget * 0.6 ? head.slice(0, lastBreak) : head;
  return body + notice;
}

/**
 * A one-line provenance footer.
 *
 * XCrap says whether the answer came from its cache in a header. Surfacing it
 * costs a few tokens and tells the model whether it is looking at live data.
 */
function provenance({ cache }) {
  if (!cache) return '';
  return `\n\n_(cache: ${cache})_`;
}

/** A successful tool result: capped text, provenance footer, nothing else. */
function ok(payload, advice) {
  // The footer is counted against the cap rather than added on top of it, so a
  // tool result can never exceed CHARACTER_LIMIT.
  const footer = provenance(payload);
  return {
    content: [{ type: 'text', text: capLength(payload.text.trim(), advice, footer.length) + footer }],
  };
}

// ── Server ───────────────────────────────────────────────────────────────────

/**
 * Build an MCP server carrying every XCrap tool.
 *
 * @param {object} options
 * @param {(path: string, options?: {method?: 'GET'|'POST', query?: object, body?: unknown})
 *   => Promise<{text: string, cache?: string|null}>} options.apiRequest
 *   Performs one API call. Throws `XcrapApiError` for a non-2xx answer, or an
 *   error named `XcrapTransportError` (with `timedOut`) when none came back.
 * @param {string} [options.transportAdvice] What to tell the model when the
 *   API could not be reached at all.
 * @param {string} [options.name]
 */
export function createServer({ apiRequest, transportAdvice, name = 'xcrap-mcp-server' }) {
  const server = new McpServer({ name, version: VERSION });

  /** A failed tool result. Reported in-band (isError) so the model can recover. */
  function fail(error, subject) {
    return { isError: true, content: [{ type: 'text', text: describeError(error, { subject, transportAdvice }) }] };
  }

  /**
   * Wrap a tool body so no handler ever needs its own try/catch and every failure
   * is mapped by the same table.
   *
   * Note on structuredContent/outputSchema: intentionally not used. Emitting the
   * structured payload alongside the text would duplicate every response in the
   * context window, which is exactly the cost this server is built to avoid. The
   * `format: "json"` parameter is the escape hatch for structured access.
   */
  function tool(subject, handler) {
    return async (args) => {
      try {
        return await handler(args);
      } catch (error) {
        return fail(error, typeof subject === 'function' ? subject(args) : subject);
      }
    };
  }

  // ── xcrap_get_tweet ──────────────────────────────────────────────────────────
  server.registerTool(
    'xcrap_get_tweet',
    {
      title: 'Get an X post',
      description: `Fetch one post (tweet) from X/Twitter by URL or numeric id, including its full text, author, timestamp, engagement metrics, attached media, poll, quoted post and community note.

Works without any X account, API key or login, and reads posts that x.com refuses to show logged-out visitors. Long-form posts are returned in full, not truncated at 280 characters.

When to use this instead of the alternatives:
  - Use this for ONE specific post. It is the cheapest tool here (45 calls/minute).
  - Use xcrap_get_thread if the post is the start or middle of a multi-post thread and you want the whole thread unrolled.
  - Use xcrap_bulk for several posts at once — it is one call instead of N and has a far larger effective budget.
  - Use xcrap_list_media if you only need the image or video files attached to the post.

Args:
  - url (string, required): post URL or bare numeric id, e.g. "https://x.com/jack/status/20", "https://twitter.com/jack/status/20" or "20".
  - signals (boolean): default false. Adds facts about the post's reach: its age, whether it is inside For You's 48-hour window, whether the author may qualify for X's new-author slot, and plain engagement ratios. These are facts from public data, not a ranking score or a prediction — say so if you relay them.
  - format ('markdown' | 'json'): default 'markdown'.

Returns (markdown): a heading with the author's name and handle, the timestamp and permalink, the post text, and a line of metrics (likes, reposts, replies, quotes, bookmarks, views). Any notice X shows on the post (for example that it may break X's rules, or that replies are turned off) is included.
Returns (json): { id, url, text, lang, created_at, created_timestamp, author{...}, metrics{likes,retweets,replies,quotes,bookmarks,views}, media[], poll, quote, replying_to, replying_to_status, community_note, possibly_sensitive, visibility, is_note_tweet, entities[], client, signals? }.

Errors: 404 means the post cannot be read and retrying will not help; the message says why when X does (deleted by its author, protected account, suspended account, withheld, removed by X, age-restricted). 451 means the author opted out of XCrap.`,
      inputSchema: {
        url: TweetRefSchema.describe(
          'Post URL or bare numeric id. Accepts x.com, twitter.com and mirror hosts, e.g. "https://x.com/jack/status/20" or "20".',
        ),
        signals: z
          .boolean()
          .default(false)
          .describe('Add descriptive reach facts (age, For You window, new-author slot, engagement ratios). Not a ranking score.'),
        format: FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tool(
      (args) => `post ${args.url}`,
      async ({ url, signals, format }) => {
        const result = await apiRequest('/v1/tweet', { query: { url, format, signals: signals || undefined } });
        return ok(result, 'Ask for this post with format="markdown" to halve the size.');
      },
    ),
  );

  // ── xcrap_get_thread ─────────────────────────────────────────────────────────
  server.registerTool(
    'xcrap_get_thread',
    {
      title: 'Unroll an X thread',
      description: `Unroll a whole X/Twitter thread from any post in it, returning every post by the original author in order as one readable document.

This is the tool for "read this thread and summarise it". Give it the link the user pasted — first post, last post or anywhere in the middle — and it reconstructs the run. Replies by other people are excluded: a thread is one author's chain, not the surrounding conversation.

When to use this instead of the alternatives:
  - Use this when the link is part of a series of connected posts, or when a single post ends mid-thought.
  - Use xcrap_get_tweet if you only want the one post the URL points at (a thread costs more: 15 calls/minute).
  - Use xcrap_get_user_tweets to read an account's recent posts generally, rather than one connected chain.

Args:
  - url (string, required): any post in the thread, as a URL or numeric id.
  - max_tweets (number, 1-100): how many posts to unroll, default 25. Lower it if a response comes back truncated.
  - format ('markdown' | 'json'): default 'markdown'.

Returns (markdown): the author heading, then every post in order with its timestamp, text and metrics.
Returns (json): { root_id, author{...}, count, truncated, tweets[ <full post objects> ] }. The 'truncated' flag is true when the thread is longer than max_tweets.

Note: threads are reconstructed from X's public data, so a very old thread may come back partial — 'truncated' and the post count tell you when that happened.`,
      inputSchema: {
        url: TweetRefSchema.describe('Any post in the thread, as a URL or numeric id.'),
        max_tweets: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe(
            'Maximum posts to unroll, 1-100 (default 25). Each post costs roughly 200-400 characters of context; lower this if the result is truncated.',
          ),
        format: FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tool(
      (args) => `the thread at ${args.url}`,
      async ({ url, max_tweets: maxTweets, format }) => {
        const result = await apiRequest('/v1/thread', { query: { url, max_tweets: maxTweets, format } });
        return ok(
          result,
          `Call xcrap_get_thread again with a lower max_tweets (you used ${maxTweets}; try ${Math.max(
          1,
          Math.floor(maxTweets / 2),
        )}) to get a complete, uncut result.`,
        );
      },
    ),
  );

  // ── xcrap_get_user ───────────────────────────────────────────────────────────
  server.registerTool(
    'xcrap_get_user',
    {
      title: 'Get an X profile',
      description: `Fetch a public X/Twitter profile by handle: display name, bio, location, website, join date, verification status, avatar and banner URLs, and follower/following/post counts.

Use this to answer "who is @x", to check whether an account exists, or to get follower counts. It returns the profile only — not the account's posts.

When to use this instead of the alternatives:
  - Use xcrap_get_user_tweets to read what the account has actually posted.
  - Use xcrap_get_tweet if you have a link to a specific post rather than an account.

Args:
  - handle (string, required): "jack", "@jack" or "https://x.com/jack". Handles are 1-15 letters, digits or underscores; a display name will not work.
  - format ('markdown' | 'json'): default 'markdown'.

Returns (markdown): name and handle heading, bio, and a table of followers, following, posts, media count, join date, verification and website.
Returns (json): { id, screen_name, name, url, description, location, website, avatar_url, banner_url, joined, verified, verified_type, protected, metrics{posts,followers,following,likes,media} }.

Errors: 404 means no such account, or it is suspended or private.`,
      inputSchema: {
        handle: HandleSchema.describe('X handle, @handle or profile URL, e.g. "jack", "@jack", "https://x.com/jack".'),
        format: FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tool(
      (args) => `the profile @${String(args.handle).replace(/^@/, '')}`,
      async ({ handle, format }) => {
        const result = await apiRequest('/v1/user', { query: { handle, format } });
        return ok(result, 'Profiles are small; if this was truncated, request format="markdown".');
      },
    ),
  );

  // ── xcrap_get_user_tweets ────────────────────────────────────────────────────
  server.registerTool(
    'xcrap_get_user_tweets',
    {
      title: 'Get an X account timeline',
      description: `Fetch a page of an account's posts, newest first, with text, timestamps and metrics for each.

This is how you answer "what has @x been posting about", "find their recent posts about Y" or "what did they say this week". Paging is cursor-based because a timeline moves while you read it: pass the next_cursor from the previous call to get the next page.

When to use this instead of the alternatives:
  - Use xcrap_get_user for the profile and follower counts instead of the posts.
  - Use xcrap_get_thread when the posts you want are one connected chain rather than a general feed.

Args:
  - handle (string, required): "jack", "@jack" or a profile URL.
  - count (number, 1-100): posts per page, default 20. Above ~40 the result is likely to be truncated.
  - cursor (string): the next_cursor from a previous call, to fetch the following page. Omit for the first page. Do not invent one.
  - exclude_replies (boolean): default true — the account's own posts only. Set false to include its replies to other people.
  - media_only (boolean): default false. Set true for only posts carrying images or video.

Returns markdown: a "Posts by @handle" heading, the post count, then each post with its timestamp, permalink, text and metrics. To page further, call xcrap_get_user_tweets again with the cursor returned by XCrap.

Costs 15 calls/minute — one call returning 50 posts is far cheaper than 50 calls to xcrap_get_tweet.`,
      inputSchema: {
        handle: HandleSchema.describe('X handle, @handle or profile URL whose timeline to read.'),
        count: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Posts to return, 1-100 (default 20). Use 10-25 for reading; higher values risk truncation.'),
        cursor: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe('Pagination cursor from a previous call. Omit for the first page; never construct one by hand.'),
        exclude_replies: z
          .boolean()
          .default(true)
          .describe("Exclude the account's replies to other people (default true). Set false to include them."),
        media_only: z
          .boolean()
          .default(false)
          .describe('Return only posts with attached images or video (default false).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tool(
      (args) => `the timeline of @${String(args.handle).replace(/^@/, '')}`,
      async ({ handle, count, cursor, exclude_replies: excludeReplies, media_only: mediaOnly }) => {
        const result = await apiRequest('/v1/user/tweets', {
          query: {
            handle,
            count,
            cursor,
            // The API reads exclude_replies as a string and treats anything but
            // the literal 'false' as true, so send the exact literal.
            exclude_replies: excludeReplies ? 'true' : 'false',
            media_only: mediaOnly ? 'true' : 'false',
            format: 'markdown',
          },
        });
        // The pagination cursor is the last line of the markdown, so a naive cut
        // would throw away the one thing needed to recover the rest of the page.
        // Lift it out first and put it in the truncation notice.
        const cursorFromPage = /^Next page: pass `cursor=(.+)`$/m.exec(result.text)?.[1] ?? null;
        return ok(
          result,
          `Call xcrap_get_user_tweets again with a lower count (you used ${count}; try ${Math.max(
          1,
          Math.floor(count / 2),
        )}), or with media_only=true, to get a complete result.` +
            (cursorFromPage
              ? ` The next page starts at cursor="${cursorFromPage}" — pass it as the cursor argument.`
              : ''),
        );
      },
    ),
  );

  // ── xcrap_search ─────────────────────────────────────────────────────────────
  server.registerTool(
    'xcrap_search',
    {
      title: 'Search X posts',
      description: `Full-text search over X/Twitter posts, with the same operators X's own search understands.

This is how you answer "what are people saying about Y", "find posts from @x about Z", "any recent posts linking to this site" or "what did @x post about the launch last week". The query is passed to X as-is, so operators work: from:nasa, to:jack, "exact phrase", -exclude, lang:en, filter:links, min_faves:100.

When to use this instead of the alternatives:
  - Use xcrap_get_user_tweets or xcrap_get_user_history to read one account's posts without a topic.
  - Use xcrap_get_trends for what is trending in general, with no query.
  - Use xcrap_get_replies for the conversation under one specific post.

Args:
  - q (string, required): the search query, operators included.
  - feed ('latest' | 'top' | 'photos' | 'videos'): 'latest' (default) for newest first, 'top' for X's most relevant, or only posts with photos or videos.
  - since (string): oldest post to match, as a date such as "2025-01-01".
  - until (string): newest post to match, as a date.
  - cursor (string): the next_cursor from a previous call, for the next page. Omit for the first page. Do not invent one.
  - format ('markdown' | 'json'): default 'markdown'.

Returns markdown: a "Search:" heading with the result count and feed, then each post with its author, timestamp, permalink, text and metrics, and a "Next page" cursor line when there is more.
Returns json: { query, feed, since, until, count, next_cursor, tweets[ <post objects> ] }.

Costs 10 calls per 15 minutes — the tightest budget here. Write one precise query with operators instead of several broad ones. A 503 means search capacity is used up for now; wait for the time it gives.`,
      inputSchema: {
        q: z.string().trim().min(1, 'A search query is required').max(500).describe('The search query, including any X search operators, e.g. "from:nasa mars".'),
        feed: z
          .enum(['latest', 'top', 'photos', 'videos'])
          .default('latest')
          .describe("'latest' (default) for newest first, 'top' for most relevant, 'photos' or 'videos' for media posts only."),
        since: z.string().trim().max(40).optional().describe('Oldest post to match, as a date: "2025-01-01" or an ISO timestamp.'),
        until: z.string().trim().max(40).optional().describe('Newest post to match, as a date: "2025-03-31" or an ISO timestamp.'),
        cursor: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe('Pagination cursor from a previous call. Omit for the first page; never construct one by hand.'),
        format: FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    tool(
      (args) => `search for "${args.q}"`,
      async ({ q, feed, since, until, cursor, format }) => {
        const result = await apiRequest('/v1/search', { query: { q, feed, since, until, cursor, format } });
        const next = /^Next page: pass `cursor=(.+)`$/m.exec(result.text)?.[1] ?? null;
        return ok(
          result,
          'Narrow the query with operators (from:, lang:, since:) or ask with format="markdown" to cut the size.' +
            (next ? ` The next page starts at cursor="${next}".` : ''),
        );
      },
    ),
  );

  // ── xcrap_get_replies ────────────────────────────────────────────────────────
  server.registerTool(
    'xcrap_get_replies',
    {
      title: 'Get the replies to an X post',
      description: `Fetch the replies under an X/Twitter post, most liked first or newest first, with the post itself on top.

This is how you answer "what are people saying about this post", "what did the replies think" or "find the strongest pushback on this". Only direct replies come back — a reply to a reply belongs to its own conversation.

When to use this instead of the alternatives:
  - Use xcrap_get_tweet if you only need the post.
  - Use xcrap_get_thread for the author's own follow-up posts; replies by other people are not a thread.

Args:
  - url (string, required): the post's URL or bare numeric id.
  - sort ('top' | 'recent'): 'top' (default) for the most liked first, 'recent' for the newest first.
  - format ('markdown' | 'json'): default 'markdown'.

Returns markdown: a "Replies to" heading, the post, then each reply with its author, timestamp, text and metrics.
Returns json: { tweet_id, tweet_url, sort, count, tweet{...}, replies[ <post objects> ] }.

There is no paging: this is the single page X serves for the post, up to about a hundred replies. Costs 15 calls/minute. A 404 means the post is deleted, private or never existed.`,
      inputSchema: {
        url: TweetRefSchema.describe('The post whose replies to read: URL or bare numeric id.'),
        sort: z
          .enum(['top', 'recent'])
          .default('top')
          .describe("'top' (default) for the most liked replies first, 'recent' for the newest first."),
        format: FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    tool(
      (args) => `the replies to ${args.url}`,
      async ({ url, sort, format }) => {
        const result = await apiRequest('/v1/replies', { query: { url, sort, format } });
        return ok(result, 'Ask for the replies with format="markdown" to cut the size.');
      },
    ),
  );

  // ── xcrap_get_followers / xcrap_get_following ────────────────────────────────
  for (const relation of ['followers', 'following']) {
    const listing = relation === 'followers' ? 'the accounts following' : 'the accounts followed by';
    server.registerTool(
      `xcrap_get_${relation}`,
      {
        title: relation === 'followers' ? 'List who follows an X account' : 'List who an X account follows',
        description: `Fetch one page of ${listing} an X/Twitter account, each with its name, handle, bio, follower count and verification.

Use this for "who follows @x", "who does @x follow", or to find the other accounts in someone's circle. X decides the page size (usually a few dozen accounts); pass next_cursor to continue, and stop when it is null.

When to use this instead of the alternatives:
  - Use xcrap_get_user for one account's own profile and follower count, rather than the list of accounts.

Args:
  - handle (string, required): "jack", "@jack" or a profile URL.
  - cursor (string): the next_cursor from a previous call. Omit for the first page. Do not invent one.
  - format ('markdown' | 'json'): default 'markdown'.

Returns markdown: a heading, then one line per account — name, handle, follower count — with its bio underneath, and a "Next page" cursor line when there is more.
Returns json: { handle, relation, count, next_cursor, users[ <profile objects> ] }.

Costs 15 calls/minute. Protected accounts return 404; accounts that opted out of XCrap are left out of the list.`,
        inputSchema: {
          handle: HandleSchema.describe(`X handle, @handle or profile URL whose ${relation} to list.`),
          cursor: z
            .string()
            .trim()
            .min(1)
            .max(2000)
            .optional()
            .describe('Pagination cursor from a previous call. Omit for the first page; never construct one by hand.'),
          format: FormatSchema,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      tool(
        (args) => `the ${relation} of @${String(args.handle).replace(/^@/, '')}`,
        async ({ handle, cursor, format }) => {
          const result = await apiRequest(`/v1/user/${relation}`, { query: { handle, cursor, format } });
          const next = /^Next page: pass `cursor=(.+)`$/m.exec(result.text)?.[1] ?? null;
          return ok(
            result,
            `Ask for the ${relation} with format="markdown" to cut the size.` +
              (next ? ` The next page starts at cursor="${next}".` : ''),
          );
        },
      ),
    );
  }

  // ── xcrap_get_user_history ───────────────────────────────────────────────────
  server.registerTool(
    'xcrap_get_user_history',
    {
      title: "Export an X account's posts",
      description: `Fetch many of an account's posts in one call — walking its timeline page by page — optionally limited to a date window.

This is for "everything @x posted in March", "their last 200 posts" or "summarise what they said about Y this year". It replaces paging xcrap_get_user_tweets yourself, and it counts as one call against its budget however many pages it walks.

When to use this instead of the alternatives:
  - Use xcrap_get_user_tweets for a quick look at the latest posts.
  - Use xcrap_get_thread for one connected chain of posts.

Args:
  - handle (string, required): "jack", "@jack" or a profile URL.
  - max_posts (number, 1-200): stop after this many posts, default 50. The API allows up to 1,000, but a result that large will not fit in a context window; narrow the dates instead.
  - since (string): oldest post to include, as a date such as "2025-01-01".
  - until (string): newest post to include, as a date.
  - include_replies (boolean): default false. Set true to include the account's replies to other people.
  - include_reposts (boolean): default false. Set true to also include posts the account reposted from others.

Returns markdown: a "Post history" heading with the count and the window, then every post with its timestamp, permalink, text and metrics.

Costs 4 calls per 5 minutes — it is the most expensive tool here, so choose the window before calling rather than calling repeatedly. It takes about a second per twenty posts, and the further back a window sits, the patchier X's timeline is — an old window can legitimately come back empty.`,
      inputSchema: {
        handle: HandleSchema.describe('X handle, @handle or profile URL whose posts to export.'),
        max_posts: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Stop after this many posts, 1-200 (default 50). Narrow since/until rather than raising this.'),
        since: z
          .string()
          .trim()
          .max(40)
          .optional()
          .describe('Oldest post to include, as a date: "2025-01-01" or an ISO timestamp.'),
        until: z
          .string()
          .trim()
          .max(40)
          .optional()
          .describe('Newest post to include, as a date: "2025-03-31" or an ISO timestamp.'),
        include_reposts: z
          .boolean()
          .default(false)
          .describe('Include posts the account reposted from other accounts. Default false: only what the account wrote.'),
        include_replies: z
          .boolean()
          .default(false)
          .describe("Include the account's replies to other people (default false)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tool(
      (args) => `the post history of @${String(args.handle).replace(/^@/, '')}`,
      async ({ handle, max_posts: maxPosts, since, until, include_replies: includeReplies, include_reposts: includeReposts }) => {
        const result = await apiRequest('/v1/user/history', {
          query: {
            handle,
            max_posts: maxPosts,
            since,
            until,
            include_replies: includeReplies ? 'true' : 'false',
            include_reposts: includeReposts ? 'true' : 'false',
            format: 'markdown',
          },
        });
        return ok(
          result,
          `Call xcrap_get_user_history again with a narrower since/until window or a lower max_posts (you used ${maxPosts}).`,
        );
      },
    ),
  );

  // ── xcrap_get_trends ─────────────────────────────────────────────────────────
  server.registerTool(
    'xcrap_get_trends',
    {
      title: 'Get X trending topics',
      description: `Fetch what is trending on X/Twitter right now: the topic or hashtag, its context line where X provides one, and its post volume.

Use this for "what is trending", "what is everyone talking about on X" or as a starting point before searching for posts on a topic. The list is live and refreshed every few minutes, so the same call twice an hour apart will legitimately return different results.

Args:
  - count (number, 1-50): how many trends, default 20.

Returns markdown: a table of rank, topic, context and post count.

Note: trends are global, not localised to a country or city. If the list comes back empty, X was not serving trends at that moment — retry in a minute rather than concluding nothing is trending.`,
      inputSchema: {
        count: z.number().int().min(1).max(50).default(20).describe('Number of trending topics to return, 1-50 (default 20).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    tool('trending topics', async ({ count }) => {
      const result = await apiRequest('/v1/trends', { query: { count, format: 'markdown' } });
      return ok(result, `Call xcrap_get_trends with a smaller count (you used ${count}).`);
    }),
  );

  // ── xcrap_list_media ─────────────────────────────────────────────────────────
  server.registerTool(
    'xcrap_list_media',
    {
      title: 'List media attached to an X post',
      description: `List every downloadable file attached to a post — photos, videos and GIFs — with type, dimensions, duration, alt text, every available quality variant, and a direct download URL for each.

Use this when the user wants the image or the video from a post rather than its text: "download the video from this tweet", "what images are in this post", "get me the alt text". The download URLs it returns stream the original file straight from X and can be handed to the user or fetched directly.

When to use this instead of the alternatives:
  - Use xcrap_get_tweet if you want the post's text and only need to know whether media exists.
  - Use this when you need the actual file URLs, resolutions or alt text.

Args:
  - url (string, required): post URL or numeric id.

Returns JSON (media metadata is field-level data, so this tool does not offer a markdown mode):
{ tweet_id, tweet_url, author, count, media: [ { id, type: "photo"|"video"|"gif", url, thumbnail_url, width, height, duration, format, alt_text, variants[ {url, container, bitrate} ], index, download_url } ] }

A post with no attachments returns count: 0 and an empty media array — that is a successful answer, not an error.`,
      inputSchema: {
        url: TweetRefSchema.describe('Post URL or bare numeric id whose attachments to list.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tool(
      (args) => `media for post ${args.url}`,
      async ({ url }) => {
        // JSON, not markdown: XCrap's markdown renderer flattens the media array,
        // and file URLs, resolutions and variants are the whole point here.
        const result = await apiRequest('/v1/media', { query: { url, format: 'json' } });
        return ok(result, 'This post carries an unusually large number of media variants; use xcrap_get_tweet for a summary instead.');
      },
    ),
  );

  // ── xcrap_bulk ───────────────────────────────────────────────────────────────
  server.registerTool(
    'xcrap_bulk',
    {
      title: 'Fetch many X posts at once',
      description: `Resolve up to ${BULK_MAX_URLS} post URLs or ids in a single call.

This is the right tool whenever you have more than two or three links. One bulk call costs one request against a 6-per-5-minutes budget, while the same posts fetched individually cost one request each against a 45-per-minute budget — and bulk runs them concurrently, so it is several times faster.

Failures are per item, not per request: one dead link in a batch of fifty returns forty-nine posts and one error entry, so a single bad URL never loses the batch.

When to use this instead of the alternatives:
  - Use this for a list of links, a set of ids extracted from a document, or a batch job.
  - Use xcrap_get_tweet for a single post — bulk uses a cheaper, lighter source and returns slightly less detail per post (no media variants or entity offsets).
  - Use xcrap_get_thread for connected posts by one author; bulk does not know they are a thread.

Args:
  - urls (string[], required): 1-${BULK_MAX_URLS} post URLs or numeric ids. Duplicates are removed by the server.

Returns markdown: a summary line of requested/succeeded/failed, then each post rendered in order, with an explicit error line for any that could not be resolved.

Errors: passing more than ${BULK_MAX_URLS} URLs is rejected before any request is made — split the list into batches of ${BULK_MAX_URLS}.`,
      inputSchema: {
        urls: z
          .array(TweetRefSchema)
          .min(1, 'Supply at least one post URL or id')
          .max(BULK_MAX_URLS, `At most ${BULK_MAX_URLS} URLs per call — split larger lists into batches`)
          .describe(
            `Post URLs or numeric ids to resolve, 1-${BULK_MAX_URLS} per call. Mixed forms are fine: ["https://x.com/jack/status/20", "20"].`,
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tool(
      (args) => `a bulk batch of ${args.urls?.length ?? 0} posts`,
      async ({ urls }) => {
        const result = await apiRequest('/v1/bulk', {
          method: 'POST',
          query: { format: 'markdown' },
          body: { urls },
        });
        return ok(
          result,
          `Split the batch: you sent ${urls.length} URLs — call xcrap_bulk twice with about ${Math.max(
          1,
          Math.ceil(urls.length / 2),
        )} each.`,
        );
      },
    ),
  );

  return server;
}
