# add-feishu Design Spec

**Date:** 2026-04-21  
**Skill type:** Feature skill (branch-based)  
**Target repo:** `nanoclaw-feishu` (new, mirrors `nanoclaw-telegram` structure)

---

## Overview

Add Feishu (飞书/Lark) as a NanoClaw channel. Uses the official `@larksuiteoapi/node-sdk` with WebSocket long-connection mode — no public URL required. Supports enterprise apps and personal developer sandbox accounts. Full media support: text, image, file, audio/voice (with transcription via existing `transcribeAudio`).

---

## Architecture

### New files in `nanoclaw-feishu` repo (merged via skill branch)

| File | Purpose |
|------|---------|
| `src/channels/feishu.ts` | `FeishuChannel` class implementing `Channel` interface |
| `src/channels/feishu.test.ts` | Unit tests (~35), mocking `@larksuiteoapi/node-sdk` |

### New files in `nanoclaw` main repo (on `main`, always available)

| File | Purpose |
|------|---------|
| `.claude/skills/add-feishu/SKILL.md` | 5-phase interactive setup skill |

### Modified files (in `nanoclaw-feishu` repo, applied on merge)

| File | Change |
|------|--------|
| `src/channels/index.ts` | Append `import './feishu.js'` |
| `package.json` | Add `@larksuiteoapi/node-sdk` dependency |
| `.env.example` | Add `FEISHU_APP_ID`, `FEISHU_APP_SECRET` |

### Connection mode

`WSClient` from `@larksuiteoapi/node-sdk` — WebSocket long-connection. The SDK handles token acquisition, refresh, reconnection, and event dispatch automatically. No webhook infrastructure needed.

### Auto-enable logic

