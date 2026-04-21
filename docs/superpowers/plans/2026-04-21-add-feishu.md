# add-feishu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Feishu (飞书/Lark) as a NanoClaw channel using WebSocket long-connection, with full support for text, image, file, and audio/voice messages.

**Architecture:** `FeishuChannel` implements the `Channel` interface and self-registers via `registerChannel()` — identical pattern to `telegram.ts`. It uses `@larksuiteoapi/node-sdk`'s `WSClient` for real-time event reception (no public URL required) and the `Client` for REST API calls (send message, file download, bot info). JIDs are prefixed `fs:` (e.g. `fs:oc_xxx` for groups, `fs:p2p_xxx` for DMs).

**Tech Stack:** `@larksuiteoapi/node-sdk`, Vitest (test), TypeScript ESM, existing `transcribeAudio` for voice.

**Spec:** `docs/superpowers/specs/2026-04-21-add-feishu-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/channels/feishu.ts` | `FeishuChannel` class + `registerChannel` factory |
| Create | `src/channels/feishu.test.ts` | Unit tests, mocking `@larksuiteoapi/node-sdk` |
| Modify | `src/channels/index.ts` | Append `import './feishu.js'` |
| Modify | `package.json` | Add `@larksuiteoapi/node-sdk` |
| Modify | `.env.example` | Add `FEISHU_APP_ID`, `FEISHU_APP_SECRET` |
| Create | `.claude/skills/add-feishu/SKILL.md` | 5-phase interactive setup skill |

---

## Task 1: Branch, dependency, and barrel import

**Files:**
- Modify: `package.json`
- Modify: `src/channels/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Create the skill branch**

```bash
git checkout -b skill/feishu
```

- [ ] **Step 2: Install the SDK**

```bash
npm install @larksuiteoapi/node-sdk
```

Expected: `package.json` and `package-lock.json` updated with `@larksuiteoapi/node-sdk`.

- [ ] **Step 3: Add barrel import**

In `src/channels/index.ts`, append after the telegram import:

```typescript
// feishu
import './feishu.js';

// telegram
import './telegram.js';
```

(Keep the `// feishu` comment — it matches the pattern of other commented-out channels in the file.)

- [ ] **Step 4: Add env example entries**

In `.env.example`, append:

```
# Feishu channel (optional)
FEISHU_APP_ID=
FEISHU_APP_SECRET=
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/channels/index.ts .env.example
git commit -m "feat: add @larksuiteoapi/node-sdk and feishu barrel import"
```

---

## Task 2: FeishuChannel skeleton + registerChannel

Create the class with all interface methods stubbed so TypeScript compiles, plus the factory. Tests verify the factory's env-var guard and `ownsJid`.

**Files:**
- Create: `src/channels/feishu.ts`
- Create: `src/channels/feishu.test.ts`

- [ ] **Step 1: Write failing tests for skeleton behaviour**

Create `src/channels/feishu.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Hoisted mocks (must be declared before vi.mock calls) ---

const mockRequest = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { bot: { open_id: 'ou_bot123' } } }),
);
const mockMessageCreate = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockMessageResourceGet = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockWsStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const capturedHandlers = vi.hoisted(
  () => ({} as Record<string, (data: unknown) => Promise<void>>),
);

// --- Module mocks ---

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(() => ({
    request: mockRequest,
    im: {
      message: { create: mockMessageCreate },
      messageResource: { get: mockMessageResourceGet },
    },
  })),
  WSClient: vi.fn().mockImplementation(() => ({
    start: mockWsStart,
  })),
  EventDispatcher: vi.fn().mockImplementation(() => ({
    register: vi.fn().mockImplementation(
      (handlers: Record<string, (data: unknown) => Promise<void>>) => {
        Object.assign(capturedHandlers, handlers);
        return { register: vi.fn() };
      },
    ),
  })),
  LogLevel: { error: 'error' },
}));

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/test-groups/${folder}`),
}));
vi.mock('../transcription.js', () => ({
  transcribeAudio: vi.fn().mockResolvedValue('hello world'),
}));

// --- Test helpers ---

import fs from 'fs';
import { Readable, Writable } from 'stream';
import { FeishuChannel } from './feishu.js';
import { registerChannel } from './registry.js';
import { transcribeAudio } from '../transcription.js';

