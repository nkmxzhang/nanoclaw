---
name: add-feishu
description: Add Feishu (飞书/Lark) as a channel. Can replace other channels entirely or run alongside them. Uses WebSocket long-connection — no public URL required. Supports enterprise apps and personal developer sandbox accounts.
---

# Add Feishu Channel

This skill adds Feishu support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/feishu.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: What type of Feishu app are you using?
- **Enterprise / team app** — Custom app created in your Feishu organisation's developer console
- **Personal developer sandbox** — Feishu Open Platform free developer mode (no organisation required)

AskUserQuestion: Do you already have a Feishu App ID and App Secret?

If they have them, collect both now. If not, we'll create the app in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `feishu` is missing, add it:

```bash
git remote add feishu https://github.com/qwibitai/nanoclaw-feishu.git
```

### Merge the skill branch

```bash
git fetch feishu main
git merge feishu/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/feishu.ts` (FeishuChannel class with self-registration via `registerChannel`)
- `src/channels/feishu.test.ts` (unit tests)
- `import './feishu.js'` added to the channel barrel file `src/channels/index.ts`
- `@larksuiteoapi/node-sdk` npm dependency in `package.json`
- `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/feishu.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup — Create Feishu App

### Enterprise / team app path

1. Go to [open.feishu.cn](https://open.feishu.cn) → **Developer Console** → **Create App** → **Custom App**
2. Fill in the app name and description
3. In **Permissions & Scopes**, enable:
   - `im:message` (read messages)
   - `im:message:send_as_bot` (send messages)
   - `im:chat` (read chat info)
4. In **Event Subscriptions**, choose **"Use long-connection to receive events"** (not webhook)
5. Add event: `im.message.receive_v1`
6. In **App Release**, submit for review / publish the app (requires organisation admin approval)
7. Copy the **App ID** and **App Secret** from the **Credentials & Basic Info** page

### Personal developer sandbox path

1. Go to [open.feishu.cn](https://open.feishu.cn) → **Developer Console** → **Create App** → **Custom App**
2. The sandbox app is automatically created in your developer account — no organisation needed
3. Follow steps 3–7 above (same interface, no admin approval needed for sandbox)
4. In the **Test Users** section, manually add the accounts you want to test with

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Registration

### Add the bot and get the Chat ID

**For groups:** Add the bot to the target Feishu group (search for the app name and invite it).

**For private chat:** Open a direct message with the bot.

Send the message `/chatid` in the chat. The bot will reply with the chat's registration ID (e.g. `fs:oc_abc123` for groups, `fs:p2p_xxx` for private chat).

### Register the chat

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "fs:<chat-id>" --name "<chat-name>" --folder "feishu_main" --trigger "@${ASSISTANT_NAME}" --channel feishu --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "fs:<chat-id>" --name "<chat-name>" --folder "feishu_<group-name>" --trigger "@${ASSISTANT_NAME}" --channel feishu
```

## Phase 5: Verify

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### Test the connection

Tell the user:

> Send a message to your registered Feishu chat:
> - For main chat: Any message works
> - For non-main: @mention the bot (e.g. `@Andy hello`)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'fs:%'"`
3. App has **long-connection** selected in Event Subscriptions (not webhook)
4. Event `im.message.receive_v1` is subscribed in the Feishu console
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot not receiving group messages

Make sure the bot has been properly added to the group as a member. In enterprise apps, the bot also needs the `im:chat` permission and the app must be published.

### Personal developer sandbox — bot not responding to test users

Only users explicitly added in **Test Users** can interact with an unpublished sandbox app. Add users in the Feishu console under your app's **Test Users** section.

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `import './feishu.js'` from `src/channels/index.ts`
3. Remove `FEISHU_APP_ID` and `FEISHU_APP_SECRET` from `.env`
4. Remove Feishu registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'fs:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
