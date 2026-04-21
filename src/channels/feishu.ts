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
      loggerLevel: lark.LoggerLevel.error,
    });
  }

  async connect(): Promise<void> {
    // Fetch bot's own open_id for @mention detection
    try {
      const resp = await (this.client as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: {},
        params: {},
      });
      this.botOpenId = (resp as any)?.data?.bot?.open_id ?? '';
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info fetched');
    } catch (err) {
      logger.warn(
        { err },
        'Failed to fetch Feishu bot info — @mention injection disabled',
      );
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

    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });
    this.wsClient.start({ eventDispatcher }).catch((err: unknown) => {
      logger.error({ err }, 'Feishu WSClient error');
    });

    logger.info('Feishu WebSocket client started');
    console.log('\n  Feishu bot connected via WebSocket long-connection');
    console.log("  Send /chatid to the bot to get a chat's registration ID\n");
  }

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
        await this.sendMessage(
          chatJid,
          `Chat ID: \`${chatJid}\`\nType: ${message.chat_type}`,
        );
        return;
      }
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid },
        'Message from unregistered Feishu chat — ignoring',
      );
      return;
    }

    const mentions: unknown[] = message.mentions ?? [];

    switch (msgType) {
      case 'text':
        this.handleText(
          message,
          chatJid,
          senderId,
          timestamp,
          messageId,
          mentions,
        );
        break;
      case 'post':
        this.handlePost(
          message,
          chatJid,
          senderId,
          timestamp,
          messageId,
          mentions,
        );
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
        this.deliver(
          chatJid,
          `[Unsupported message type: ${msgType}]`,
          senderId,
          timestamp,
          messageId,
        );
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
    const contentObj = JSON.parse(message.content ?? '{}') as Record<
      string,
      any
    >;
    const lang: any =
      contentObj['zh_cn'] ??
      contentObj['en_us'] ??
      Object.values(contentObj)[0];
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

      // Strip directory components first, then replace any remaining unsafe chars
      const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
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

  // Stubs for media handlers — implemented in Tasks 6 and 7
  private handleImage(
    _m: any,
    _j: string,
    _s: string,
    _t: string,
    _g: RegisteredGroup,
  ): void {}
  private handleFile(
    _m: any,
    _j: string,
    _s: string,
    _t: string,
    _g: RegisteredGroup,
  ): void {}
  private handleAudio(
    _m: any,
    _j: string,
    _s: string,
    _t: string,
    _g: RegisteredGroup,
  ): void {}

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
      } as any);
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
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
    logger.warn(
      'Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set — channel disabled',
    );
    return null;
  }
  return new FeishuChannel(appId, appSecret, opts);
});