const makeOpts = () => ({
  onMessage: vi.fn(),
  onChatMetadata: vi.fn(),
  registeredGroups: vi.fn(() => ({
    'fs:oc_abc123': {
      name: 'Test Group',
      folder: 'feishu_test',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00Z',
    },
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(capturedHandlers).forEach((k) => delete capturedHandlers[k]);
  mockRequest.mockResolvedValue({ data: { bot: { open_id: 'ou_bot123' } } });
  mockMessageCreate.mockResolvedValue({});
  mockMessageResourceGet.mockResolvedValue(null);
  mockWsStart.mockResolvedValue(undefined);
});

// --- registerChannel factory ---

describe('registerChannel factory', () => {
  it('registers under the name "feishu"', async () => {
    await import('./feishu.js');
    expect(registerChannel).toHaveBeenCalledWith('feishu', expect.any(Function));
  });
});

// --- ownsJid ---

describe('ownsJid', () => {
  it('returns true for fs: prefixed JIDs', () => {
    const ch = new FeishuChannel('id', 'secret', makeOpts());
    expect(ch.ownsJid('fs:oc_abc123')).toBe(true);
    expect(ch.ownsJid('fs:p2p_abc123')).toBe(true);
  });

  it('returns false for other prefixes', () => {
    const ch = new FeishuChannel('id', 'secret', makeOpts());
    expect(ch.ownsJid('tg:123')).toBe(false);
    expect(ch.ownsJid('wa:123@s.whatsapp.net')).toBe(false);
    expect(ch.ownsJid('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (module not found)**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | tail -20
```

Expected: error — `Cannot find module './feishu.js'`

- [ ] **Step 3: Create the skeleton `src/channels/feishu.ts`**

```typescript
import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private appId: string;
  private appSecret: string;
  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private botOpenId = '';
  private opts: FeishuChannelOpts;

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
    this.client = new lark.Client({
      appId,
      appSecret,
      logLevel: lark.LogLevel.error,
    });
  }

  async connect(): Promise<void> {
    // TODO: implement in Task 3
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // TODO: implement in Task 8
  }

  isConnected(): boolean {
    return this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient = null;
      logger.info('Feishu WebSocket client stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu does not expose a typing indicator API for bots
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set — channel disabled');
    return null;
  }
  return new FeishuChannel(appId, appSecret, opts);
});
```

- [ ] **Step 4: Run tests — should pass**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Build to confirm no TypeScript errors**

```bash
npm run build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat: add FeishuChannel skeleton with registerChannel and ownsJid"
```

---

## Task 3: `connect()` — WebSocket long-connection + bot info

`connect()` fetches the bot's `open_id` (needed for @mention detection later), creates the `WSClient`, and starts the long-connection.

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Add failing tests for `connect()`**

Add to `src/channels/feishu.test.ts` (append inside the file, before the last closing):

```typescript
// --- connect() ---

describe('connect()', () => {
  it('fetches bot open_id and starts WSClient', async () => {
    const ch = new FeishuChannel('myAppId', 'mySecret', makeOpts());
    await ch.connect();

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/open-apis/bot/v3/info' }),
    );
    expect(mockWsStart).toHaveBeenCalledOnce();
    expect(ch.isConnected()).toBe(true);
  });

  it('registers im.message.receive_v1 event handler', async () => {
    const ch = new FeishuChannel('myAppId', 'mySecret', makeOpts());
    await ch.connect();

    expect(capturedHandlers['im.message.receive_v1']).toBeTypeOf('function');
  });

  it('continues if bot info fetch fails', async () => {
    mockRequest.mockRejectedValueOnce(new Error('network error'));
    const ch = new FeishuChannel('myAppId', 'mySecret', makeOpts());
    await expect(ch.connect()).resolves.not.toThrow();
    expect(ch.isConnected()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | grep -E "FAIL|PASS|✓|✗|×" | head -20
```

Expected: the three new `connect()` tests fail.

- [ ] **Step 3: Implement `connect()` in `feishu.ts`**

Replace the `connect()` stub:

```typescript
async connect(): Promise<void> {
  // Fetch bot's own open_id for @mention detection
  try {
    const resp = await this.client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
      data: {},
      params: {},
    });
    this.botOpenId = (resp as any)?.data?.bot?.open_id ?? '';
    logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info fetched');
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch Feishu bot info — @mention injection disabled');
  }

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      try {
        await this.handleInboundMessage(data);
      } catch (err) {
        logger.error({ err }, 'Error processing Feishu inbound message');
      }
    },
  });

  this.wsClient = new lark.WSClient({ appId: this.appId, appSecret: this.appSecret });
  this.wsClient.start({ eventDispatcher }).catch((err: unknown) => {
    logger.error({ err }, 'Feishu WSClient error');
  });

  logger.info('Feishu WebSocket client started');
  console.log('\n  Feishu bot connected via WebSocket long-connection');
  console.log("  Send /chatid to the bot to get a chat's registration ID\n");

  // Add stub so TS compiles — will be filled in Task 4
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void (this.handleInboundMessage as unknown);
}

// Stub — implemented in Task 4
private async handleInboundMessage(_data: unknown): Promise<void> {}
```

> Note: `lark.Client.request` signature is `request<T>(options): Promise<T>`. The actual type may require `as any` casts — use them freely here.

- [ ] **Step 4: Run tests — all pass**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat: implement connect() with WSClient and bot info fetch"
```

---

## Task 4: Inbound message routing — text, post, /chatid, @mention

`handleInboundMessage` parses the event, handles `/chatid`, routes by `msg_type`, and calls `deliver()`. Implements `text` and `post` message types with @mention injection.

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/channels/feishu.test.ts`:

```typescript
// --- Helper to simulate an inbound event ---

async function triggerMessage(data: unknown) {
  await capturedHandlers['im.message.receive_v1']!(data);
}

function makeTextEvent(overrides: {
  chat_id?: string;
  chat_type?: string;
  text?: string;
  mentions?: unknown[];
  message_id?: string;
}) {
  return {
    message: {
      chat_id: overrides.chat_id ?? 'oc_abc123',
      chat_type: overrides.chat_type ?? 'group',
      message_type: 'text',
      message_id: overrides.message_id ?? 'om_001',
      create_time: '1700000000000',
      content: JSON.stringify({ text: overrides.text ?? 'hello' }),
      mentions: overrides.mentions ?? [],
    },
    sender: {
      sender_id: { open_id: 'ou_user1' },
    },
  };
}

// --- Text message handling ---

describe('text messages', () => {
  it('delivers a text message to a registered group', async () => {
    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(makeTextEvent({ text: 'hello world' }));

    expect(opts.onMessage).toHaveBeenCalledWith('fs:oc_abc123', expect.objectContaining({
      id: 'om_001',
      chat_jid: 'fs:oc_abc123',
      sender: 'ou_user1',
      content: 'hello world',
      is_from_me: false,
    }));
  });

  it('skips messages from unregistered chats', async () => {
    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(makeTextEvent({ chat_id: 'oc_unknown', text: 'hi' }));

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('calls onChatMetadata for every message', async () => {
    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(makeTextEvent({ text: 'hi' }));

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.any(String),
      undefined,
      'feishu',
      true,
    );
  });

  it('injects trigger when bot is @mentioned and trigger not present', async () => {
    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    // botOpenId is 'ou_bot123' (set by mockRequest)
    await triggerMessage(
      makeTextEvent({
        text: 'can you help me @_user_1',
        mentions: [{ id: { open_id: 'ou_bot123' } }],
      }),
    );

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: '@Andy can you help me' }),
    );
  });

  it('does not inject trigger when content already matches', async () => {
    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(
      makeTextEvent({
        text: '@Andy hello @_user_1',
        mentions: [{ id: { open_id: 'ou_bot123' } }],
      }),
    );

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: '@Andy hello' }),
    );
  });
});

// --- /chatid command ---

describe('/chatid command', () => {
  it('replies with the JID and does not call onMessage', async () => {
    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(makeTextEvent({ text: '/chatid' }));

    expect(mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'chat_id' },
        data: expect.objectContaining({ receive_id: 'oc_abc123' }),
      }),
    );
    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});

