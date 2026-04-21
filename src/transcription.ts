import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

const WHISPER_MODEL =
  process.env.WHISPER_MODEL ?? 'data/models/ggml-small.bin';

function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath, '-y'],
      { timeout: 30_000 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

export async function transcribeAudio(filePath: string): Promise<string | null> {
  if (!fs.existsSync(WHISPER_MODEL)) {
    logger.warn({ model: WHISPER_MODEL }, 'Whisper model file not found');
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  const needsConversion = ext !== '.wav';
  const wavPath = needsConversion
    ? path.join(os.tmpdir(), `nanoclaw-voice-${Date.now()}.wav`)
    : filePath;

  try {
    if (needsConversion) {
      await convertToWav(filePath, wavPath);
    }

    return await new Promise((resolve) => {
      execFile(
        'whisper-cli',
        ['-m', WHISPER_MODEL, '-f', wavPath, '-l', 'auto', '-nt'],
        { timeout: 60_000 },
        (err, stdout) => {
          if (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              logger.warn('whisper-cli not found — voice transcription unavailable');
            } else {
              logger.error({ err }, 'Transcription failed');
            }
            resolve(null);
            return;
          }
          const transcript = stdout.trim();
          resolve(transcript || null);
        },
      );
    });
  } catch (err: unknown) {
    const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (isEnoent) {
      logger.warn('ffmpeg not found — cannot convert audio for transcription');
    } else {
      logger.error({ err }, 'Audio conversion failed');
    }
    return null;
  } finally {
    if (needsConversion) {
      try { fs.unlinkSync(wavPath); } catch { /* already gone */ }
    }
  }
}
