import { execFile } from 'child_process';
import fs from 'fs';
import { logger } from './logger.js';

const WHISPER_MODEL =
  process.env.WHISPER_MODEL ?? 'data/models/ggml-small.bin';

export function transcribeAudio(filePath: string): Promise<string | null> {
  if (!fs.existsSync(WHISPER_MODEL)) {
    logger.warn({ model: WHISPER_MODEL }, 'Whisper model file not found');
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    execFile(
      'whisper-cli',
      ['-m', WHISPER_MODEL, '-f', filePath, '-l', 'auto', '-nt'],
      { timeout: 60_000 },
      (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.warn(
              'whisper-cli not found — voice transcription unavailable',
            );
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
}