// --- post (rich text) message ---

describe('post messages', () => {
  it('concatenates text blocks from rich text content', async () => {
    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    const postContent = {
      zh_cn: {
        title: 'Test',
        content: [
          [
            { tag: 'text', text: 'Hello ' },
            { tag: 'at', user_id: 'ou_bot123' },
            { tag: 'text', text: 'world' },
          ],
        ],
      },
    };

    await triggerMessage({
      message: {
        chat_id: 'oc_abc123',
        chat_type: 'group',
        message_type: 'post',
        message_id: 'om_002',
        create_time: '1700000000000',
        content: JSON.stringify(postContent),
        mentions: [],
      },
      sender: { sender_id: { open_id: 'ou_user1' } },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: 'Hello world' }),
    );
  });
});
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | grep -E "FAIL|✗|×" | head -20
```

- [ ] **Step 3: Implement `handleInboundMessage` and helpers in `feishu.ts`**

Replace the stub `handleInboundMessage` and add helper methods. Insert after `connect()`:

```typescript
private async handleInboundMessage(data: unknown): Promise<void> {
  const d = data as any;
  const message = d?.message;
  const senderInfo = d?.sender;
  if (!message || !senderInfo) return;

  const chatId: string = message.chat_id ?? '';
  const chatJid = `fs:${chatId}`;
  const msgType: string = message.message_type ?? '';
  const messageId: string = message.message_id ?? '';
  const createTime: string = message.create_time ?? String(Date.now());
  const timestamp = new Date(parseInt(createTime, 10)).toISOString();
  const senderId: string = senderInfo.sender_id?.open_id ?? '';
  const isGroup: boolean = message.chat_type === 'group';

  // Store metadata (chat discovery)
  this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

  // Handle /chatid before group check — responds to any chat
  if (msgType === 'text') {
    const parsed = JSON.parse(message.content ?? '{}') as { text?: string };
    if ((parsed.text ?? '').trim() === '/chatid') {
      await this.sendMessage(chatJid, `Chat ID: \`${chatJid}\`\nType: ${message.chat_type}`);
      return;
    }
  }

  const group = this.opts.registeredGroups()[chatJid];
  if (!group) {
    logger.debug({ chatJid }, 'Message from unregistered Feishu chat — ignoring');
    return;
  }

  const mentions: unknown[] = message.mentions ?? [];

  switch (msgType) {
    case 'text':
      this.handleText(message, chatJid, senderId, timestamp, messageId, mentions);
      break;
    case 'post':
      this.handlePost(message, chatJid, senderId, timestamp, messageId, mentions);
      break;
    case 'image':
      this.handleImage(message, chatJid, senderId, timestamp, group);
      break;
    case 'file':
      this.handleFile(message, chatJid, senderId, timestamp, group);
      break;
    case 'audio':
      this.handleAudio(message, chatJid, senderId, timestamp, group);
      break;
    case 'sticker':
      this.deliver(chatJid, '[Sticker]', senderId, timestamp, messageId);
      break;
    default:
      this.deliver(chatJid, `[Unsupported message type: ${msgType}]`, senderId, timestamp, messageId);
  }
}

