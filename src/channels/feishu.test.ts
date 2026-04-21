import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Hoisted mocks (must be declared before vi.mock calls) ---

const mockRequest = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { bot: { open_id: 'ou_bot123' } } }),
);
const mockMessageCreate = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockMessageResourceGet = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
);
const mockWsStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const capturedHandlers = vi.hoisted(
  () => ({}) as Record<string, (data: unknown) => Promise<void>>,
);

// --- Module mocks ---

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(function () {
    return {
      request: mockRequest,
      im: {
        message: { create: mockMessageCreate },
        messageResource: { get: mockMessageResourceGet },
      },
    };
  }),
  WSClient: vi.fn().mockImplementation(function () {
    return { start: mockWsStart };
  }),
  EventDispatcher: vi.fn().mockImplementation(function () {
    return {
      register: vi
        .fn()
        .mockImplementation(
          (handlers: Record<string, (data: unknown) => Promise<void>>) => {
            Object.assign(capturedHandlers, handlers);
            return { register: vi.fn() };
          },
        ),
    };
  }),
  LogLevel: { error: 'error' },
  LoggerLevel: { error: 1 },
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
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
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
    vi.resetModules();
    const { registerChannel: rc } = await import('./registry.js');
    await import('./feishu.js');
    expect(rc).toHaveBeenCalledWith('feishu', expect.any(Function));
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

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_abc123',
      expect.objectContaining({
        id: 'om_001',
        chat_jid: 'fs:oc_abc123',
        sender: 'ou_user1',
        content: 'hello world',
        is_from_me: false,
      }),
    );
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

    const mockWritable = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(mockWritable as any);

    const ch = new TestableFeishuChannel('id', 'secret', makeOpts());
    const result = await ch.testDownload(
      'om_001',
      'key_123',
      'image',
      'feishu_test',
      'image_001.jpg',
    );

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
    const result = await ch.testDownload(
      'om_001',
      'key_123',
      'image',
      'feishu_test',
      'image_001.jpg',
    );

    expect(result).toBeNull();
  });

  it('returns null and logs on SDK error', async () => {
    mockMessageResourceGet.mockRejectedValueOnce(new Error('API error'));
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

    const ch = new TestableFeishuChannel('id', 'secret', makeOpts());
    const result = await ch.testDownload(
      'om_001',
      'key_123',
      'file',
      'feishu_test',
      'doc.pdf',
    );

    expect(result).toBeNull();
  });

  it('sanitises dangerous characters in filename', async () => {
    const mockReadable = new Readable({ read() {} });
    mockReadable.push(null);
    mockMessageResourceGet.mockResolvedValueOnce(mockReadable);

    const mockWritable = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(mockWritable as any);

    const ch = new TestableFeishuChannel('id', 'secret', makeOpts());
    const result = await ch.testDownload(
      'om_001',
      'key_123',
      'file',
      'feishu_test',
      'evil/../../../etc/passwd',
    );

    // Sanitised name should not contain slashes
    expect(result).not.toContain('..');
    expect(result).not.toContain('/etc/');
  });
});

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
