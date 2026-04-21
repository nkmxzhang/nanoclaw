import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing transcription
vi.mock('child_process', () => ({ execFile: vi.fn() }));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mock fs — wrap in default to match how the project handles CJS fs mocking
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
    },
  };
});

import { transcribeAudio } from './transcription.js';
import fs from 'fs';
import { logger } from './logger.js';
import * as childProcess from 'child_process';

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it('returns transcript on success', async () => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, cb: any) => {
        cb(null, '  Hello world  \n', '');
        return {} as any;
      },
    );
    const result = await transcribeAudio('/tmp/voice.wav');
    expect(result).toBe('Hello world');
  });

  it('returns null when model file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await transcribeAudio('/tmp/voice.wav');
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.any(String) }),
      'Whisper model file not found',
    );
  });

  it('returns null when whisper-cli is not installed (ENOENT)', async () => {
    const err: any = new Error('not found');
    err.code = 'ENOENT';
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, cb: any) => {
        cb(err, '', '');
        return {} as any;
      },
    );
    const result = await transcribeAudio('/tmp/voice.wav');
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'whisper-cli not found — voice transcription unavailable',
    );
  });

  it('returns null when transcription process fails', async () => {
    const err = new Error('process error');
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, cb: any) => {
        cb(err, '', '');
        return {} as any;
      },
    );
    const result = await transcribeAudio('/tmp/voice.wav');
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err }),
      'Transcription failed',
    );
  });

  it('returns null for empty transcript output', async () => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, cb: any) => {
        cb(null, '   \n  ', '');
        return {} as any;
      },
    );
    const result = await transcribeAudio('/tmp/voice.wav');
    expect(result).toBeNull();
  });
});