private injectTrigger(text: string, mentions: unknown[]): string {
  if (!this.botOpenId) return text;
  const isBotMentioned = (mentions as any[]).some(
    (m) => m?.id?.open_id === this.botOpenId,
  );
  if (isBotMentioned && !TRIGGER_PATTERN.test(text)) {
    return `@${ASSISTANT_NAME} ${text}`;
  }
  return text;
}

private handleText(
  message: any,
  chatJid: string,
  senderId: string,
  timestamp: string,
  messageId: string,
  mentions: unknown[],
): void {
  const parsed = JSON.parse(message.content ?? '{}') as { text?: string };
  // Strip Feishu's inline @mention markers (format: @_user_N)
  const cleaned = (parsed.text ?? '').replace(/@_user_\d+/g, '').trim();
  const content = this.injectTrigger(cleaned, mentions);
  this.deliver(chatJid, content, senderId, timestamp, messageId);
}

private handlePost(
  message: any,
  chatJid: string,
  senderId: string,
  timestamp: string,
  messageId: string,
  mentions: unknown[],
): void {
  // post content: { "zh_cn": { "title": "...", "content": [[{tag, text}, ...], ...] } }
  const contentObj = JSON.parse(message.content ?? '{}') as Record<string, any>;
  const lang: any =
    contentObj['zh_cn'] ?? contentObj['en_us'] ?? Object.values(contentObj)[0];
  if (!lang) {
    this.deliver(chatJid, '[Post]', senderId, timestamp, messageId);
    return;
  }
  const segments: string[] = [];
  for (const row of (lang.content ?? []) as any[][]) {
    for (const block of row ?? []) {
      if (block.tag === 'text' || !block.tag) {
        segments.push(block.text ?? '');
      }
      // skip 'at', 'a', 'img' tags — mention injection handled below
    }
  }
  const raw = segments.join('').trim();
  const content = this.injectTrigger(raw, mentions);
  this.deliver(chatJid, content, senderId, timestamp, messageId);
}

