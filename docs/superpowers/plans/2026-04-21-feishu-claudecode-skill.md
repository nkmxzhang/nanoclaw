# Feishu × Claude Code Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Claude Code Skill that gives Claude Code bidirectional Feishu communication — send notifications, block for confirmations, auto-intercept high-risk shell commands, and receive user-initiated messages.

**Architecture:** An MCP stdio server (TypeScript) that Claude Code auto-starts per session. It holds a Feishu WebSocket long-connection, exposes three MCP tools (`feishu_notify`, `feishu_ask`, `feishu_summary`), runs a local HTTP server on port 7730 for PreToolUse/Stop hook shell scripts, and maintains a file-based inbox (`~/.claude/feishu-inbox/`) for user-initiated Feishu messages.

**Tech Stack:** TypeScript (ESM, NodeNext modules), `@larksuiteoapi/node-sdk`, `@modelcontextprotocol/sdk`, Node.js built-in `http`, `vitest` for tests, `tsx` for dev.

---

## File Map

All files created under `~/.claude/skills/feishu-bridge/`:

| Path | Role |
|------|------|
| `bridge/package.json` | npm manifest: deps + build/test scripts |
| `bridge/tsconfig.json` | TypeScript config (ESM, NodeNext) |
| `bridge/src/config.ts` | Load + validate `~/.claude/feishu-bridge.json` |
| `bridge/src/messages.ts` | Shared: `formatAskMessage`, `isApproved` |
| `bridge/src/inbox.ts` | Write/read/clear `~/.claude/feishu-inbox/` |
| `bridge/src/feishu.ts` | Feishu WebSocket connection, sendMessage, waitForReply |
| `bridge/src/http.ts` | Local HTTP server on :7730 (for hook shell scripts) |
| `bridge/src/mcp.ts` | MCP Server with 3 tools |
| `bridge/src/index.ts` | Entry: wire config → feishu → http → mcp |
| `bridge/scripts/intercept-bash.sh` | PreToolUse hook: high-risk command interception |
| `bridge/scripts/check-inbox.sh` | PreToolUse hook: inject inbox messages into context |
| `bridge/scripts/on-stop.sh` | Stop hook: send task summary |
| `bridge/tests/config.test.ts` | Config loading tests |
| `bridge/tests/messages.test.ts` | formatAskMessage + isApproved tests |
| `bridge/tests/inbox.test.ts` | Inbox read/write/clear tests |
| `bridge/tests/feishu.test.ts` | FeishuBridge unit tests (mock lark SDK) |
| `bridge/tests/http.test.ts` | HTTP server endpoint tests |
| `setup.ts` | Interactive installer (copies bridge, writes settings.json) |
| `SKILL.md` | Installation guide (5 phases) + Claude behavior guide |

---

## Task 1: Project Scaffold

**Files:**
- Create: `~/.claude/skills/feishu-bridge/bridge/package.json`
- Create: `~/.claude/skills/feishu-bridge/bridge/tsconfig.json`
- Create: `~/.claude/skills/feishu-bridge/bridge/src/` (empty dir)
- Create: `~/.claude/skills/feishu-bridge/bridge/tests/` (empty dir)
- Create: `~/.claude/skills/feishu-bridge/bridge/scripts/` (empty dir)

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p ~/.claude/skills/feishu-bridge/bridge/src
mkdir -p ~/.claude/skills/feishu-bridge/bridge/tests
mkdir -p ~/.claude/skills/feishu-bridge/bridge/scripts
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "feishu-bridge",
  "version": "1.0.0",
  "description": "Feishu MCP bridge for Claude Code",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.46.0",
    "@modelcontextprotocol/sdk": "^1.10.2"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  }
}
```

Save to: `~/.claude/skills/feishu-bridge/bridge/package.json`

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Save to: `~/.claude/skills/feishu-bridge/bridge/tsconfig.json`

- [ ] **Step 4: Install dependencies**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/feishu-bridge && git init && git add bridge/package.json bridge/tsconfig.json && git commit -m "feat: scaffold feishu-bridge project"
```

---

## Task 2: Config Module

**Files:**
- Create: `~/.claude/skills/feishu-bridge/bridge/src/config.ts`
- Create: `~/.claude/skills/feishu-bridge/bridge/tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = path.join(os.tmpdir(), `feishu-test-${Date.now()}`);
const CONFIG_PATH = path.join(TMP, '.claude', 'feishu-bridge.json');

function writeConfig(data: object) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data));
}

// We must re-import config with patched homedir — use a factory approach
async function loadWithTmp() {
  const { loadConfig } = await import('../src/config.js');
  return loadConfig(CONFIG_PATH);
}

describe('loadConfig', () => {
  afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('loads valid config and applies defaults', async () => {
    writeConfig({
      appId: 'cli_abc',
      appSecret: 'secret123',
      targets: { notify: 'fs:oc_1', confirm: 'fs:p2p_1', summary: 'fs:oc_1' },
    });
    const cfg = await loadWithTmp();
    expect(cfg.appId).toBe('cli_abc');
    expect(cfg.httpPort).toBe(7730);
    expect(cfg.timeout).toBe(1800);
    expect(cfg.summaryMinLength).toBe(500);
    expect(cfg.allowedSenders).toEqual([]);
  });

  it('throws when appId is missing', async () => {
    writeConfig({ appSecret: 'x', targets: { notify: 'a', confirm: 'b', summary: 'c' } });
    await expect(loadWithTmp()).rejects.toThrow('appId');
  });

  it('throws when targets.confirm is missing', async () => {
    writeConfig({ appId: 'x', appSecret: 'y', targets: { notify: 'a', summary: 'c' } });
    await expect(loadWithTmp()).rejects.toThrow('targets');
  });

  it('respects overridden values', async () => {
    writeConfig({
      appId: 'a', appSecret: 'b',
      httpPort: 8888, timeout: 60, summaryMinLength: 100,
      targets: { notify: 'n', confirm: 'c', summary: 's' },
      allowedSenders: ['ou_xyz'],
    });
    const cfg = await loadWithTmp();
    expect(cfg.httpPort).toBe(8888);
    expect(cfg.summaryMinLength).toBe(100);
    expect(cfg.allowedSenders).toEqual(['ou_xyz']);
  });
});
```

Save to: `~/.claude/skills/feishu-bridge/bridge/tests/config.test.ts`

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/config.test.ts 2>&1 | tail -5
```

Expected: error about missing module `../src/config.js`.

- [ ] **Step 3: Implement config.ts**

```typescript
// src/config.ts
import fs from 'fs';

export interface Config {
  appId: string;
  appSecret: string;
  httpPort: number;
  timeout: number;
  summaryMinLength: number;
  targets: {
    notify: string;
    confirm: string;
    summary: string;
  };
  allowedSenders: string[];
}

