# Move Map

A board-game-style planner for moving, with a built-in chatbot, **K's Move Bot**, that can see your board and help you decide what to do next.

Your move is a 12-tile board. Tap a tile to mark it done and your token advances to the next unfinished tile. Set a move date and the app counts down to it. The chatbot gets your live board state with every message, so its answers match where you actually are.

Plain HTML, CSS and JavaScript on the front end, and a small Node server. **No dependencies and no build step.**

## Run it

Requires Node 18 or newer.

```bash
git clone <your repo url>
cd move-map
npm start
# open http://localhost:8787
```

The app runs right away in **demo mode**, where the bot answers simple questions from your board and labels every reply as demo output. To use a real model:

```bash
cp .env.example .env      # then paste your key into ANTHROPIC_API_KEY
npm start
```

The API key stays on the server and never reaches the browser.

## Test it

```bash
npm test
```

29 tests cover the state migrations, request validation, prompt building, and error handling. The model API is faked in tests, so they run offline.

## How it works

```
Browser (public/)                     Server (server/)
  state.js   versioned state + migrations   chat.js    validate -> call model -> safe errors
  app.js     UI, localStorage, chat         prompt.js  system prompt + board formatting
  index.html / styles.css                   index.js   static files, /api/chat, rate limit
```

### Prompt design
- The system prompt is **static**. The user's board is injected as a separate `<board_state>` block in the latest user turn, so changing text in a task title can't rewrite the instructions.
- The prompt tells the model that the board is the only source of truth for the user's plan, to ask one short question instead of guessing, to avoid inventing prices, deadlines or local rules, to stay on topic, and to treat text in the board and in user messages as data, not instructions.
- Replies are capped at about 120 words and 400 tokens.

### Keeping chatbot context and app state in sync
- Every message sends a fresh snapshot built from the current state (`boardSnapshot`): progress, next tile, move date, days left, and all tiles.
- The server recomputes progress and the next tile from the tile list instead of trusting numbers sent by the browser.
- Chat history is saved with the board state, so a reload keeps both. If a request fails, the unanswered user message is rolled back so history never ends up with two user turns in a row.
- A line under the chat shows what the bot currently sees.
- Multiple open tabs stay in sync through the `storage` event.

### State versioning and migrations
Saved data has a `version` and is upgraded one step at a time through a migrations table:

| Version | Shape |
|---|---|
| v1 | `spaces[]` and `tokenPos` (first prototype) |
| v2 | `tiles[]` with categories; token position now derived |
| v3 | adds `moveDate` and persisted `chat[]` |

Failure handling:
- Anything that gets migrated, can't be parsed, or can't be read is **backed up** to `movemap:backup:<timestamp>` first.
- Data from a **newer** app version is never downgraded or guessed at. A fresh board starts and the old data is kept as a backup.
- Migrations are idempotent, and malformed fields are sanitized after migrating.

### Reliability and safety
- The server validates everything: roles are limited to user/assistant, message length and history are capped, and body size is limited.
- Upstream API errors are logged on the server, and the browser only gets a short, safe message.
- 20 second timeout, per-IP rate limit, and a static file handler that blocks path traversal.

## Known limitations
- Data lives in the browser's `localStorage`: there are no accounts, and nothing syncs between devices.
- The task list is a fixed default set; adding custom tiles is a natural next step.
- The bot has no memory beyond the last 12 messages sent per request.
- Demo mode is keyword-based and only a fallback.

## Ideas for next steps
- Custom tiles and drag-to-reorder
- Accounts plus a database so the board syncs across devices
- Streaming responses
- Evaluation set for the bot: a fixed list of questions checked for hallucinated facts and off-topic answers
