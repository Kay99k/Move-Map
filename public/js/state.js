// Move Map state layer.
// Pure functions + an injectable storage object so it runs in the browser AND in Node tests.
//
// Persistence is versioned. Every saved blob carries `version`, and loadState() walks it
// up to CURRENT_VERSION through the MIGRATIONS table, one step at a time:
//   v1: { spaces: [{ id, title, done }], tokenPos }               (first prototype)
//   v2: { tiles:  [{ id, title, done, category }] }               (renamed, categories added, tokenPos derived)
//   v3: { tiles, moveDate, chat: [{ role, content }] }            (move date + persisted chatbot context)

export const CURRENT_VERSION = 3;
export const STORAGE_KEY = "movemap:state";
export const BACKUP_PREFIX = "movemap:backup:";
export const MAX_CHAT_MESSAGES = 50;

export const CATEGORIES = ["Planning", "Housing", "Logistics", "Admin", "Move day"];

const DEFAULT_TILES = [
  ["Set your move date", "Planning"],
  ["Set a moving budget", "Planning"],
  ["Find your new home", "Housing"],
  ["Sign the lease / close", "Housing"],
  ["Book movers or a truck", "Logistics"],
  ["Start packing non-essentials", "Logistics"],
  ["Transfer utilities and internet", "Admin"],
  ["Update your address", "Admin"],
  ["Pack an essentials box", "Logistics"],
  ["Move day", "Move day"],
  ["Unpack and set up", "Move day"],
  ["Final clean and deposit", "Move day"],
];

export function createDefaultState() {
  return {
    version: CURRENT_VERSION,
    tiles: DEFAULT_TILES.map(([title, category], i) => ({
      id: `t${i + 1}`,
      title,
      category,
      done: false,
    })),
    moveDate: null,
    chat: [],
  };
}

function guessCategory(title = "") {
  const t = title.toLowerCase();
  if (/date|budget|plan/.test(t)) return "Planning";
  if (/home|lease|house|apartment|rent|close/.test(t)) return "Housing";
  if (/address|utilit|internet|bank|dmv/.test(t)) return "Admin";
  if (/move day|unpack|clean/.test(t)) return "Move day";
  return "Logistics";
}

// Each entry upgrades a state FROM that version to the next one.
export const MIGRATIONS = {
  1: (s) => ({
    version: 2,
    tiles: (Array.isArray(s.spaces) ? s.spaces : []).map((sp, i) => ({
      id: String(sp.id ?? `t${i + 1}`),
      title: String(sp.title ?? "Untitled"),
      done: Boolean(sp.done),
      category: guessCategory(sp.title),
    })),
  }),
  2: (s) => ({
    ...s,
    version: 3,
    moveDate: null,
    chat: [],
  }),
};

// Clean up anything that survived migration but isn't well formed.
export function sanitize(s) {
  const fallback = createDefaultState();
  const tiles = Array.isArray(s.tiles)
    ? s.tiles
        .filter((t) => t && typeof t === "object")
        .map((t, i) => ({
          id: String(t.id ?? `t${i + 1}`),
          title: String(t.title ?? "Untitled").slice(0, 80),
          category: CATEGORIES.includes(t.category) ? t.category : guessCategory(t.title),
          done: Boolean(t.done),
        }))
    : [];
  const moveDate =
    typeof s.moveDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.moveDate) ? s.moveDate : null;
  const chat = Array.isArray(s.chat)
    ? s.chat
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
        .slice(-MAX_CHAT_MESSAGES)
    : [];
  return {
    version: CURRENT_VERSION,
    tiles: tiles.length ? tiles : fallback.tiles,
    moveDate,
    chat,
  };
}

// Returns { state, fromVersion, migrated, reset }.
export function migrateState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { state: createDefaultState(), fromVersion: null, migrated: false, reset: true };
  }
  // Unversioned legacy blobs from the first prototype only had `spaces`.
  let version = Number.isInteger(raw.version) ? raw.version : Array.isArray(raw.spaces) ? 1 : null;
  if (version === null || version < 1 || version > CURRENT_VERSION) {
    // Unknown or from a NEWER app version: never guess, never downgrade.
    return { state: createDefaultState(), fromVersion: version, migrated: false, reset: true };
  }
  const fromVersion = version;
  let s = raw;
  while (version < CURRENT_VERSION) {
    s = MIGRATIONS[version](s);
    version = s.version;
  }
  return { state: sanitize(s), fromVersion, migrated: fromVersion !== CURRENT_VERSION, reset: false };
}

// `storage` needs getItem/setItem (window.localStorage or a test double).
export function loadState(storage) {
  let rawText = null;
  try {
    rawText = storage.getItem(STORAGE_KEY);
  } catch {
    return { state: createDefaultState(), fromVersion: null, migrated: false, reset: true };
  }
  if (rawText == null) {
    return { state: createDefaultState(), fromVersion: null, migrated: false, reset: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    backup(storage, rawText);
    return { state: createDefaultState(), fromVersion: null, migrated: false, reset: true };
  }
  const result = migrateState(parsed);
  // Keep a copy of anything we changed or couldn't read, so a bad migration is recoverable.
  if (result.migrated || result.reset) backup(storage, rawText);
  return result;
}

export function saveState(storage, state) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false; // quota exceeded / private mode: app keeps working in memory
  }
}

function backup(storage, rawText) {
  try {
    storage.setItem(BACKUP_PREFIX + Date.now(), rawText);
  } catch {
    /* ignore */
  }
}

// ---- Board logic (all return NEW objects; nothing mutates) ----

export function toggleTile(state, id) {
  return { ...state, tiles: state.tiles.map((t) => (t.id === id ? { ...t, done: !t.done } : t)) };
}

export function setMoveDate(state, value) {
  const ok = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return { ...state, moveDate: ok ? value : null };
}

export function appendMessage(state, role, content) {
  const chat = [...state.chat, { role, content: String(content).slice(0, 2000) }].slice(-MAX_CHAT_MESSAGES);
  return { ...state, chat };
}

export function resetBoard(state) {
  return { ...state, tiles: state.tiles.map((t) => ({ ...t, done: false })) };
}

export function progress(state) {
  const total = state.tiles.length;
  const done = state.tiles.filter((t) => t.done).length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

// The token sits on the first unfinished tile. -1 means the whole board is complete.
export function tokenIndex(state) {
  return state.tiles.findIndex((t) => !t.done);
}

export function daysUntil(moveDate, now = new Date()) {
  if (!moveDate) return null;
  const [y, m, d] = moveDate.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

// Snake layout: row 0 runs left->right, row 1 right->left, and so on.
export function boardPosition(index, columns = 4) {
  const row = Math.floor(index / columns);
  const offset = index % columns;
  const col = row % 2 === 0 ? offset : columns - 1 - offset;
  return { row, col };
}

// The snapshot sent to the chatbot with every request, so the bot always sees current state.
export function boardSnapshot(state, now = new Date()) {
  const idx = tokenIndex(state);
  return {
    moveDate: state.moveDate,
    daysUntilMove: daysUntil(state.moveDate, now),
    progress: progress(state),
    nextTile: idx === -1 ? null : state.tiles[idx].title,
    tiles: state.tiles.map((t) => ({ title: t.title, category: t.category, done: t.done })),
  };
}