import os from 'os';
import path from 'path';
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.claude', 'feishu-bridge.json');

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): Config {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;

  if (!raw.appId || typeof raw.appId !== 'string') {
    throw new Error('feishu-bridge.json: missing required field "appId"');
  }
  if (!raw.appSecret || typeof raw.appSecret !== 'string') {
    throw new Error('feishu-bridge.json: missing required field "appSecret"');
  }

  const targets = raw.targets as Record<string, string> | undefined;
  if (!targets?.notify || !targets?.confirm || !targets?.summary) {
    throw new Error('feishu-bridge.json: missing required "targets" fields (notify, confirm, summary)');
  }

  return {
    appId: raw.appId,
    appSecret: raw.appSecret,
    httpPort: (raw.httpPort as number) ?? 7730,
    timeout: (raw.timeout as number) ?? 1800,
    summaryMinLength: (raw.summaryMinLength as number) ?? 500,
    targets: {
      notify: targets.notify,
      confirm: targets.confirm,
      summary: targets.summary,
    },
    allowedSenders: (raw.allowedSenders as string[]) ?? [],
  };
}
```

Save to: `~/.claude/skills/feishu-bridge/bridge/src/config.ts`

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/config.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && git add src/config.ts tests/config.test.ts && git commit -m "feat: add config module"
```

---

## Task 3: Message Helpers

**Files:**
- Create: `~/.claude/skills/feishu-bridge/bridge/src/messages.ts`
- Create: `~/.claude/skills/feishu-bridge/bridge/tests/messages.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/messages.test.ts
import { describe, it, expect } from 'vitest';
import { formatAskMessage, isApproved } from '../src/messages.js';

describe('formatAskMessage', () => {
  it('includes the question text', () => {
    const msg = formatAskMessage('delete node_modules');
    expect(msg).toContain('delete node_modules');
    expect(msg).toContain('🔔');
    expect(msg).toContain('✅ 继续');
    expect(msg).toContain('❌ 取消');
  });

  it('includes context when provided', () => {
    const msg = formatAskMessage('drop table users', 'irreversible operation');
    expect(msg).toContain('irreversible operation');
  });

  it('omits 原因 line when no context', () => {
    const msg = formatAskMessage('ls');
    expect(msg).not.toContain('原因');
  });
});

describe('isApproved', () => {
  it.each(['好', '是', 'yes', 'ok', 'y', '继续', '确认', 'approve'])(
    'returns true for "%s"', (word) => {
      expect(isApproved(word)).toBe(true);
    }
  );

  it.each(['不', '取消', 'no', 'cancel', '停', 'timeout', ''])(
    'returns false for "%s"', (word) => {
      expect(isApproved(word)).toBe(false);
    }
  );

  it('returns false for "timeout"', () => {
    expect(isApproved('timeout')).toBe(false);
  });

  it('is case-insensitive for English words', () => {
    expect(isApproved('YES')).toBe(true);
    expect(isApproved('OK')).toBe(true);
  });
});
```

Save to: `~/.claude/skills/feishu-bridge/bridge/tests/messages.test.ts`

- [ ] **Step 2: Run to confirm failure**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/messages.test.ts 2>&1 | tail -5
```

Expected: module not found error.

- [ ] **Step 3: Implement messages.ts**

```typescript
// src/messages.ts
export function formatAskMessage(question: string, context?: string): string {
  const lines = [
    '🔔 Claude Code 需要你的确认',
    '',
    `任务：${question}`,
  ];
  if (context) {
    lines.push(`原因：${context}`);
  }
  lines.push(
    '',
    '请回复：',
    '  ✅ 继续 —— "好"/"是"/"yes"/"ok"/"继续"',
    '  ❌ 取消 —— "不"/"取消"/"no"/"cancel"/"停"',
    '  💬 其他 —— 原文传回 Claude 作为补充信息',
  );
  return lines.join('\n');
}

const APPROVE_WORDS = ['好', '是', 'yes', 'ok', '继续', 'y', '确认', 'approve', 'approved'];

export function isApproved(reply: string): boolean {
  if (reply === 'timeout') return false;
  const lower = reply.toLowerCase().trim();
  return APPROVE_WORDS.some(w => lower === w || lower.includes(w));
}
```

Save to: `~/.claude/skills/feishu-bridge/bridge/src/messages.ts`

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/messages.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && git add src/messages.ts tests/messages.test.ts && git commit -m "feat: add message formatting helpers"
```

---

## Task 4: Inbox Module

**Files:**
- Create: `~/.claude/skills/feishu-bridge/bridge/src/inbox.ts`
- Create: `~/.claude/skills/feishu-bridge/bridge/tests/inbox.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/inbox.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureInbox, writeInbox, readAndClearInbox } from '../src/inbox.js';

const TMP_INBOX = path.join(os.tmpdir(), `feishu-inbox-test-${Date.now()}`);

beforeEach(() => fs.mkdirSync(TMP_INBOX, { recursive: true }));
afterEach(() => fs.rmSync(TMP_INBOX, { recursive: true, force: true }));

describe('ensureInbox', () => {
  it('creates the directory if it does not exist', () => {
    const dir = path.join(TMP_INBOX, 'new-dir');
    ensureInbox(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('writeInbox', () => {
  it('creates a .txt file with sender and message', () => {
    writeInbox('ou_sender', 'hello from feishu', TMP_INBOX);
    const files = fs.readdirSync(TMP_INBOX);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.txt$/);
    const content = fs.readFileSync(path.join(TMP_INBOX, files[0]), 'utf8');
    expect(content).toContain('ou_sender');
    expect(content).toContain('hello from feishu');
  });

  it('creates unique filenames for multiple writes', () => {
    writeInbox('a', 'msg1', TMP_INBOX);
    writeInbox('b', 'msg2', TMP_INBOX);
    const files = fs.readdirSync(TMP_INBOX);
    expect(files).toHaveLength(2);
  });
});

describe('readAndClearInbox', () => {
  it('returns messages and deletes files', () => {
    writeInbox('ou_x', 'test message', TMP_INBOX);
    const messages = readAndClearInbox(TMP_INBOX);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('test message');
    expect(fs.readdirSync(TMP_INBOX)).toHaveLength(0);
  });

  it('returns empty array when inbox is empty', () => {
    expect(readAndClearInbox(TMP_INBOX)).toEqual([]);
  });

  it('returns empty array when inbox dir does not exist', () => {
    expect(readAndClearInbox('/nonexistent/path')).toEqual([]);
  });
});
```

Save to: `~/.claude/skills/feishu-bridge/bridge/tests/inbox.test.ts`

- [ ] **Step 2: Run to confirm failure**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/inbox.test.ts 2>&1 | tail -5
```

Expected: module not found.

- [ ] **Step 3: Implement inbox.ts**

```typescript
// src/inbox.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

