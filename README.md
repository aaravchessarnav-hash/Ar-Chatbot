# AR Chatbot — backend

A small Express server that sits in front of the AR Chatbot frontend and proxies
its AI calls to OpenRouter. The point: your OpenRouter API key now lives only in
this server's `.env` file — it's never sent to the browser, so it can't be read
from the page source anymore.

## ⚠️ Rotate your old key first

The original file had this hardcoded in the client-side JavaScript:

```
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
```

Anyone who viewed that page's source (or your file, if you shared it) could
have copied that key and spent your OpenRouter credits. Before doing anything
else:

1. Go to https://openrouter.ai/keys
2. Delete/revoke that key
3. Create a fresh one and use it in the `.env` file below

## What changed

- **`server.js`** — new. Serves the frontend and exposes one endpoint,
  `POST /api/chat`, which forwards requests to OpenRouter using the key in
  `.env`. Supports both normal and streaming (`stream: true`) responses.
- **`public/index.html`** — your original app, with its 4 direct
  `fetch("https://openrouter.ai/...")` calls repointed at `/api/chat`. No other
  behavior changed — same models, same streaming, same "bring your own key"
  option in ⚙️ Settings.
- If a visitor pastes their own key into Settings, it's sent to `/api/chat`
  and used for their requests instead of the server's default key. Leave it
  blank and the server's `.env` key is used for everyone.

## Setup

```bash
cd backend
npm install
cp .env.example .env
# edit .env and paste your OpenRouter key into OPENROUTER_API_KEY
npm start
```

Then open http://localhost:3000 — the app is served from the same server, so
there's nothing else to configure.

For auto-restart on file changes during development, use `npm run dev`
instead of `npm start` (requires Node 18.11+).

## Deploying

**Option A — a real Node host (Render, Railway, Fly.io, a VPS, etc.):**