private deliver(
  chatJid: string,
  content: string,
  sender: string,
  timestamp: string,
  msgId: string,
): void {
  this.opts.onMessage(chatJid, {
    id: msgId,
    chat_jid: chatJid,
    sender,
    sender_name: sender,
    content,
    timestamp,
    is_from_me: false,
  });
  logger.info({ chatJid, sender }, 'Feishu message delivered');
}

// Stubs for media handlers — implemented in Tasks 6 and 7
private handleImage(_m: any, _j: string, _s: string, _t: string, _g: RegisteredGroup): void {}
private handleFile(_m: any, _j: string, _s: string, _t: string, _g: RegisteredGroup): void {}
private handleAudio(_m: any, _j: string, _s: string, _t: string, _g: RegisteredGroup): void {}
```

> `sendMessage` is still a stub at this point — the `/chatid` test will fail until Task 8. That's fine; stub it to call `mockMessageCreate` directly for now by adding a temporary implementation:

Temporarily replace the `sendMessage` stub:

```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  const chatId = jid.replace(/^fs:/, '');
  try {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send Feishu message');
  }
}
```

(This will be replaced with the chunked version in Task 8.)

- [ ] **Step 4: Run tests — all pass**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat: implement text/post message handling, @mention injection, /chatid"
```

---

## Task 5: `downloadFeishuResource()` private method

Feishu files cannot be fetched with a plain URL. The SDK returns a `Readable` stream from `client.im.messageResource.get()`. This method downloads any resource (image or file) to the group's `attachments/` directory and returns the container-relative path.

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/channels/feishu.test.ts`:

```typescript
// --- downloadFeishuResource (tested indirectly via handleImage in Task 6) ---
// Direct test via a subclass that exposes the private method

class TestableFeishuChannel extends FeishuChannel {
  async testDownload(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    groupFolder: string,
    filename: string,
  ) {
    return (this as any).downloadFeishuResource(
      messageId,
      fileKey,
      type,
      groupFolder,
      filename,
    );
  }
}

describe('downloadFeishuResource', () => {
  it('returns container path on successful download', async () => {
    const mockReadable = new Readable({ read() {} });
    mockReadable.push(Buffer.from('fake data'));
    mockReadable.push(null);
    mockMessageResourceGet.mockResolvedValueOnce(mockReadable);

    const mockWritable = new Writable({ write(_c, _e, cb) { cb(); } });
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(mockWritable as any);

    const ch = new TestableFeishuChannel('id', 'secret', makeOpts());
    const result = await ch.testDownload('om_001', 'key_123', 'image', 'feishu_test', 'image_001.jpg');

    expect(result).toBe('/workspace/group/attachments/image_001.jpg');
    expect(mockMessageResourceGet).toHaveBeenCalledWith({
      path: { message_id: 'om_001', file_key: 'key_123' },
      params: { type: 'image' },
    });
  });

  it('returns null when SDK returns no stream', async () => {
    mockMessageResourceGet.mockResolvedValueOnce(null);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

    const ch = new TestableFeishuChannel('id', 'secret', makeOpts());
    const result = await ch.testDownload('om_001', 'key_123', 'image', 'feishu_test', 'image_001.jpg');

    expect(result).toBeNull();
  });

  it('returns null and logs on SDK error', async () => {
    mockMessageResourceGet.mockRejectedValueOnce(new Error('API error'));
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

    const ch = new TestableFeishuChannel('id', 'secret', makeOpts());
    const result = await ch.testDownload('om_001', 'key_123', 'file', 'feishu_test', 'doc.pdf');

    expect(result).toBeNull();
  });

  it('sanitises dangerous characters in filename', async () => {
    const mockReadable = new Readable({ read() {} });
    mockReadable.push(null);
    mockMessageResourceGet.mockResolvedValueOnce(mockReadable);

    const mockWritable = new Writable({ write(_c, _e, cb) { cb(); } });
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(mockWritable as any);

    const ch = new TestableFeishuChannel('id', 'secret', makeOpts());
    const result = await ch.testDownload('om_001', 'key_123', 'file', 'feishu_test', 'evil/../../../etc/passwd');

    // Sanitised name should not contain slashes
    expect(result).not.toContain('..');
    expect(result).not.toContain('/etc/');
  });
});
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | grep -E "FAIL|✗|×" | head -10
```

- [ ] **Step 3: Implement `downloadFeishuResource` in `feishu.ts`**

Add as a private method in `FeishuChannel` (place before `handleInboundMessage`):

```typescript
private async downloadFeishuResource(
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  groupFolder: string,
  filename: string,
): Promise<string | null> {
  try {
    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(attachDir, safeName);

    const stream = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    } as any);

    if (!stream) return null;

    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(destPath);
      (stream as unknown as NodeJS.ReadableStream).pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    return `/workspace/group/attachments/${safeName}`;
  } catch (err) {
    logger.error({ err, messageId, fileKey }, 'Failed to download Feishu resource');
    return null;
  }
}
```

- [ ] **Step 4: Run tests — all pass**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat: add downloadFeishuResource helper with filename sanitisation"
```