export const DEFAULT_INBOX_DIR = path.join(os.homedir(), '.claude', 'feishu-inbox');

export function ensureInbox(dir = DEFAULT_INBOX_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeInbox(sender: string, message: string, dir = DEFAULT_INBOX_DIR): void {
  ensureInbox(dir);
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const content = `[飞书消息 from ${sender}]\n${message}`;
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

export function readAndClearInbox(dir = DEFAULT_INBOX_DIR): string[] {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
    return files.map(f => {
      const filePath = path.join(dir, f);
      const content = fs.readFileSync(filePath, 'utf8');
      fs.unlinkSync(filePath);
      return content;
    });
  } catch {
    return [];
  }
}
```

Save to: `~/.claude/skills/feishu-bridge/bridge/src/inbox.ts`

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/inbox.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && git add src/inbox.ts tests/inbox.test.ts && git commit -m "feat: add inbox module"
```

---

## Task 5: Feishu Module

**Files:**
- Create: `~/.claude/skills/feishu-bridge/bridge/src/feishu.ts`
- Create: `~/.claude/skills/feishu-bridge/bridge/tests/feishu.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/feishu.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TMP_INBOX = path.join(os.tmpdir(), `feishu-inbox-feishu-test-${Date.now()}`);
fs.mkdirSync(TMP_INBOX, { recursive: true });

// Mock lark SDK
vi.mock('@larksuiteoapi/node-sdk', () => {
  const sendSpy = vi.fn().mockResolvedValue({});
  const startSpy = vi.fn().mockResolvedValue(undefined);
  let registeredHandler: ((data: unknown) => Promise<void>) | null = null;

  class MockEventDispatcher {
    register(handlers: Record<string, (data: unknown) => Promise<void>>) {
      registeredHandler = handlers['im.message.receive_v1'] ?? null;
      return this;
    }
  }

  class MockWSClient {
    start({ eventDispatcher: _ }: { eventDispatcher: unknown }) {
      return startSpy();
    }
  }

  class MockClient {
    im = {
      message: {
        create: sendSpy,
      },
    };
  }

  return {
    Client: MockClient,
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
    LoggerLevel: { error: 0 },
    _sendSpy: sendSpy,
    _triggerMessage: async (data: unknown) => {
      if (registeredHandler) await registeredHandler(data);
    },
  };
});

function makeMessageEvent(text: string, chatId = 'oc_test', openId = 'ou_user') {
  return {
    message: {
      message_type: 'text',
      message_id: 'msg_1',
      chat_id: chatId,
      chat_type: 'group',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
    sender: { sender_id: { open_id: openId } },
  };
}

describe('FeishuBridge', () => {
  beforeEach(async () => {
    const lark = await import('@larksuiteoapi/node-sdk');
    (lark as any)._sendSpy.mockClear();
  });

  it('resolves waitForReply when a matching message arrives', async () => {
    const lark = await import('@larksuiteoapi/node-sdk');
    const { FeishuBridge } = await import('../src/feishu.js');

    const bridge = new FeishuBridge('app_id', 'secret', [], TMP_INBOX);
    await bridge.connect();

    const replyPromise = bridge.waitForReply('fs:oc_test', 5000);
    await (lark as any)._triggerMessage(makeMessageEvent('继续'));
    const reply = await replyPromise;
    expect(reply).toBe('继续');
  });

  it('resolves with "timeout" when no reply arrives in time', async () => {
    const { FeishuBridge } = await import('../src/feishu.js');
    const bridge = new FeishuBridge('app_id', 'secret', [], TMP_INBOX);
    await bridge.connect();

    const reply = await bridge.waitForReply('fs:oc_test', 50);
    expect(reply).toBe('timeout');
  });

  it('writes to inbox when no pending ask', async () => {
    const lark = await import('@larksuiteoapi/node-sdk');
    const { FeishuBridge } = await import('../src/feishu.js');

    const bridge = new FeishuBridge('app_id', 'secret', [], TMP_INBOX);
    await bridge.connect();

    await (lark as any)._triggerMessage(makeMessageEvent('補充信息'));
    const files = fs.readdirSync(TMP_INBOX);
    expect(files.length).toBeGreaterThan(0);
    fs.rmSync(TMP_INBOX, { recursive: true, force: true });
  });

  it('ignores messages from senders not in allowedSenders', async () => {
    const lark = await import('@larksuiteoapi/node-sdk');
    const { FeishuBridge } = await import('../src/feishu.js');
    fs.mkdirSync(TMP_INBOX, { recursive: true });

    const bridge = new FeishuBridge('app_id', 'secret', ['ou_allowed'], TMP_INBOX);
    await bridge.connect();

    const replyPromise = bridge.waitForReply('fs:oc_test', 100);
    await (lark as any)._triggerMessage(makeMessageEvent('ok', 'oc_test', 'ou_stranger'));
    const reply = await replyPromise;
    expect(reply).toBe('timeout');
  });
});
```

Save to: `~/.claude/skills/feishu-bridge/bridge/tests/feishu.test.ts`

- [ ] **Step 2: Run to confirm failure**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/feishu.test.ts 2>&1 | tail -10
```

Expected: module not found for `../src/feishu.js`.

- [ ] **Step 3: Implement feishu.ts**

```typescript
// src/feishu.ts
import * as lark from '@larksuiteoapi/node-sdk';
import { writeInbox, DEFAULT_INBOX_DIR } from './inbox.js';

export class FeishuBridge {
  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private pendingResolve: ((reply: string) => void) | null = null;
  private pendingTarget: string | null = null;
  private allowedSenders: string[];
  private inboxDir: string;

  constructor(
    appId: string,
    appSecret: string,
    allowedSenders: string[],
    inboxDir = DEFAULT_INBOX_DIR,
  ) {
    this.allowedSenders = allowedSenders;
    this.inboxDir = inboxDir;
    this.client = new lark.Client({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.error,
    });
  }

  async connect(): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        this.handleMessage(data);
      },
    });

    this.wsClient = new lark.WSClient({
      appId: (this.client as any).appId ?? '',
      appSecret: (this.client as any).appSecret ?? '',
    });
    this.wsClient.start({ eventDispatcher: dispatcher }).catch(() => {});
  }

  private handleMessage(data: unknown): void {
    const d = data as any;
    const message = d?.message;
    const sender: string = d?.sender?.sender_id?.open_id ?? '';
    if (!message) return;

    if (message.message_type !== 'text') return;

    if (this.allowedSenders.length > 0 && !this.allowedSenders.includes(sender)) return;

    const parsed = JSON.parse(message.content ?? '{}') as { text?: string };
    const text = (parsed.text ?? '').replace(/@_user_\d+/g, '').trim();
    const chatId: string = message.chat_id ?? '';
    const jid = `fs:${chatId}`;

    if (this.pendingResolve && (this.pendingTarget === jid || this.pendingTarget === null)) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingTarget = null;
      resolve(text);
    } else {
      writeInbox(sender, text, this.inboxDir);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^fs:/, '');
    const MAX = 4000;
    for (let i = 0; i < text.length; i += MAX) {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: text.slice(i, i + MAX) }),
        },
      } as any);
    }
  }

  waitForReply(target: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.pendingTarget = target;
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          this.pendingTarget = null;
          resolve('timeout');
        }
      }, timeoutMs);
    });
  }

  disconnect(): void {
    this.wsClient = null;
  }
}
```

Save to: `~/.claude/skills/feishu-bridge/bridge/src/feishu.ts`

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/feishu.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && git add src/feishu.ts tests/feishu.test.ts && git commit -m "feat: add Feishu WebSocket bridge module"
```