1. Set the `OPENROUTER_API_KEY` environment variable in that platform's
   dashboard (don't upload your `.env` file).
2. Set the start command to `npm start`.
3. Make sure the platform's Node version is 18 or newer.

**Option B — Netlify:** Netlify only serves static files by default — it
cannot run `server.js` as-is, so `/api/chat` and `/api/sync` will 404 on a
plain Netlify deploy. If you're hosting on Netlify, those routes need to be
converted to Netlify Functions (or hosted separately on Option A and proxied
via a `netlify.toml` redirect). Ask if you'd like that conversion done.

## Notes

- Only the AI chat calls go through this backend. The app's other integrations
  (weather, currency conversion, Wikipedia, Hacker News, etc.) call free,
  keyless public APIs directly from the browser, same as before — no secret
  to protect there, so there was nothing to move.
- Chat history, memory, and other app data still live in the browser's
  `localStorage`, exactly as before. This backend doesn't add persistence —
  it only makes the AI calls safe. Happy to add real server-side storage
  (so chats sync across devices) as a follow-up if you want it.
- A basic per-IP rate limit (60 requests/minute) is applied to `/api/chat` in
  `server.js` to stop the server's shared key from being trivially hammered.
  Adjust the `max` value there if it's too strict or too loose for your use.

## 🆕 What's new in this update: 👑 Premium is back (real payments)

Premium was previously removed entirely because the old payment flow was
broken. It's back now, rebuilt with a proper server-side security model —
here's what changed and how to turn it on.

**Two tiers, both real one-time payments (no subscriptions/auto-renewal):**
- **Level 1 — 60-Day Pass**: ad-free chat + everything unlocked, for 60
  days from the moment of purchase. Buying again while a pass is active
  stacks the extra 60 days on top instead of wasting them.
- **Level 2 — Lifetime**: pay once, Premium stays active forever — no
  renewal, ever.
- **Free (no Premium)**: works exactly as before, with one addition — an
  occasional ad banner appears in the chat (every 6 replies) with a
  "Go Premium" button. Buying either tier removes it immediately.

**Two payment providers**, matching the old setup:
- **Razorpay** — for India, charges in ₹ (INR).
- **PayPal** — for everywhere else, charges in $ (USD).
Both buttons are shown to everyone; pick whichever your bank/card supports.

### Setup

1. Get a Razorpay key pair from https://dashboard.razorpay.com/app/keys
   and a PayPal app from https://developer.paypal.com/dashboard/applications
   (use the default Sandbox app first to test with fake money, or create a
   Live app when you're ready to accept real payments).
2. Copy `.env.example` to `.env` and fill in `RAZORPAY_KEY_ID`,
   `RAZORPAY_KEY_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and
   `PAYPAL_MODE` (`sandbox` or `live`).
3. `npm install` (adds no new dependencies beyond what was already
   there — Razorpay/PayPal are called with plain `fetch`, no SDK).
4. Restart the server. Prices default to ₹149/$2.99 (60-Day) and
   ₹999/$14.99 (Lifetime); override them in `.env` if you want different
   numbers — see the commented-out lines in `.env.example`.
5. If either provider's keys are left blank, that provider's button shows
   as disabled with an explanatory tooltip instead of erroring — you can
   ship with just one configured and add the other later.

### How "who has Premium" is tracked (no accounts yet)

This app still has no login/accounts system (that's roadmap V.10). So
Premium status is tracked by an opaque **device token**: a random string
the server generates and hands to the browser, which stores it in
`localStorage` and sends it back on every request. The status itself
(tier + expiry) lives entirely in a small JSON file on the server
(`data/premium-store.json`, auto-created, git-ignored) — **never** in
anything the browser can edit.

### The bugs this closes (the "you can easily give yourself money/premium" class)

The old removed version, and the naive way to build this feature, both
have a specific, well-known hole: if "am I Premium?" is decided by
something the browser controls (a `localStorage` flag, a client-sent
`"success": true`, a client-chosen price), anyone can open devtools and
grant themselves Premium for free, or pay ₹1 for a ₹999 Lifetime plan.
This build closes that a few specific ways:

- **Price is never client-supplied.** The browser only says *which tier*
  it wants; the server looks up the price itself (`PREMIUM_PRICES` in
  `server.js`). There's no request field a client could edit to change
  what gets charged.
- **Payments are verified with the provider, not trusted from the
  browser.** Razorpay: the server checks the HMAC signature Razorpay
  signs with its secret key — something only Razorpay and this server
  can produce. PayPal: the server captures the order itself via PayPal's
  API and checks the response says `COMPLETED` at the exact price
  expected, rather than trusting the browser's "it worked" callback.
- **Each payment can only grant Premium once.** Payment/order IDs are
  recorded after use, so replaying a captured request can't grant
  Premium repeatedly.
- **Status is recomputed on every check, server-side.** A 60-Day Pass
  actually stops counting as Premium the moment the server's clock says
  it's expired — there's no cached client flag that can outlive that.

**What's still a real limitation, on purpose stated plainly:** without a
full accounts/login system, Premium is tied to a *browser/device*, not a
*person* — clearing site data creates a "new" free device (losing that
browser's Premium), and it doesn't follow you to a different browser or
phone. That's a UX gap, not a way to get Premium for free — it doesn't
let anyone bypass payment. Closing it for real means shipping accounts
(V.10 on the roadmap), which this update doesn't attempt.

### Files touched/added

- **`server.js`** — new `/api/premium/*` routes (device token, status,
  config, Razorpay order+verify, PayPal order+capture).
- **`premiumStore.js`** — new. The server-side status store described
  above.
- **`index.html`** — new 👑 Premium toolbar button + modal, in-chat ad
  banner for the Free tier, and the client-side checkout flows for both
  providers.
- **`.env.example`**, **`.gitignore`** — new.

## 🆕 What's new in this update: bigger AI model picker

- **More models** — the ⚙️ Settings model dropdown now has ~30 models instead of 7: a Free group (current `:free` OpenRouter models), provider groups (Anthropic, OpenAI, Google, xAI, DeepSeek, Qwen, Z.ai, MoonshotAI), a Vision-capable group, and a Cheapest-paid/budget group.
- **Cost + context shown per model** — each option now shows price per 1M tokens (prompt/completion) and context window right in the label, e.g. "Claude Sonnet 5 — $2/$10 per M · 1M ctx", plus a 👁️ mark for vision-capable models. No more guessing what a model costs before you pick it.
- **🔄 Refresh model list** — a button under the dropdown that pulls OpenRouter's live model catalog through a new `GET /api/models` backend route (cached 10 minutes server-side) and rebuilds the whole list with current pricing/availability. Falls back to the static list above if the fetch fails.
- **Custom model ID field** — a text box under the dropdown for pasting any OpenRouter model ID directly (e.g. one that isn't in the curated list yet). If filled in, it overrides the dropdown; clear it to go back to the dropdown's pick. Persists in `localStorage` like everything else here.
- Note: models whose *output* includes images (e.g. Nano Banana, GPT Image) are intentionally excluded from the refreshed list — this app's chat bubbles don't render image replies yet, so picking one would just show broken/garbled text.

## 🆕 What's new in this update: 📢 ArChatbot Ad

- **📢 ArChatbot Ad** — a new toolbar button opens a short, narrated slideshow that walks through everything the app can do: creating, building apps/games, memory tools, vision/exploration, Kids Zone, Fun Mode + Creator Hall, and privacy. Hit **▶️ Play Ad** to auto-advance every 5 seconds with spoken narration (using your saved voice preference), or step through manually with Prev/Next and the dots below the slide. Mute anytime with 🔊/🔈.

## 🆕 What's new in this update: 🔍 Scanners in Kids Zone

- **🔍 Scanners** — a new section inside 🧒 Kids Zone with two one-tap scanners, both reusing the app's existing 🔭 AI Vision Assistant camera:
  - **📚 Homework Scanner** — point the camera at a homework page or worksheet; the AI checks each answer and explains any mistakes in warm, encouraging, kid-friendly language, then gives a friendly score out of the total.
  - **🔲 Barcode/QR Scanner** — jumps straight into the Vision Assistant's existing barcode/QR mode (decoded locally in the browser, with an AI fallback for anything it can't auto-read).

## 🆕 What's new in this update: 🏛️ Creator Hall

- **🏛️ Creator Hall** — a new toolbar button opens a permanent hall of fame: every project you mark **✅ Complete** in 🗂️ Project Memory earns a trophy card here, showing its name, completion date, and a 🚀 Published tag if you've also published it. The first three projects you ever finish get 🥇🥈🥉 medals; every one after that gets a 🏆. Marking a project complete now also mentions the new trophy in its confirmation toast.

## 🆕 What's new in this update: 👀 AI Mascot, 🏆 Achievement Animation + 10 more achievements

- **👀 AI Mascot** — a small buddy fixed in the corner of the screen:
  - 👀 **Looks at mouse** — its eyes track your cursor wherever it goes.
  - 😊 **Changes emotion** — neutral by default, with distinct looks for other states.
  - 🤔 **Thinking animation** — bobs with a 💭 thought bubble and an "o"-shaped mouth while the AI is generating any reply, anywhere in the app.
  - 😎 **Happy when a task finishes** — pops and turns green for a couple of seconds once a reply lands, or longer during an Achievement Animation.
- **🏆 Achievement Animation** — the moment you create an app (🧩 AI App Builder) or a game (🎮 AI Game Maker), a full-screen celebration fires: fireworks, a "🏆 APP CREATED" / "🏆 GAME CREATED" card, and **+500 XP** added straight to 🕹️ Fun Mode.
- **10 more achievements** in 🕹️ Fun Mode (28 total now): 🏆 App Creator / 🏗️ Serial Builder (create 1 / 5 apps), 🎮 Game Dev / 🕹️ Arcade Master (create 1 / 5 games), 💯 Century Club / 🗣️ Conversationalist (100 / 500 messages), 🔥 Unstoppable / 🏔️ Marathoner (14 / 60-day streaks), and 🎓 Scholar / 🧙 Grandmaster (Level 15 / 20).

## 🆕 What's new in this update: 🧒 Kids Zone + Kids Mode

- **🧒 Kids Zone** — a new toolbar button opens a simplified corner of the app for kids, with two things in one modal:
  - **📝 Class Quiz Maker** — pick a subject (Math, Science, English, History, Geography, General Knowledge), a class/grade (1-10), and an optional topic, then generate a short, kid-friendly 5-question multiple-choice quiz (with an answer key) using the app's normal AI pipeline.
  - **🎮 Games & Fun** — one-tap shortcuts straight into the app's existing games and playful tools: 🎮 Game Maker, 🕹️ Fun Mode, 🔊 Sound Board, and 🦉 Word Practice.
- **🟢 Kids Mode toggle** — a switch inside Kids Zone that turns the whole app's background green and shows a permanent "🧒 Kids Mode" banner across the top, so it's obvious at a glance when the simplified kid-friendly look is active. Persists across reloads; turn it off anytime from the same switch.

## 🆕 What's new in this update: More achievements + 🌍 Growing World

- **🏆 8 new achievements** in 🕹️ Fun Mode: 🌱 Green Thumb / 🌳 Forester (complete 1 / 5 projects),
  🏛️ Architect / 🏙️ City Planner (build 1 / 5 AI tools in 🛠️ Extensions), 🌉 Connector (link 3+
  related ideas by shared tags in 🧠 Second Brain), 🌌 Explorer (unlock your 2nd island), and
  🛰️ Launchpad Ready / 🌠 Serial Publisher (publish 1 / 5 projects).
- **🌍 Growing World** — a new section inside 🕹️ Fun Mode that visualizes real progress as a
  little archipelago that grows as you use the app:
  - 🌳 Trees grow for each project you mark **✅ Complete** in 🗂️ Project Memory.
  - 🏛️ Buildings appear for each AI tool (🛠️ Extension) you build or import.
  - 🌉 Bridges connect islands once you link related ideas with matching tags in 🧠 Second Brain.
  - 🌌 New islands unlock every 3 Fun Mode levels as your skills improve, giving your world more
    room to grow.
  - 🚀 A rocket launches (with a little flight animation) the first time you hit the new
    **🚀 Publish** button on a project in 🗂️ Project Memory.

## 🆕 What's new in this update: Build Health Meter + Learning Coach

- **🩺 Build Health Meter** — a badge in 🧰 Code Studio's toolbar that gives
  an instant read on project quality: 🟢 Stable, 🟡 Needs attention, or
  🔴 Errors found. Click it for a breakdown (unbalanced brackets, unterminated
  strings, empty files, TODO/FIXME markers, and real console errors from your
  last Run). It's a pure client-side lint — no AI call — and recomputes
  automatically as you edit, run, open files, or apply an AI fix.
- **🎓 Learning Coach** — a short plain-English explainer that appears above
  the Code Studio editor after any AI-generated change: applying an 🐞 AI
  Debug fix, applying a 🧠 Smart Suggestion, or the AI Game/App Builder
  dropping in new code. It tells you what changed and which file(s) were
  touched, so you're never left guessing what the AI just did.

## 🆕 What's new in this update: Premium removed, AR Infinity added

- **👑 Premium Plans is gone completely** — the modal, the ₹100/$1.20
  payment flow (Razorpay + PayPal), the "not configured" errors, the
  backend payment routes, and everything related. If you'd previously set
  up `RAZORPAY_KEY_ID` / `PAYPAL_CLIENT_ID` etc. in `.env`, those are no
  longer used and can be removed.
- **♾️ AR Infinity added** — a new toolbar button opens a full-screen,
  pannable/zoomable network map with your **AR Infinity** hub at the
  center, connected to five live categories: 🧰 AI Tools, 🗂️ Projects,
  💬 Chats, 🗝️ Memory Vault, and 💻 Generated Files (Code Studio). Click a
  category to expand it into its actual items (pulled live from
  `localStorage` — it grows automatically as you create more of anything);
  click an item to jump straight to it (runs the tool, switches to that
  chat/project, or opens Memory Vault / Code Studio). Say "open AR
  Infinity" in the Magic Command Box, too.

## 🆕 What's new in this update

- **🕹️ Fun Mode** — click the joystick icon. A daily AI challenge (rotates
  once per day, same for everyone), an XP bar with levels (5 XP per message
  sent, 30 XP for completing the daily challenge, 100 XP per level),
  achievement badges (message counts, streaks, challenges completed,
  levels reached), a day streak counter, and unlockable themes (Neon,
  Candy, Midnight, Aurora — unlocked by leveling up, keeping a streak, or
  finishing challenges). All of it is tracked client-side in
  `localStorage` under the key `ar-chatbot-funmode` — no account needed.
- **📱 Continue on Another Device** — click the phone icon to get a QR
  code (and a 6-character backup code) for the chat you're currently in.
  Scan it — or type the code in on the other device's 📥 *Receive* tab —
  and that chat loads there as a new tab. This uses two new backend
  routes, `POST /api/sync` and `GET /api/sync/:code`, which hold the chat
  in memory for 15 minutes and then forget it; nothing is written to disk.
- **Icon cleanup** — five toolbar buttons that accidentally shared an
  emoji with another button (Export as Markdown, spoken-reply toggle,
  shareable HTML export, Settings, Second Brain) now each have their own
  distinct icon, so every one of the 65+ toolbar buttons is visually
  unique.
- **🛠️ Extensions** — click the wrench icon to build your own quick-action
  tools: a name, an emoji, and a prompt template (with an optional
  `{input}` placeholder). Running one either asks you for input first or
  drops the prompt straight into the chat box for you to review/send.
  Extensions are saved in `localStorage` (`ar-chatbot-extensions`) and
  can be shared with anyone using a copy-paste code — no account or
  server round-trip needed.
- **🖌️ Theme Creator** — click the paintbrush icon to design a theme with
  color pickers and a live preview (background, panel, accent, text,
  bubbles), save it, and it's applied immediately. Saved themes
  (`ar-chatbot-custom-themes` in `localStorage`) also show up as
  always-unlocked entries in 🕹️ Fun Mode's theme grid, and can be shared
  the same copy-paste-code way as extensions.
- **🎵 Songs** — new toolbar button (next to 🔊 Sound Board). One modal,
  three things:
  - **Find lyrics** — type an artist + song title, fetched live from the
    free, keyless `api.lyrics.ovh` API (same pattern as the app's other
    keyless integrations — weather, currency, Wikipedia, Hacker News).
    "Add to chat" drops the result into the conversation.
  - **Recommend songs** — describe a mood/genre/vibe and it's sent
    through the normal AI chat pipeline (same as ✨ Magic Tools) for a
    recommendation.
  - **Attach a song file** — pick a local audio file and add it to the
    chat as a playable message. This adds a new `audio` attachment kind
    alongside the existing image/text/binary kinds, rendered as an
    inline `<audio>` player in the message bubble.
  - Note: the app's existing 📎 attachment button (next to the message
    box) is unchanged — it still handles photos and text/binary files
    exactly as before. Audio attachments go through the new 🎵 Songs
    modal specifically.

## 🚀 Roadmap

Where this could go from here, roughly in order:

- **V.10 — Accounts & Cloud Sync**: user accounts + auth, chats and settings
  synced to the server instead of only living in browser `localStorage`.
- **V.11 — Memory & AI Agents**: persistent long-term memory across
  conversations, plus agent-style tool use (the AI taking multi-step actions
  on your behalf, not just replying).
- **V.12 — Voice + Vision**: voice input/output, and image understanding so
  the chatbot can see and discuss images, not just text.
- **V.13 — AI Studio**: a workspace for building and customizing your own
  bots/personas/workflows on top of the platform.
- **V.14 — Collaboration**: shared chats, workspaces, and multi-user access
  so teams (not just individuals) can use it together.
- **V.15 — Mobile app + Desktop app + polished AI platform**: native
  mobile/desktop clients wrapping the same backend, with the whole thing
  polished into a cohesive product.

Each stage builds on the one before it — V.10's accounts/sync is really the
foundation V.11+ needs (memory and collaboration both require knowing who's
talking, and where their data lives).