---

## Task 6: Image and file message handlers

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/channels/feishu.test.ts`:

```typescript
function makeMediaEvent(msgType: string, content: Record<string, string>, chat_id = 'oc_abc123') {
  return {
    message: {
      chat_id,
      chat_type: 'group',
      message_type: msgType,
      message_id: `om_media_${msgType}`,
      create_time: '1700000000000',
      content: JSON.stringify(content),
      mentions: [],
    },
    sender: { sender_id: { open_id: 'ou_user1' } },
  };
}

describe('image messages', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(
      new Writable({ write(_c: any, _e: any, cb: any) { cb(); } }) as any,
    );
  });

  it('delivers image with path when download succeeds', async () => {
    const mockStream = new Readable({ read() {} });
    mockStream.push(null);
    mockMessageResourceGet.mockResolvedValueOnce(mockStream);

    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(makeMediaEvent('image', { image_key: 'img_key_001' }));
    await new Promise((r) => setTimeout(r, 10)); // allow async download

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({
        content: expect.stringMatching(/^\[Image\] \(\/workspace\/group\/attachments\/.+\)$/),
      }),
    );
    expect(mockMessageResourceGet).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.objectContaining({ file_key: 'img_key_001' }),
        params: { type: 'image' },
      }),
    );
  });

  it('delivers [Image] placeholder when download fails', async () => {
    mockMessageResourceGet.mockRejectedValueOnce(new Error('download failed'));

    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(makeMediaEvent('image', { image_key: 'bad_key' }));
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: '[Image]' }),
    );
  });
});

describe('file messages', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(
      new Writable({ write(_c: any, _e: any, cb: any) { cb(); } }) as any,
    );
  });

  it('delivers file with name and path when download succeeds', async () => {
    const mockStream = new Readable({ read() {} });
    mockStream.push(null);
    mockMessageResourceGet.mockResolvedValueOnce(mockStream);

    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(
      makeMediaEvent('file', { file_key: 'file_key_001', file_name: 'report.pdf' }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({
        content: expect.stringMatching(/^\[File: report\.pdf\] \(\/workspace\/.+\)$/),
      }),
    );
  });

  it('delivers [File: name] placeholder on download failure', async () => {
    mockMessageResourceGet.mockRejectedValueOnce(new Error('fail'));

    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(
      makeMediaEvent('file', { file_key: 'bad', file_name: 'doc.docx' }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: '[File: doc.docx]' }),
    );
  });
});
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | grep -E "FAIL|✗|×" | head -10
```

- [ ] **Step 3: Implement `handleImage` and `handleFile` in `feishu.ts`**

Replace the stub `handleImage` and `handleFile` methods:

```typescript
private handleImage(
  message: any,
  chatJid: string,
  senderId: string,
  timestamp: string,
  group: RegisteredGroup,
): void {
  const content = JSON.parse(message.content ?? '{}') as { image_key?: string };
  const imageKey = content.image_key ?? '';
  const messageId: string = message.message_id;
  const filename = `image_${messageId}.jpg`;

  this.downloadFeishuResource(messageId, imageKey, 'image', group.folder, filename)
    .then((filePath) => {
      const text = filePath ? `[Image] (${filePath})` : '[Image]';
      this.deliver(chatJid, text, senderId, timestamp, messageId);
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Unexpected error in image handler');
      this.deliver(chatJid, '[Image]', senderId, timestamp, messageId);
    });
}

private handleFile(
  message: any,
  chatJid: string,
  senderId: string,
  timestamp: string,
  group: RegisteredGroup,
): void {
  const content = JSON.parse(message.content ?? '{}') as {
    file_key?: string;
    file_name?: string;
  };
  const fileKey = content.file_key ?? '';
  const fileName = content.file_name ?? `file_${message.message_id}`;
  const messageId: string = message.message_id;

  this.downloadFeishuResource(messageId, fileKey, 'file', group.folder, fileName)
    .then((filePath) => {
      const text = filePath ? `[File: ${fileName}] (${filePath})` : `[File: ${fileName}]`;
      this.deliver(chatJid, text, senderId, timestamp, messageId);
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Unexpected error in file handler');
      this.deliver(chatJid, `[File: ${fileName}]`, senderId, timestamp, messageId);
    });
}
```

- [ ] **Step 4: Run tests — all pass**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat: implement image and file message handlers with download"
```