---

## Task 6: HTTP Server

**Files:**
- Create: `~/.claude/skills/feishu-bridge/bridge/src/http.ts`
- Create: `~/.claude/skills/feishu-bridge/bridge/tests/http.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/http.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { startHttpServer } from '../src/http.js';
import type { Config } from '../src/config.js';

const BASE_CONFIG: Config = {
  appId: 'test', appSecret: 'test',
  httpPort: 0,
  timeout: 5,
  summaryMinLength: 500,
  targets: { notify: 'fs:oc_notify', confirm: 'fs:oc_confirm', summary: 'fs:oc_summary' },
  allowedSenders: [],
};

function makeBridge(overrides: Partial<{ sendMessage: any; waitForReply: any }> = {}) {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    waitForReply: vi.fn().mockResolvedValue('好'),
    ...overrides,
  } as any;
}

async function post(server: http.Server, path: string, body: object): Promise<{ status: number; data: any }> {
  const addr = server.address() as { port: number };
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('HTTP server', () => {
  let server: http.Server;

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('GET /health returns 200', async () => {
    const bridge = makebridge();
    server = startHttpServer(bridge, { ...BASE_CONFIG, httpPort: 0 });
    await new Promise<void>(r => server.listen(0, r));
    const addr = server.address() as { port: number };
    const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${addr.port}/health`, resolve).on('error', reject);
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /notify sends message and returns { sent: true }', async () => {
    const bridge = makebridge();
    server = startHttpServer(bridge, { ...BASE_CONFIG, httpPort: 0 });
    await new Promise<void>(r => server.listen(0, r));

    const result = await post(server, '/notify', { message: 'hello' });
    expect(result.status).toBe(200);
    expect(result.data.sent).toBe(true);
    expect(bridge.sendMessage).toHaveBeenCalledWith('fs:oc_notify', 'hello');
  });

  it('POST /ask sends formatted message and returns approved=true for "好"', async () => {
    const bridge = makebridge({ waitForReply: vi.fn().mockResolvedValue('好') });
    server = startHttpServer(bridge, { ...BASE_CONFIG, httpPort: 0 });
    await new Promise<void>(r => server.listen(0, r));

    const result = await post(server, '/ask', { question: 'delete dist?' });
    expect(result.status).toBe(200);
    expect(result.data.approved).toBe(true);
    expect(result.data.reply).toBe('好');
    expect(bridge.sendMessage).toHaveBeenCalledWith('fs:oc_confirm', expect.stringContaining('delete dist?'));
  });

  it('POST /ask returns approved=false for "timeout"', async () => {
    const bridge = makebridge({ waitForReply: vi.fn().mockResolvedValue('timeout') });
    server = startHttpServer(bridge, { ...BASE_CONFIG, httpPort: 0 });
    await new Promise<void>(r => server.listen(0, r));

    const result = await post(server, '/ask', { question: 'proceed?' });
    expect(result.data.approved).toBe(false);
  });

  it('POST /summary sends to summary target', async () => {
    const bridge = makebridge();
    server = startHttpServer(bridge, { ...BASE_CONFIG, httpPort: 0 });
    await new Promise<void>(r => server.listen(0, r));

    const result = await post(server, '/summary', { summary: 'Task done.' });
    expect(result.data.sent).toBe(true);
    expect(bridge.sendMessage).toHaveBeenCalledWith('fs:oc_summary', 'Task done.');
  });
});

function makebridge(overrides = {}) {
  return makebridge(overrides);
}
```

> Note: there's a trivial naming collision in the test above — rename `makebridge` helper to `makeMockBridge`:

```typescript
// tests/http.test.ts (corrected)
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import { startHttpServer } from '../src/http.js';
import type { Config } from '../src/config.js';

const BASE_CONFIG: Config = {
  appId: 'test', appSecret: 'test',
  httpPort: 0, timeout: 5, summaryMinLength: 500,
  targets: { notify: 'fs:oc_notify', confirm: 'fs:oc_confirm', summary: 'fs:oc_summary' },
  allowedSenders: [],
};

function makeMockBridge(overrides: { waitForReply?: any } = {}) {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    waitForReply: vi.fn().mockResolvedValue('好'),
    ...overrides,
  } as any;
}

async function postJSON(server: http.Server, path: string, body: object) {
  const addr = server.address() as { port: number };
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port: addr.port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function listenRandom(server: http.Server): Promise<void> {
  return new Promise(r => server.listen(0, '127.0.0.1', r));
}

describe('HTTP server', () => {
  let server: http.Server;
  afterEach(() => new Promise<void>(r => server.close(() => r())));

  it('GET /health returns 200', async () => {
    server = startHttpServer(makeMockBridge(), BASE_CONFIG);
    await listenRandom(server);
    const { port } = server.address() as { port: number };
    const status = await new Promise<number>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, r => resolve(r.statusCode!)).on('error', reject);
    });
    expect(status).toBe(200);
  });

  it('POST /notify sends message', async () => {
    const bridge = makeMockBridge();
    server = startHttpServer(bridge, BASE_CONFIG);
    await listenRandom(server);
    const result = await postJSON(server, '/notify', { message: 'hello' });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ sent: true });
    expect(bridge.sendMessage).toHaveBeenCalledWith('fs:oc_notify', 'hello');
  });

  it('POST /ask returns approved true for "好"', async () => {
    const bridge = makeMockBridge({ waitForReply: vi.fn().mockResolvedValue('好') });
    server = startHttpServer(bridge, BASE_CONFIG);
    await listenRandom(server);
    const result = await postJSON(server, '/ask', { question: 'delete dist?' });
    expect(result.data.approved).toBe(true);
    expect(result.data.reply).toBe('好');
    expect(bridge.sendMessage).toHaveBeenCalledWith('fs:oc_confirm', expect.stringContaining('delete dist?'));
  });

  it('POST /ask returns approved false for timeout', async () => {
    const bridge = makeMockBridge({ waitForReply: vi.fn().mockResolvedValue('timeout') });
    server = startHttpServer(bridge, BASE_CONFIG);
    await listenRandom(server);
    const result = await postJSON(server, '/ask', { question: 'proceed?' });
    expect(result.data.approved).toBe(false);
  });

  it('POST /summary sends to summary target', async () => {
    const bridge = makeMockBridge();
    server = startHttpServer(bridge, BASE_CONFIG);
    await listenRandom(server);
    const result = await postJSON(server, '/summary', { summary: 'Done.' });
    expect(result.data).toEqual({ sent: true });
    expect(bridge.sendMessage).toHaveBeenCalledWith('fs:oc_summary', 'Done.');
  });
});
```

Save to: `~/.claude/skills/feishu-bridge/bridge/tests/http.test.ts`

- [ ] **Step 2: Run to confirm failure**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/http.test.ts 2>&1 | tail -5
```