Consistent with all other channels: `FeishuChannel` initialises only when both `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are present in the environment. If missing, `registerChannel` factory returns `null` and logs a warning.

---

## JID Scheme

| Feishu chat type | Feishu native ID | NanoClaw JID |
|-----------------|-----------------|-------------|
| Group chat | `oc_xxxxxxxx` | `fs:oc_xxxxxxxx` |
| P2P (direct message) | `p2p_xxxxxxxx` | `fs:p2p_xxxxxxxx` |

- **`ownsJid(jid)`**: `return jid.startsWith('fs:')`
- **Inbound**: `event.message.chat_id` from `im.message.receive_v1` event → prefix with `fs:`
- **Outbound**: strip `fs:` prefix → pass as `chat_id` to `client.im.message.create()`

### `/chatid` equivalent

Feishu has no native bot command system. The channel recognises the literal text `/chatid` as a message, and replies with the current chat's JID (`fs:<chat_id>`). Semantically identical to Telegram's `/chatid` command.

---

## Message Type Handling

### Inbound

| `msg_type` | Handling |
|-----------|---------|
| `text` | Parse JSON content, extract `text` field; detect `@mention` entities for trigger injection |
| `post` | Walk rich-text content blocks, concatenate all `text` segments; same `@mention` handling |
| `image` | Download via `downloadFeishuResource()` → `[Image] (/workspace/group/attachments/xxx.jpg)` |
| `file` | Download → `[File: filename] (path)` |
| `audio` | Download `.opus` → `transcribeAudio()` (ffmpeg handles format) → `[Voice: transcript]` or `[Voice message - transcription failed]` |
| `sticker` | Placeholder: `[Sticker]` |
| other | Placeholder: `[Unsupported message type: xxx]` |

### @mention → trigger injection

At `connect()` time, fetch the bot's own `open_id` via the Bot Info API (`GET /open-apis/bot/v3/info`, wrapped in the SDK). For each inbound message: if any `mention` entity matches the bot's `open_id` and the content doesn't already match `TRIGGER_PATTERN`, prepend `@${ASSISTANT_NAME} ` to the content. Identical logic to `telegram.ts`.

### File download

Feishu files cannot be fetched via plain URL — they require authenticated API calls:

```
client.im.messageResource.get({ message_id, file_key, type }) → Readable stream
```

Encapsulated as private `downloadFeishuResource(messageId, fileKey, type, destPath): Promise<string | null>`. Returns container-relative path `/workspace/group/attachments/<filename>` on success, `null` on failure.

### Outbound

Send as `msg_type: 'text'` via `client.im.message.create({ chat_id, msg_type: 'text', content: JSON.stringify({ text }) })`. Messages exceeding 4000 characters are split into sequential sends — same pattern as Telegram's 4096-char limit handling.

---

## SKILL.md Structure (5 phases)

### Phase 1: Pre-flight
- Check if `src/channels/feishu.ts` already exists (skip to Phase 3 if so)
- `AskUserQuestion`: enterprise app or personal developer sandbox?
- `AskUserQuestion`: already have App ID / App Secret?

### Phase 2: Apply Code Changes
```bash
git remote add feishu https://github.com/qwibitai/nanoclaw-feishu.git
git fetch feishu main
git merge feishu/main || { git checkout --theirs package-lock.json; git add package-lock.json; git merge --continue; }
npm install
npm run build
npx vitest run src/channels/feishu.test.ts
```

### Phase 3: Setup — Create Feishu App

**Enterprise path** (Feishu org with admin access):
1. Go to [open.feishu.cn](https://open.feishu.cn) → Create custom app
2. Enable permissions: `im:message`, `im:message:send_as_bot`, `im:chat`
3. Event Subscriptions → select "Use long-connection to receive events"
4. Subscribe to event: `im.message.receive_v1`
5. Publish the app
6. Write `FEISHU_APP_ID` and `FEISHU_APP_SECRET` to `.env`

**Personal developer sandbox path**:
1. Go to [open.feishu.cn/app](https://open.feishu.cn/app) → developer sandbox
2. Same permissions and event subscription steps
3. Manually add test users in the sandbox console
4. Write credentials to `.env`

Both paths end with:
```bash
mkdir -p data/env && cp .env data/env/env
```

### Phase 4: Registration
- Add bot to target group (or start P2P chat)
- Send `/chatid` — bot replies with `fs:oc_xxx` or `fs:p2p_xxx`
- Register:
```bash
# Main chat (no trigger required)
npx tsx setup/index.ts --step register \
  --jid "fs:<chat-id>" --name "<name>" \
  --folder "feishu_main" --trigger "@${ASSISTANT_NAME}" \
  --channel feishu --no-trigger-required --is-main

# Additional group (trigger required)
npx tsx setup/index.ts --step register \
  --jid "fs:<chat-id>" --name "<name>" \
  --folder "feishu_<name>" --trigger "@${ASSISTANT_NAME}" \
  --channel feishu
```

### Phase 5: Verify
- `npm run build` + restart service
- Send test message; confirm response
- Troubleshooting: missing permissions, event not subscribed, bot not in group

---

## Unit Tests (~35 tests)

| Group | Scenarios |
|-------|----------|
| `connect()` | WSClient starts, bot open_id fetched |
| Text messages | Registered group delivers, unregistered skips, @mention injects trigger |
| `post` rich text | Multi-block content concatenated to plain text |
| Media messages | image / file / audio each call `downloadFeishuResource` |
| Voice transcription | Success → `[Voice: transcript]`, failure → `[Voice message - transcription failed]` |
| `sendMessage()` | Normal send, oversized message splits, uninitialized bot warns |
| `ownsJid()` | Matches `fs:` prefix, rejects others |
| `setTyping()` | Calls Feishu chat action |
| `registerChannel` | Initialises with env vars present, returns null when absent |

---

## Removal

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `import './feishu.js'` from `src/channels/index.ts`
3. Remove `FEISHU_APP_ID`, `FEISHU_APP_SECRET` from `.env`
4. Remove Feishu registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'fs:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild and restart