---

## Task 7: Audio/voice handler with transcription

Feishu audio messages use `msg_type: 'audio'`. The file is in `.opus` format. The existing `transcribeAudio()` uses ffmpeg to convert before Whisper, so format is handled.

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/channels/feishu.test.ts`:

```typescript
describe('audio messages', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(
      new Writable({ write(_c: any, _e: any, cb: any) { cb(); } }) as any,
    );
  });

  it('delivers transcription when audio download and transcription succeed', async () => {
    const mockStream = new Readable({ read() {} });
    mockStream.push(null);
    mockMessageResourceGet.mockResolvedValueOnce(mockStream);
    vi.mocked(transcribeAudio).mockResolvedValueOnce('hello feishu');

    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(makeMediaEvent('audio', { file_key: 'audio_key_001' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: '[Voice: hello feishu]' }),
    );
  });

  it('delivers transcription-failed placeholder when transcribeAudio returns null', async () => {
    const mockStream = new Readable({ read() {} });
    mockStream.push(null);
    mockMessageResourceGet.mockResolvedValueOnce(mockStream);
    vi.mocked(transcribeAudio).mockResolvedValueOnce(null);

    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(makeMediaEvent('audio', { file_key: 'audio_key_001' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: '[Voice message - transcription failed]' }),
    );
  });

  it('delivers transcription-failed when download fails', async () => {
    mockMessageResourceGet.mockRejectedValueOnce(new Error('fail'));

    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage(makeMediaEvent('audio', { file_key: 'bad_key' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: '[Voice message - transcription failed]' }),
    );
  });
});
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | grep -E "FAIL|✗|×" | head -10
```

- [ ] **Step 3: Implement `handleAudio` in `feishu.ts`**

Replace the stub `handleAudio` method:

```typescript
private handleAudio(
  message: any,
  chatJid: string,
  senderId: string,
  timestamp: string,
  group: RegisteredGroup,
): void {
  const content = JSON.parse(message.content ?? '{}') as { file_key?: string };
  const fileKey = content.file_key ?? '';
  const messageId: string = message.message_id;
  const filename = `audio_${messageId}.opus`;

  this.downloadFeishuResource(messageId, fileKey, 'file', group.folder, filename)
    .then(async (filePath) => {
      if (!filePath) {
        this.deliver(chatJid, '[Voice message - transcription failed]', senderId, timestamp, messageId);
        return;
      }
      const attachFilename = filePath.split('/').pop()!;
      const hostPath = path.join(
        resolveGroupFolderPath(group.folder),
        'attachments',
        attachFilename,
      );
      const transcript = await transcribeAudio(hostPath);
      const text = transcript
        ? `[Voice: ${transcript}]`
        : '[Voice message - transcription failed]';
      this.deliver(chatJid, text, senderId, timestamp, messageId);
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Unexpected error in audio handler');
      this.deliver(chatJid, '[Voice message - transcription failed]', senderId, timestamp, messageId);
    });
}
```

- [ ] **Step 4: Run tests — all pass**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat: implement audio message handler with voice transcription"
```

---

## Task 8: `sendMessage()` with chunking