Expected: module not found.

- [ ] **Step 3: Implement http.ts**

```typescript
// src/http.ts
import http from 'http';
import { formatAskMessage, isApproved } from './messages.js';
import type { Config } from './config.js';
import type { FeishuBridge } from './feishu.js';

export function startHttpServer(
  bridge: Pick<FeishuBridge, 'sendMessage' | 'waitForReply'>,
  config: Config,
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }

    const send = (payload: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    try {
      if (req.url === '/notify') {
        const target = (body.target as string) ?? config.targets.notify;
        await bridge.sendMessage(target, body.message as string);
        send({ sent: true });
      } else if (req.url === '/ask') {
        const target = (body.target as string) ?? config.targets.confirm;
        const timeoutMs = ((body.timeout as number) ?? config.timeout) * 1000;
        const question = formatAskMessage(
          body.question as string,
          body.context as string | undefined,
        );
        await bridge.sendMessage(target, question);
        const reply = await bridge.waitForReply(target, timeoutMs);
        send({ approved: isApproved(reply), reply });
      } else if (req.url === '/summary') {
        const target = (body.target as string) ?? config.targets.summary;
        await bridge.sendMessage(target, body.summary as string);
        send({ sent: true });
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(config.httpPort);
  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
```

Save to: `~/.claude/skills/feishu-bridge/bridge/src/http.ts`

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run tests/http.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && git add src/http.ts tests/http.test.ts && git commit -m "feat: add HTTP server for hook integration"
```

---

## Task 7: MCP Tools + Entry Point

**Files:**
- Create: `~/.claude/skills/feishu-bridge/bridge/src/mcp.ts`
- Create: `~/.claude/skills/feishu-bridge/bridge/src/index.ts`

*(No separate unit tests — MCP protocol wiring is verified by the end-to-end setup verification in Task 10.)*

- [ ] **Step 1: Implement mcp.ts**

```typescript
// src/mcp.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { formatAskMessage } from './messages.js';
import type { Config } from './config.js';
import type { FeishuBridge } from './feishu.js';

