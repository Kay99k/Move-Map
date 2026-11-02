import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_VERSION,
  STORAGE_KEY,
  BACKUP_PREFIX,
  createDefaultState,
  migrateState,
  loadState,
  saveState,
  toggleTile,
  setMoveDate,
  appendMessage,
  progress,
  tokenIndex,
  daysUntil,
  boardPosition,
  boardSnapshot,
  MAX_CHAT_MESSAGES,
} from "../public/js/state.js";

// Minimal localStorage double.
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    keys: () => [...data.keys()],
  };
}

const v1Blob = {
  version: 1,
  spaces: [
    { id: "a", title: "Find a new apartment", done: true },
    { id: "b", title: "Book movers", done: false },
  ],
  tokenPos: 1,
};

test("fresh storage gives the default board", () => {
  const { state, reset } = loadState(fakeStorage());
  assert.equal(state.version, CURRENT_VERSION);
  assert.equal(state.tiles.length, 12);
  assert.equal(reset, false);
});

test("v1 -> v3: spaces become tiles, progress is kept, new fields appear", () => {
  const { state, migrated, fromVersion } = migrateState(v1Blob);
  assert.equal(migrated, true);
  assert.equal(fromVersion, 1);
  assert.equal(state.version, 3);
  assert.equal(state.tiles.length, 2);
  assert.equal(state.tiles[0].done, true);
  assert.equal(state.tiles[0].category, "Housing");
  assert.equal(state.tiles[1].category, "Logistics");
  assert.equal(state.moveDate, null);
  assert.deepEqual(state.chat, []);
  assert.equal("spaces" in state, false);
});

test("unversioned legacy blob with spaces is treated as v1", () => {
  const { spaces } = v1Blob;
  const { state, fromVersion } = migrateState({ spaces });
  assert.equal(fromVersion, 1);
  assert.equal(state.tiles.length, 2);
});

test("v2 -> v3 keeps tiles and adds moveDate/chat", () => {
  const v2 = { version: 2, tiles: [{ id: "x", title: "Set your move date", category: "Planning", done: true }] };
  const { state } = migrateState(v2);
  assert.equal(state.version, 3);
  assert.equal(state.tiles[0].done, true);
  assert.equal(state.moveDate, null);
  assert.deepEqual(state.chat, []);
});

test("migrating twice is stable (idempotent)", () => {
  const once = migrateState(v1Blob).state;
  const twice = migrateState(once);
  assert.equal(twice.migrated, false);
  assert.deepEqual(twice.state, once);
});

test("loadState backs up the old blob when it migrates", () => {
  const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(v1Blob) });
  const { migrated } = loadState(storage);
  assert.equal(migrated, true);
  const backups = storage.keys().filter((k) => k.startsWith(BACKUP_PREFIX));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(storage.getItem(backups[0])), v1Blob);
});

test("corrupt JSON falls back to default and is backed up, not lost", () => {
  const storage = fakeStorage({ [STORAGE_KEY]: "{not json" });
  const { state, reset } = loadState(storage);
  assert.equal(reset, true);
  assert.equal(state.tiles.length, 12);
  assert.equal(storage.keys().some((k) => k.startsWith(BACKUP_PREFIX)), true);
});

test("a state from a NEWER app version is not downgraded or guessed at", () => {
  const future = { version: CURRENT_VERSION + 1, tiles: [], mystery: true };
  const { state, reset } = migrateState(future);
  assert.equal(reset, true);
  assert.equal(state.version, CURRENT_VERSION);
});

test("garbage shapes never crash", () => {
  for (const bad of [null, undefined, 42, "str", [], { version: "x" }, { version: 2, tiles: "nope" }]) {
    const { state } = migrateState(bad);
    assert.equal(state.version, CURRENT_VERSION);
    assert.ok(Array.isArray(state.tiles) && state.tiles.length > 0);
  }
});

test("sanitize drops malformed chat entries and invalid dates", () => {
  const dirty = {
    version: 3,
    tiles: [{ id: "1", title: "ok", category: "Admin", done: 1 }],
    moveDate: "next friday",
    chat: [{ role: "system", content: "hack" }, { role: "user", content: "hi" }, null, { role: "assistant" }],
  };
  const { state } = migrateState(dirty);
  assert.equal(state.moveDate, null);
  assert.deepEqual(state.chat, [{ role: "user", content: "hi" }]);
  assert.equal(state.tiles[0].done, true);
});

test("save then load round-trips exactly", () => {
  const storage = fakeStorage();
  let s = createDefaultState();
  s = toggleTile(s, "t1");
  s = setMoveDate(s, "2027-01-15");
  s = appendMessage(s, "user", "what's next?");
  assert.equal(saveState(storage, s), true);
  const loaded = loadState(storage);
  assert.equal(loaded.migrated, false);
  assert.deepEqual(loaded.state, s);
});

test("saveState survives a storage failure", () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.equal(saveState(broken, createDefaultState()), false);
});

test("chat history is capped", () => {
  let s = createDefaultState();
  for (let i = 0; i < MAX_CHAT_MESSAGES + 20; i++) s = appendMessage(s, "user", `m${i}`);
  assert.equal(s.chat.length, MAX_CHAT_MESSAGES);
  assert.equal(s.chat.at(-1).content, `m${MAX_CHAT_MESSAGES + 19}`);
});

test("toggle is immutable and the token follows the first unfinished tile", () => {
  const s0 = createDefaultState();
  const s1 = toggleTile(s0, "t1");
  assert.equal(s0.tiles[0].done, false);
  assert.equal(s1.tiles[0].done, true);
  assert.equal(tokenIndex(s1), 1);
  assert.deepEqual(progress(s1), { done: 1, total: 12, percent: 8 });
  const all = { ...s0, tiles: s0.tiles.map((t) => ({ ...t, done: true })) };
  assert.equal(tokenIndex(all), -1);
  assert.equal(progress(all).percent, 100);
});

test("daysUntil counts calendar days", () => {
  const now = new Date(2026, 10, 1, 17, 0); // Nov 1 2026 local
  assert.equal(daysUntil("2026-11-04", now), 3);
  assert.equal(daysUntil("2026-11-01", now), 0);
  assert.equal(daysUntil("2026-10-30", now), -2);
  assert.equal(daysUntil(null, now), null);
});

test("board snakes: row 0 left-to-right, row 1 right-to-left", () => {
  assert.deepEqual(boardPosition(0), { row: 0, col: 0 });
  assert.deepEqual(boardPosition(3), { row: 0, col: 3 });
  assert.deepEqual(boardPosition(4), { row: 1, col: 3 });
  assert.deepEqual(boardPosition(7), { row: 1, col: 0 });
  assert.deepEqual(boardPosition(8), { row: 2, col: 0 });
});

test("boardSnapshot reflects current state for the chatbot", () => {
  let s = toggleTile(createDefaultState(), "t1");
  s = setMoveDate(s, "2026-11-11");
  const snap = boardSnapshot(s, new Date(2026, 10, 1));
  assert.equal(snap.nextTile, "Set a moving budget");
  assert.equal(snap.daysUntilMove, 10);
  assert.equal(snap.progress.done, 1);
  assert.equal(snap.tiles.length, 12);
});
