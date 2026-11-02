import { SYSTEM_PROMPT, buildMessages } from "./prompt.js";

export const LIMITS = {
  maxHistory: 12, // messages sent to the model
  maxMessageChars: 1000,
  maxTiles: 40,
  maxBodyBytes: 32 * 1024,
  timeoutMs: 20000,
  maxTokens: 400,
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Validate and normalise the request body. Never trust the client.
export function validateChatRequest(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Invalid request.");
  const { messages, board } = body;

  if (!Array.isArray(messages) || messages.length === 0) throw new HttpError(400, "Send at least one message.");
  const history = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, LIMITS.maxMessageChars) }))
    .filter((m) => m.content.length > 0)
    .slice(-LIMITS.maxHistory);

  // The API requires the first turn to be a user turn and the last to be the user's new message.
  while (history.length && history[0].role !== "user") history.shift();
  if (history.length === 0 || history.at(-1).role !== "user") {
    throw new HttpError(400, "The last message must come from the user.");
  }

  if (!board || typeof board !== "object" || !Array.isArray(board.tiles)) {
    throw new HttpError(400, "Board state is missing.");
  }
  const tiles = board.tiles.slice(0, LIMITS.maxTiles).map((t) => ({
    title: String(t?.title ?? "").slice(0, 80),
    category: String(t?.category ?? "").slice(0, 20),
    done: Boolean(t?.done),
  }));
  const total = tiles.length;
  const done = tiles.filter((t) => t.done).length;
  const moveDate = typeof board.moveDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(board.moveDate) ? board.moveDate : null;
  const next = tiles.find((t) => !t.done);

  return {
    history,
    board: {
      moveDate,
      daysUntilMove: Number.isInteger(board.daysUntilMove) ? board.daysUntilMove : null,
      progress: { done, total, percent: total ? Math.round((done / total) * 100) : 0 },
      nextTile: next ? next.title : null,
      tiles,
    },
  };
}

// Clearly-labelled fallback so the app is demoable without a key. It only reads the board.
export function demoReply(history, board) {
  const q = history.at(-1).content.toLowerCase();
  const { done, total } = board.progress;
  let body;
  if (/next|what.*(do|now)|start/.test(q)) {
    body = board.nextTile
      ? `Your next tile is "${board.nextTile}". You're ${done}/${total} of the way around the board.`
      : "Every tile is done. Nothing left on the board.";
  } else if (/date|when|days|deadline|how long/.test(q)) {
    body =
      board.moveDate == null
        ? "You haven't set a move date yet. Add one at the top and I can help you pace the tiles."
        : `Your move date is ${board.moveDate}, ${board.daysUntilMove} day(s) from today.`;
  } else if (/progress|done|finished|left/.test(q)) {
    body = `${done} of ${total} tiles are done (${board.progress.percent}%).`;
  } else {
    body = `I can tell you your next tile, your progress, or your move date. Right now: ${done}/${total} done.`;
  }
  return `${body}\n\n(Demo mode: add an ANTHROPIC_API_KEY to talk to the real model.)`;
}

// fetchImpl is injectable so tests never touch the network.
export async function callModel({ history, board }, { apiKey, model, fetchImpl = fetch }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMITS.timeoutMs);
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: LIMITS.maxTokens,
        system: SYSTEM_PROMPT,
        messages: buildMessages(history, board),
      }),
    });
    if (!res.ok) {
      // Log the detail server-side; give the browser a short, safe message.
      const detail = await res.text().catch(() => "");
      console.error(`Model API ${res.status}: ${detail.slice(0, 300)}`);
      throw new HttpError(502, "The assistant is unavailable right now. Try again in a moment.");
    }
    const data = await res.json();
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new HttpError(502, "The assistant returned an empty answer. Try rephrasing.");
    return text;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.name === "AbortError") throw new HttpError(504, "The assistant took too long. Try again.");
    console.error("Model call failed:", err.message);
    throw new HttpError(502, "Couldn't reach the assistant. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }
}

export async function handleChat(body, env, deps = {}) {
  const parsed = validateChatRequest(body);
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return { reply: demoReply(parsed.history, parsed.board), mode: "demo" };
  const reply = await callModel(parsed, {
    apiKey,
    model: env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    fetchImpl: deps.fetchImpl,
  });
  return { reply, mode: "live" };
}