Replace the temporary `sendMessage` stub with the production version: Feishu text messages, split at 4000 characters.

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/channels/feishu.test.ts`:

```typescript
describe('sendMessage()', () => {
  it('sends a short message as a single API call', async () => {
    const ch = new FeishuChannel('id', 'secret', makeOpts());
    await ch.sendMessage('fs:oc_abc123', 'Hello Feishu!');

    expect(mockMessageCreate).toHaveBeenCalledOnce();
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'Hello Feishu!' }),
      },
    });
  });

  it('strips the fs: prefix before sending', async () => {
    const ch = new FeishuChannel('id', 'secret', makeOpts());
    await ch.sendMessage('fs:p2p_xyz789', 'DM test');

    expect(mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ receive_id: 'p2p_xyz789' }),
      }),
    );
  });

  it('splits messages longer than 4000 chars into multiple sends', async () => {
    const ch = new FeishuChannel('id', 'secret', makeOpts());
    const longText = 'x'.repeat(9001);
    await ch.sendMessage('fs:oc_abc123', longText);

    expect(mockMessageCreate).toHaveBeenCalledTimes(3); // 9001 / 4000 = ceil 3
  });

  it('logs an error and stops on API failure', async () => {
    mockMessageCreate.mockRejectedValueOnce(new Error('rate limited'));
    const ch = new FeishuChannel('id', 'secret', makeOpts());
    await expect(ch.sendMessage('fs:oc_abc123', 'hi')).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm chunking test fails** (current impl doesn't chunk)

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | grep -E "FAIL|✗|×" | head -10
```

- [ ] **Step 3: Replace `sendMessage` with production implementation**

```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  const chatId = jid.replace(/^fs:/, '');
  const MAX_LENGTH = 4000;

  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    const chunk = text.slice(i, i + MAX_LENGTH);
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      } as any);
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
      return;
    }
  }
  logger.info({ jid, length: text.length }, 'Feishu message sent');
}
```

- [ ] **Step 4: Run tests — all pass**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat: implement sendMessage with 4000-char chunking"
```

---

## Task 9: Remaining Channel methods + sticker/unknown handlers

Add tests for `disconnect()`, `setTyping()`, `isConnected()`, sticker, and unknown message types. These are already implemented but untested.

**Files:**
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Add tests**

Append to `src/channels/feishu.test.ts`:

```typescript
describe('disconnect()', () => {
  it('sets isConnected to false', async () => {
    const ch = new FeishuChannel('id', 'secret', makeOpts());
    await ch.connect();
    expect(ch.isConnected()).toBe(true);

    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
  });

  it('is idempotent', async () => {
    const ch = new FeishuChannel('id', 'secret', makeOpts());
    await ch.disconnect();
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
  });
});

describe('setTyping()', () => {
  it('resolves without error (no-op)', async () => {
    const ch = new FeishuChannel('id', 'secret', makeOpts());
    await expect(ch.setTyping('fs:oc_abc123', true)).resolves.not.toThrow();
  });
});

describe('sticker and unknown message types', () => {
  it('delivers [Sticker] placeholder', async () => {
    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage({
      message: {
        chat_id: 'oc_abc123',
        chat_type: 'group',
        message_type: 'sticker',
        message_id: 'om_003',
        create_time: '1700000000000',
        content: '{}',
        mentions: [],
      },
      sender: { sender_id: { open_id: 'ou_user1' } },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: '[Sticker]' }),
    );
  });

  it('delivers [Unsupported message type: ...] for unknown types', async () => {
    const opts = makeOpts();
    const ch = new FeishuChannel('id', 'secret', opts);
    await ch.connect();

    await triggerMessage({
      message: {
        chat_id: 'oc_abc123',
        chat_type: 'group',
        message_type: 'system',
        message_id: 'om_004',
        create_time: '1700000000000',
        content: '{}',
        mentions: [],
      },
      sender: { sender_id: { open_id: 'ou_user1' } },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({ content: '[Unsupported message type: system]' }),
    );
  });
});
```

- [ ] **Step 2: Run tests — all pass**

```bash
npx vitest run src/channels/feishu.test.ts 2>&1 | tail -10
```

Expected: all tests pass. If any fail, fix the implementation.

- [ ] **Step 3: Run full test suite — no regressions**

```bash
npm test 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 4: Final build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "test: add coverage for disconnect, setTyping, sticker, and unknown message types"
```

---

## Task 10: SKILL.md

Write the 5-phase setup skill. This file goes on `main` in the nanoclaw repo, not in the `nanoclaw-feishu` repo.

**Files:**
- Create: `.claude/skills/add-feishu/SKILL.md`

- [ ] **Step 1: Create the skill directory and file**

Create `.claude/skills/add-feishu/SKILL.md`:

```markdown
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
```

- [ ] **Step 2: Verify SKILL.md line count is under 500**

```bash
wc -l .claude/skills/add-feishu/SKILL.md
```

Expected: under 500 lines.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-feishu/SKILL.md
git commit -m "feat: add add-feishu SKILL.md with 5-phase setup guide"
```

---

## Final verification

- [ ] **Run the full test suite one more time**

```bash
npm test 2>&1 | tail -20
```

Expected: all tests pass, including the new feishu tests.

- [ ] **TypeScript check**

```bash
npm run typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Confirm branch is ready**

```bash
git log --oneline skill/feishu ^main
```

Expected: 10 commits — one per task.
