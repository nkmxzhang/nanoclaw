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