export function createMcpServer(bridge: FeishuBridge, config: Config): Server {
  const server = new Server(
    { name: 'feishu-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'feishu_notify',
        description: '发送飞书通知消息，不等待回复。适用于进度汇报、阶段完成通知、非阻断性异常告知。',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: '通知内容' },
            target: { type: 'string', description: '目标聊天 JID（可选，覆盖默认 notify target）' },
          },
          required: ['message'],
        },
      },
      {
        name: 'feishu_ask',
        description: '通过飞书向用户提问并同步等待回复。用于需要用户确认方向、补充信息或审批操作的场景。question 必须说明：正在做什么、为什么需要确认、明确的选项。',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '问题内容（说明正在做什么、为什么需要确认、列出明确选项）' },
            target: { type: 'string', description: '目标聊天 JID（可选，覆盖默认 confirm target）' },
            timeout: { type: 'number', description: '等待超时秒数（可选）' },
          },
          required: ['question'],
        },
      },
      {
        name: 'feishu_summary',
        description: '发送任务总结到飞书，不等待回复。整个任务完成后调用，内容应包括：完成了什么、遗留了什么、需要用户跟进的。',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '任务总结（完成了什么 / 遗留了什么 / 需要跟进的）' },
            target: { type: 'string', description: '目标聊天 JID（可选，覆盖默认 summary target）' },
          },
          required: ['summary'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (name === 'feishu_notify') {
      const target = (args.target as string) ?? config.targets.notify;
      await bridge.sendMessage(target, args.message as string);
      return { content: [{ type: 'text', text: JSON.stringify({ sent: true }) }] };
    }

    if (name === 'feishu_ask') {
      const target = (args.target as string) ?? config.targets.confirm;
      const timeoutMs = ((args.timeout as number) ?? config.timeout) * 1000;
      const question = formatAskMessage(args.question as string);
      await bridge.sendMessage(target, question);
      const reply = await bridge.waitForReply(target, timeoutMs);
      return { content: [{ type: 'text', text: JSON.stringify({ reply }) }] };
    }

    if (name === 'feishu_summary') {
      const target = (args.target as string) ?? config.targets.summary;
      await bridge.sendMessage(target, args.summary as string);
      return { content: [{ type: 'text', text: JSON.stringify({ sent: true }) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}
```

Save to: `~/.claude/skills/feishu-bridge/bridge/src/mcp.ts`

- [ ] **Step 2: Implement index.ts**

```typescript
// src/index.ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { FeishuBridge } from './feishu.js';
import { startHttpServer } from './http.js';
import { createMcpServer } from './mcp.js';
import { ensureInbox } from './inbox.js';

async function main() {
  const config = loadConfig();
  ensureInbox();

  const bridge = new FeishuBridge(config.appId, config.appSecret, config.allowedSenders);
  await bridge.connect();

  startHttpServer(bridge, config);

  const mcpServer = createMcpServer(bridge, config);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  console.error('feishu-bridge failed to start:', err);
  process.exit(1);
});
```

Save to: `~/.claude/skills/feishu-bridge/bridge/src/index.ts`

- [ ] **Step 3: Build and confirm it compiles**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npm run build 2>&1
```

Expected: `dist/` directory created, no TypeScript errors.

- [ ] **Step 4: Run all tests**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run
```

Expected: all tests pass (config, messages, inbox, feishu, http).

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && git add src/mcp.ts src/index.ts && git commit -m "feat: add MCP tools and entry point"
```

---

## Task 8: Hook Scripts

**Files:**
- Create: `~/.claude/skills/feishu-bridge/bridge/scripts/intercept-bash.sh`
- Create: `~/.claude/skills/feishu-bridge/bridge/scripts/check-inbox.sh`
- Create: `~/.claude/skills/feishu-bridge/bridge/scripts/on-stop.sh`

- [ ] **Step 1: Write intercept-bash.sh**

```bash
#!/usr/bin/env bash
# PreToolUse hook: intercept high-risk Bash commands and request Feishu confirmation.
# Exit 0 = allow. Exit 2 = block. Exit 1 = fatal error (also blocks).

TOOL_INPUT="${CLAUDE_TOOL_INPUT:-}"
PORT="${FEISHU_BRIDGE_PORT:-7730}"

HIGH_RISK_PATTERNS=(
  "git push.*--force"
  "git push.*-f "
  "rm -rf"
  "git reset --hard"
  "git checkout -- \."
  "git restore \."
  "DROP TABLE"
  "DROP DATABASE"
)

matches_high_risk() {
  local input="$1"
  for pattern in "${HIGH_RISK_PATTERNS[@]}"; do
    if echo "$input" | grep -qE "$pattern"; then
      return 0
    fi
  done
  return 1
}

# Silently pass if bridge is not running
if ! curl -s --max-time 1 "http://localhost:${PORT}/health" > /dev/null 2>&1; then
  exit 0
fi

if matches_high_risk "$TOOL_INPUT"; then
  ESCAPED=$(printf '%s' "$TOOL_INPUT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
  PAYLOAD="{\"question\": ${ESCAPED}, \"context\": \"高风险操作，需要你确认\"}"

  REPLY=$(curl -s --max-time 1800 -X POST "http://localhost:${PORT}/ask" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>/dev/null)

  if [ $? -ne 0 ] || [ -z "$REPLY" ]; then
    exit 0  # curl failure — don't block
  fi

  APPROVED=$(echo "$REPLY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('approved','false'))" 2>/dev/null)
  if [ "$APPROVED" != "True" ] && [ "$APPROVED" != "true" ]; then
    REPLY_TEXT=$(echo "$REPLY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))" 2>/dev/null)
    echo "❌ 飞书拒绝了此操作：${REPLY_TEXT}" >&2
    exit 2
  fi
fi

exit 0
```

Save to: `~/.claude/skills/feishu-bridge/bridge/scripts/intercept-bash.sh`

- [ ] **Step 2: Write check-inbox.sh**

```bash
#!/usr/bin/env bash
# PreToolUse hook: inject pending Feishu messages into Claude Code context via stderr.

INBOX="${HOME}/.claude/feishu-inbox"

if [ -d "$INBOX" ] && [ -n "$(ls -A "$INBOX" 2>/dev/null)" ]; then
  echo "" >&2
  echo "=== 飞书新消息（来自你的主动发送）===" >&2
  for f in "$INBOX"/*.txt; do
    [ -f "$f" ] || continue
    cat "$f" >&2
    echo "" >&2
  done
  rm -f "$INBOX"/*.txt
fi

exit 0
```

Save to: `~/.claude/skills/feishu-bridge/bridge/scripts/check-inbox.sh`

- [ ] **Step 3: Write on-stop.sh**

```bash
#!/usr/bin/env bash
# Stop hook: send task summary to Feishu when response is long enough.

RESPONSE="${CLAUDE_RESPONSE:-}"
PORT="${FEISHU_BRIDGE_PORT:-7730}"
MIN_LENGTH="${FEISHU_SUMMARY_MIN_LENGTH:-500}"

if [ "${#RESPONSE}" -lt "$MIN_LENGTH" ]; then
  exit 0
fi

# Silently pass if bridge is not running
if ! curl -s --max-time 1 "http://localhost:${PORT}/health" > /dev/null 2>&1; then
  exit 0
fi

ESCAPED=$(printf '%s' "$RESPONSE" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
curl -s --max-time 10 -X POST "http://localhost:${PORT}/summary" \
  -H "Content-Type: application/json" \
  -d "{\"summary\": ${ESCAPED}}" > /dev/null 2>&1

exit 0
```

Save to: `~/.claude/skills/feishu-bridge/bridge/scripts/on-stop.sh`

- [ ] **Step 4: Make scripts executable**

```bash
chmod +x ~/.claude/skills/feishu-bridge/bridge/scripts/*.sh
```

- [ ] **Step 5: Smoke-test intercept-bash.sh**

```bash
CLAUDE_TOOL_INPUT="rm -rf /tmp/testdir" \
  ~/.claude/skills/feishu-bridge/bridge/scripts/intercept-bash.sh
echo "exit code: $?"
```

Expected: exit code 0 (bridge not running, so it silently allows).

- [ ] **Step 6: Smoke-test check-inbox.sh**

```bash
mkdir -p ~/.claude/feishu-inbox
echo "[Test message]" > ~/.claude/feishu-inbox/test.txt
~/.claude/skills/feishu-bridge/bridge/scripts/check-inbox.sh 2>&1
ls ~/.claude/feishu-inbox/
```

Expected: message printed to stderr, `test.txt` deleted, `feishu-inbox/` empty.

- [ ] **Step 7: Commit**

```bash
cd ~/.claude/skills/feishu-bridge && git add bridge/scripts/ && git commit -m "feat: add PreToolUse and Stop hook scripts"
```

---

## Task 9: SKILL.md

**Files:**
- Create: `~/.claude/skills/feishu-bridge/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

````markdown
---
name: feishu-bridge
description: Add Feishu bidirectional communication to Claude Code. Install so Claude can notify you, ask for confirmation, and receive your Feishu messages during complex tasks. Also use when troubleshooting the Feishu bridge or when Claude needs guidance on when to call feishu_notify / feishu_ask / feishu_summary.
---

# Feishu Bridge for Claude Code

Adds three MCP tools — `feishu_notify`, `feishu_ask`, `feishu_summary` — and two PreToolUse hooks and a Stop hook that wire Feishu into the Claude Code execution loop.

---

## Phase 1: Pre-flight

Check if already installed:

```bash
ls ~/.claude/feishu-bridge/dist/index.js 2>/dev/null && echo "already installed"
```

If already installed, skip to Phase 5 (Verify) to test the connection.

Collect credentials using `AskUserQuestion`:

1. **Feishu App ID** (format: `cli_xxx`) — from open.feishu.cn → Developer Console → your app → Credentials & Basic Info
2. **Feishu App Secret** — same page
3. **Notify target** — group chat ID (format: `oc_xxx`); send `/chatid` to the bot in that group to get it
4. **Confirm target** — private chat ID (format: `p2p_xxx`); send `/chatid` to the bot in a DM to get it; or press Enter to use the same group as notify
5. **Your Feishu open_id** (format: `ou_xxx`) — used for allowedSenders; leave blank to allow any sender; get it from the Feishu open platform or by calling the bot API

If the user doesn't have a Feishu App ID yet, guide them to:
1. Go to [open.feishu.cn](https://open.feishu.cn) → Developer Console → Create App → Custom App
2. In Permissions & Scopes, enable: `im:message`, `im:message:send_as_bot`, `im:chat`
3. In Event Subscriptions, choose **"Use long-connection to receive events"** (not webhook)
4. Subscribe to event: `im.message.receive_v1`
5. Copy App ID and App Secret

---

## Phase 2: Install Bridge

```bash
# Copy bridge source to install location
cp -r ~/.claude/skills/feishu-bridge/bridge ~/.claude/feishu-bridge

# Install dependencies and build
cd ~/.claude/feishu-bridge && npm install && npm run build

# Make hook scripts executable
chmod +x ~/.claude/feishu-bridge/scripts/*.sh

# Create inbox directory
mkdir -p ~/.claude/feishu-inbox
```

---

## Phase 3: Write Configuration

Write `~/.claude/feishu-bridge.json` with the collected values:

```json
{
  "appId": "<APP_ID>",
  "appSecret": "<APP_SECRET>",
  "httpPort": 7730,
  "timeout": 1800,
  "summaryMinLength": 500,
  "targets": {
    "notify":  "fs:<NOTIFY_CHAT_ID>",
    "confirm": "fs:<CONFIRM_CHAT_ID>",
    "summary": "fs:<NOTIFY_CHAT_ID>"
  },
  "allowedSenders": ["<YOUR_OPEN_ID>"]
}
```

Note: `allowedSenders` should be `[]` (empty array) if the user left open_id blank.

Update `~/.claude/settings.json` — read the current file first, then merge in:

```json
{
  "mcpServers": {
    "feishu-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["<HOME>/.claude/feishu-bridge/dist/index.js"]
    }
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "<HOME>/.claude/feishu-bridge/scripts/intercept-bash.sh" }]
      },
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "<HOME>/.claude/feishu-bridge/scripts/check-inbox.sh" }]
      }
    ],
    "Stop": [
      { "type": "command", "command": "<HOME>/.claude/feishu-bridge/scripts/on-stop.sh" }
    ]
  },
  "permissions": {
    "allow": ["Bash(curl http://localhost:7730/*)"]
  }
}
```

Replace `<HOME>` with the actual absolute path (use `os.homedir()` or `$HOME` expansion). Do NOT use `~` in settings.json — it is not expanded.

---

## Phase 4: Get open_id (if needed)

If the user wants to restrict replies to themselves (recommended), they need their `open_id`. To get it:

```bash
# Temporary: call the Feishu API to get bot info (shows users who have interacted)
# Or: use the Feishu open platform → "API Explorer" → im.v1.message.list on a DM
```

Alternative: leave `allowedSenders` empty for now and set it later once the user knows their open_id.

---

## Phase 5: Verify

Tell the user to **restart Claude Code** so the new MCP server is loaded.

After restart, call:

```typescript
feishu_notify("🎉 Feishu Bridge 连接成功！Claude Code 已可通过飞书与你通信。")
```

Expected: message appears in the configured notify chat within a few seconds.

If it doesn't arrive:
1. Check `~/.claude/feishu-bridge.json` — ensure appId, appSecret, and targets are correct
2. Ensure the bot has been added to the target chat (for groups) or has a DM with you (for p2p)
3. Ensure Event Subscriptions uses **long-connection mode** (not webhook) in the Feishu console
4. Check that `im.message.receive_v1` is subscribed

---

## Claude Behavior Guide

The MCP tools are available throughout every Claude Code session. Use them as follows.

### feishu_notify — when to call

Call **before** starting a long or complex task:
```
feishu_notify("开始执行：重构认证模块。预计需要 10-15 分钟，涉及 8 个文件。")
```

Call **after** completing a significant phase:
```
feishu_notify("✅ 数据库迁移完成（0045_add_user_roles）。所有测试通过，准备部署。")
```

Call when a **non-blocking anomaly** is found that the user should know:
```
feishu_notify("⚠️ 发现 3 处未使用的导入，已忽略（不影响功能）。")
```

### feishu_ask — when to call

Call when **requirements are ambiguous** and you cannot proceed without clarification:
```
feishu_ask("需要确认：删除旧的 v1 API 端点（/api/v1/*），还是保留并标记为 deprecated？这将影响 4 个文件。")
```

Call when a **contradiction** is found between requirements and code:
```
feishu_ask("发现矛盾：需求说使用 Redis 缓存，但代码中已有 Memcached 实现且有现有数据。请问：A) 迁移到 Redis B) 保留 Memcached C) 两者并行？")
```

Call at **planned checkpoints** in multi-step tasks:
```
feishu_ask("第一阶段完成（数据模型 + 迁移脚本已就绪）。继续执行第二阶段（API 端点实现）？")
```

**feishu_ask question format must include:**
1. What is currently happening / about to happen
2. Why confirmation is needed
3. Clear options the user can choose from

### feishu_summary — when to call

Call at the **end of a complete task** (the Stop hook also triggers automatically, but call this for richer structured summaries):
```
feishu_summary("✅ 认证模块重构完成\n\n完成：JWT 令牌验证、刷新令牌逻辑、单元测试（覆盖率 87%）\n遗留：集成测试需要在 staging 环境运行\n需跟进：请在 staging 验证后合并 PR #142")
```

### Handling timeout

When `feishu_ask` returns `{ reply: "timeout" }`:
- For **approval requests** (proceeding with an action): default to **cancel**. Tell the user: "飞书确认超时，已取消操作。如需继续请重新运行任务。"
- For **information requests** (clarifying ambiguity): proceed with best-effort interpretation using existing context. Note in your response: "未收到飞书回复，已根据已知信息处理，请确认结果是否符合预期。"

### feishu_ask message length

Keep questions concise (under 200 characters). If context is complex, summarize the key decision point. The user is likely on mobile.
````

Save to: `~/.claude/skills/feishu-bridge/SKILL.md`

- [ ] **Step 2: Verify frontmatter is valid YAML**

```bash
python3 -c "
import re, sys
content = open('$HOME/.claude/skills/feishu-bridge/SKILL.md').read()
m = re.match(r'^---\n(.+?)\n---', content, re.DOTALL)
print('Frontmatter OK' if m else 'ERROR: no frontmatter')
"
```

Expected: `Frontmatter OK`

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/feishu-bridge && git add SKILL.md && git commit -m "feat: add SKILL.md with install guide and Claude behavior guide"
```

---

## Task 10: setup.ts + End-to-End Verification

**Files:**
- Create: `~/.claude/skills/feishu-bridge/setup.ts`

- [ ] **Step 1: Implement setup.ts**

```typescript
#!/usr/bin/env tsx
// setup.ts — Interactive installer for feishu-bridge
// Usage: npx tsx ~/.claude/skills/feishu-bridge/setup.ts

import * as readline from 'readline/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const BRIDGE_INSTALL_DIR = path.join(CLAUDE_DIR, 'feishu-bridge');
const CONFIG_PATH = path.join(CLAUDE_DIR, 'feishu-bridge.json');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const INBOX_DIR = path.join(CLAUDE_DIR, 'feishu-inbox');
const BRIDGE_SRC = path.join(__dirname, 'bridge');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(prompt: string, defaultVal = ''): Promise<string> {
  const answer = await rl.question(defaultVal ? `${prompt} [${defaultVal}]: ` : `${prompt}: `);
  return answer.trim() || defaultVal;
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main() {
  console.log('\n🚀 Feishu Bridge for Claude Code — Interactive Setup\n');

  // Pre-flight
  if (fs.existsSync(BRIDGE_INSTALL_DIR) && fs.existsSync(CONFIG_PATH)) {
    const answer = await ask('⚠️  feishu-bridge is already installed. Reinstall? (y/N)', 'N');
    if (answer.toLowerCase() !== 'y') {
      console.log('Skipping. Run `feishu_notify("test")` in Claude Code to verify.');
      rl.close();
      return;
    }
  }

  console.log('\n--- Feishu App Credentials ---');
  const appId = await ask('App ID (cli_xxx)');
  const appSecret = await ask('App Secret');

  console.log('\n--- Routing Targets ---');
  console.log('Get chat IDs by adding the bot and sending /chatid in that chat.\n');
  const notifyRaw = await ask('Notify target chat ID (oc_xxx for group, p2p_xxx for DM)');
  const confirmRaw = await ask('Confirm target chat ID (recommended: your DM p2p_xxx)', notifyRaw);
  const summaryRaw = await ask('Summary target chat ID', notifyRaw);

  console.log('\n--- Security ---');
  const openId = await ask('Your Feishu open_id (ou_xxx) — leave blank to allow any sender', '');

  // Install bridge
  console.log('\n📦 Copying bridge source...');
  copyDir(BRIDGE_SRC, BRIDGE_INSTALL_DIR);
  fs.mkdirSync(INBOX_DIR, { recursive: true });

  console.log('Running npm install...');
  execSync('npm install', { cwd: BRIDGE_INSTALL_DIR, stdio: 'inherit' });

  console.log('Building TypeScript...');
  execSync('npm run build', { cwd: BRIDGE_INSTALL_DIR, stdio: 'inherit' });

  const scriptsDir = path.join(BRIDGE_INSTALL_DIR, 'scripts');
  for (const script of ['intercept-bash.sh', 'check-inbox.sh', 'on-stop.sh']) {
    const p = path.join(scriptsDir, script);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  }

  // Write config
  const config = {
    appId,
    appSecret,
    httpPort: 7730,
    timeout: 1800,
    summaryMinLength: 500,
    targets: {
      notify: `fs:${notifyRaw}`,
      confirm: `fs:${confirmRaw}`,
      summary: `fs:${summaryRaw}`,
    },
    allowedSenders: openId ? [openId] : [],
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`✅ Config written to ${CONFIG_PATH}`);

  // Update settings.json
  const settings = readSettings();
  const mcp = (settings.mcpServers ?? {}) as Record<string, unknown>;
  mcp['feishu-bridge'] = {
    type: 'stdio',
    command: 'node',
    args: [path.join(BRIDGE_INSTALL_DIR, 'dist', 'index.js')],
  };
  settings.mcpServers = mcp;

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  hooks.PreToolUse = ((hooks.PreToolUse ?? []) as unknown[]).filter(
    (h) => !JSON.stringify(h).includes('feishu-bridge'),
  );
  hooks.PreToolUse.push(
    { matcher: 'Bash', hooks: [{ type: 'command', command: path.join(scriptsDir, 'intercept-bash.sh') }] },
    { matcher: '.*', hooks: [{ type: 'command', command: path.join(scriptsDir, 'check-inbox.sh') }] },
  );
  hooks.Stop = ((hooks.Stop ?? []) as unknown[]).filter(
    (h) => !JSON.stringify(h).includes('feishu-bridge'),
  );
  hooks.Stop.push({ type: 'command', command: path.join(scriptsDir, 'on-stop.sh') });
  settings.hooks = hooks;

  const perms = (settings.permissions ?? { allow: [] }) as { allow: string[] };
  if (!perms.allow.includes('Bash(curl http://localhost:7730/*)')) {
    perms.allow.push('Bash(curl http://localhost:7730/*)');
  }
  settings.permissions = perms;

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`✅ settings.json updated`);

  console.log('\n✅ Setup complete!\n');
  console.log('Next steps:');
  console.log('1. Restart Claude Code to load the feishu-bridge MCP server');
  console.log('2. Ask Claude to run: feishu_notify("飞书连接测试") ');
  console.log('3. Check your Feishu for the message\n');

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Save to: `~/.claude/skills/feishu-bridge/setup.ts`

- [ ] **Step 2: Dry-run setup.ts (verify it runs without crashing on help/syntax check)**

```bash
cd ~/.claude/skills/feishu-bridge && npx tsx --version && echo "tsx available"
```

Expected: tsx version printed.

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/feishu-bridge && git add setup.ts && git commit -m "feat: add interactive setup script"
```

- [ ] **Step 4: Run full test suite one final time**

```bash
cd ~/.claude/skills/feishu-bridge/bridge && npx vitest run
```

Expected: all tests pass across config, messages, inbox, feishu, http modules.

- [ ] **Step 5: End-to-end verification (requires real Feishu credentials)**

Run the setup script, then restart Claude Code, then ask Claude to call:
```
feishu_notify("🎉 Feishu Bridge 测试成功！")
```

Expected: message arrives in configured Feishu chat within 3 seconds.

- [ ] **Step 6: Test high-risk interception**

With the bridge running (Claude Code session active), ask Claude to run:
```bash
# Test that non-risky commands pass through without prompting
ls /tmp
```

Then ask Claude to attempt:
```bash
rm -rf /tmp/feishu-test-nonexistent
```

Expected: hook fires, Feishu message sent to confirm target, execution pauses.

- [ ] **Step 7: Final commit**

```bash
cd ~/.claude/skills/feishu-bridge && git add -A && git commit -m "feat: complete feishu-bridge Claude Code skill"
```

---

## Checklist: Spec Coverage

| Spec requirement | Task |
|-----------------|------|
| Standalone (no NanoClaw dep) | Task 1 — independent npm package |
| Sync blocking + timeout | Task 5 (feishu.ts waitForReply) |
| MCP stdio mode | Task 7 (mcp.ts + index.ts) |
| feishu_notify | Task 7 |
| feishu_ask | Task 7 |
| feishu_summary | Task 7 |
| High-risk hook interception | Task 8 (intercept-bash.sh) |
| Inbox injection | Task 8 (check-inbox.sh) |
| Stop hook summary | Task 8 (on-stop.sh) |
| Three routing targets | Task 2 (config.ts), Task 6 (http.ts) |
| allowedSenders security | Task 5 (feishu.ts) |
| summaryMinLength config | Task 2, Task 8 |
| SKILL.md behavior guide | Task 9 |
| Interactive installer | Task 10 (setup.ts) |
