import {
  CURRENT_VERSION,
  STORAGE_KEY,
  loadState,
  saveState,
  toggleTile,
  setMoveDate,
  appendMessage,
  resetBoard,
  progress,
  tokenIndex,
  daysUntil,
  boardPosition,
  boardSnapshot,
} from "./state.js";

const $ = (id) => document.getElementById(id);
const els = {
  board: $("board"),
  fill: $("progressFill"),
  bar: $("progressBar"),
  text: $("progressText"),
  win: $("win"),
  date: $("moveDate"),
  countdown: $("countdown"),
  log: $("log"),
  sync: $("sync"),
  form: $("form"),
  input: $("input"),
  send: $("send"),
  mode: $("mode"),
  schema: $("schema"),
};

const loaded = loadState(window.localStorage);
let state = loaded.state;
let busy = false;
let lastToken = -2;

function commit(next) {
  state = next;
  saveState(window.localStorage, state);
  render();
}

// ---------- Board ----------
function renderBoard() {
  const cur = tokenIndex(state);
  const narrow = window.matchMedia("(max-width: 560px)").matches;
  els.board.innerHTML = "";
  state.tiles.forEach((tile, i) => {
    const { row, col } = boardPosition(i, 4);
    const li = document.createElement("li");
    li.className = `tile cat-${tile.category}${tile.done ? " done" : ""}${i === cur ? " current" : ""}`;
    if (!narrow) {
      li.style.setProperty("--row", row + 1);
      li.style.setProperty("--col", col + 1);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(tile.done));
    btn.setAttribute("aria-label", `${i + 1}. ${tile.title}, ${tile.category}, ${tile.done ? "done" : "not done"}`);
    btn.innerHTML = '<span class="num"></span><span class="title"></span><span class="cat"></span>';
    btn.querySelector(".num").textContent = String(i + 1);
    btn.querySelector(".title").textContent = tile.title;
    btn.querySelector(".cat").textContent = tile.category;
    btn.addEventListener("click", () => commit(toggleTile(state, tile.id)));
    li.appendChild(btn);
    if (i === cur) {
      const token = document.createElement("span");
      token.className = "token";
      token.textContent = "K";
      token.setAttribute("aria-hidden", "true");
      if (i === lastToken) token.style.animation = "none"; // only hop when the token actually moves
      li.appendChild(token);
    }
    els.board.appendChild(li);
  });
  lastToken = cur;
}

function renderProgress() {
  const p = progress(state);
  els.fill.style.width = `${p.percent}%`;
  els.bar.setAttribute("aria-valuenow", String(p.percent));
  els.text.textContent = `${p.done} of ${p.total} done`;
  els.win.hidden = p.total === 0 || p.done !== p.total;
}

function renderDate() {
  els.date.value = state.moveDate ?? "";
  const d = daysUntil(state.moveDate);
  els.countdown.textContent =
    d === null ? "" : d > 1 ? `${d} days to go` : d === 1 ? "Tomorrow" : d === 0 ? "Move day is today" : `${Math.abs(d)} day(s) ago`;
}

function renderSync() {
  const snap = boardSnapshot(state);
  els.sync.textContent = `The bot sees: ${snap.progress.done}/${snap.progress.total} done. Next: ${snap.nextTile ?? "nothing, you're finished"}.`;
}

// ---------- Chat ----------
function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
  return div;
}

function renderChat() {
  els.log.innerHTML = "";
  if (state.chat.length === 0) {
    addBubble(
      "assistant",
      "Hi, I'm K's Move Bot. I can see your board, so ask me what to do next, how to break a tile down, or whether you're on track."
    );
  }
  state.chat.forEach((m) => addBubble(m.role, m.content));
}

async function send(text) {
  const content = text.trim();
  if (!content || busy) return;
  busy = true;
  els.send.disabled = true;

  // Persist the user's turn first so a reload never loses it.
  const before = state;
  state = appendMessage(state, "user", content);
  saveState(window.localStorage, state);
  addBubble("user", content);
  els.input.value = "";
  const typing = addBubble("assistant typing", "Thinking...");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: state.chat, board: boardSnapshot(state) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    typing.remove();
    state = appendMessage(state, "assistant", data.reply);
    saveState(window.localStorage, state);
    addBubble("assistant", data.reply);
  } catch (err) {
    typing.remove();
    // Roll back the unanswered turn so history never ends with two user messages in a row.
    state = { ...state, chat: before.chat };
    saveState(window.localStorage, state);
    els.log.lastChild?.remove();
    els.input.value = content;
    addBubble("error", err.message || "Couldn't reach the assistant.");
  } finally {
    busy = false;
    els.send.disabled = false;
    els.input.focus();
  }
}

// ---------- Wiring ----------
function render() {
  renderBoard();
  renderProgress();
  renderDate();
  renderSync();
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(els.input.value);
});
$("chips").addEventListener("click", (e) => {
  const q = e.target?.dataset?.q;
  if (q) send(q);
});
els.date.addEventListener("change", () => commit(setMoveDate(state, els.date.value)));
$("resetBoard").addEventListener("click", () => {
  if (confirm("Reset every tile to not done?")) commit(resetBoard(state));
});
$("clearChat").addEventListener("click", () => {
  state = { ...state, chat: [] };
  saveState(window.localStorage, state);
  renderChat();
});
window.addEventListener("resize", () => renderBoard());

// Keep multiple open tabs in sync.
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY) return;
  state = loadState(window.localStorage).state;
  render();
  renderChat();
});

els.schema.textContent = loaded.migrated
  ? `Saved data upgraded from v${loaded.fromVersion} to v${CURRENT_VERSION}.`
  : loaded.reset
  ? "Saved data couldn't be read, so a fresh board was started (a backup was kept)."
  : `Data format v${CURRENT_VERSION}`;

fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    els.mode.textContent = h.mode === "live" ? "Live model" : "Demo mode";
    els.mode.classList.toggle("live", h.mode === "live");
  })
  .catch(() => (els.mode.textContent = "Offline"));

render();
renderChat();
