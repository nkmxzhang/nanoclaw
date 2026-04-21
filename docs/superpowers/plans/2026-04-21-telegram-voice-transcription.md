# Telegram Voice Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe Telegram voice and audio messages on-device using whisper-cli before delivering them to the agent.

**Architecture:** Add a shared `src/transcription.ts` module that wraps `whisper-cli`. The Telegram channel's `storeMedia` closure gains a `transcribe` option; when set, it downloads the file, calls `transcribeAudio()` on the host path, and delivers `[Voice: <text>]` instead of the raw placeholder.

**Tech Stack:** whisper-cli (whisper.cpp via Homebrew), Node.js `child_process.execFile`, TypeScript, Vitest.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/transcription.ts` | Create | whisper-cli wrapper: `transcribeAudio(hostPath)` |
| `src/transcription.test.ts` | Create | Unit tests for all transcription paths |
| `src/channels/telegram.ts` | Modify | Pass `transcribe: true` for voice/audio; convert host path; integrate result |
| `.env` | Modify | Add `WHISPER_MODEL=data/models/ggml-medium.bin` |
| `.gitignore` | Modify | Ignore `data/models/` |

---

## Task 1: Install whisper-cpp and download model

**Files:**
- Modify: `.env`
- Modify: `.gitignore`

- [ ] **Step 1: Install whisper-cpp via Homebrew**

```bash
brew install whisper-cpp
```

Verify:
```bash
whisper-cli --help 2>&1 | head -5
```
Expected: usage/help output (not "command not found").

- [ ] **Step 2: Confirm available flags**

```bash
whisper-cli --help 2>&1 | grep -E "\-f |\-m |\-l |\-nt|no-timestamps|no-prints"
```

Note the exact flag for suppressing timestamps (likely `-nt` or `--no-timestamps`) — you'll use it in Task 2.

- [ ] **Step 3: Create model directory and download medium model**

```bash
mkdir -p data/models
curl -L -o data/models/ggml-medium.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin
```

Download is ~1.5 GB. Verify it finished:
```bash
ls -lh data/models/ggml-medium.bin
```
Expected: file ~1.5G.

- [ ] **Step 4: Quick smoke test**

Record or find any short audio file (`.ogg` or `.mp3`) and run:
```bash
whisper-cli -m data/models/ggml-medium.bin -f /path/to/test.ogg -l auto
```
Expected: transcript printed to stdout.

- [ ] **Step 5: Add WHISPER_MODEL to .env**

Append to `.env`:
```
WHISPER_MODEL=data/models/ggml-medium.bin
```

- [ ] **Step 6: Gitignore model files**

Append to `.gitignore`:
```
# Whisper model files (large binaries, not versioned)
data/models/
```

- [ ] **Step 7: Commit**

```bash
git add .env .gitignore
git commit -m "chore: add whisper-cpp model and env config"
```

---

## Task 2: Create transcription module (TDD)

**Files:**
- Create: `src/transcription.ts`
- Create: `src/transcription.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/transcription.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing transcription
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mock fs.existsSync
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

import { transcribeAudio } from './transcription.js';
import fs from 'fs';
import { logger } from './logger.js';

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it('returns transcript on success', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, '  Hello world  \n', '');
      },
    );
    const result = await transcribeAudio('/tmp/voice.ogg');
    expect(result).toBe('Hello world');
  });

  it('returns null when model file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await transcribeAudio('/tmp/voice.ogg');
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.any(String) }),
      'Whisper model file not found',
    );
  });

  it('returns null when whisper-cli is not installed (ENOENT)', async () => {
    const err: any = new Error('not found');
    err.code = 'ENOENT';
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(err, '', '');
      },
    );
    const result = await transcribeAudio('/tmp/voice.ogg');
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'whisper-cli not found — voice transcription unavailable',
    );
  });

  it('returns null when transcription process fails', async () => {
    const err = new Error('process error');
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(err, '', '');
      },
    );
    const result = await transcribeAudio('/tmp/voice.ogg');
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err }),
      'Transcription failed',
    );
  });

  it('returns null for empty transcript output', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, '   \n  ', '');
      },
    );
    const result = await transcribeAudio('/tmp/voice.ogg');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/transcription.test.ts
```

Expected: FAIL — `transcription.ts` does not exist yet.

- [ ] **Step 3: Implement src/transcription.ts**

Create `src/transcription.ts`:

```typescript
import { execFile } from 'child_process';
import fs from 'fs';
import { logger } from './logger.js';

const WHISPER_MODEL =
  process.env.WHISPER_MODEL ?? 'data/models/ggml-medium.bin';

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
```

> **Note on flags:** `-nt` suppresses timestamps in whisper.cpp. If the smoke test in Task 1 Step 2 showed a different flag name (e.g., `--no-timestamps`), use that instead.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/transcription.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transcription.ts src/transcription.test.ts
git commit -m "feat: add transcribeAudio module wrapping whisper-cli"
```

---

## Task 3: Integrate transcription into telegram.ts

**Files:**
- Modify: `src/channels/telegram.ts` (lines 239–325)

- [ ] **Step 1: Add transcription import to telegram.ts**

At the top of `src/channels/telegram.ts`, after existing imports, add:

```typescript
import { transcribeAudio } from './transcription.js';
```

- [ ] **Step 2: Add `transcribe` option to storeMedia opts**

Find the `storeMedia` function signature (around line 239):

```typescript
const storeMedia = (
  ctx: any,
  placeholder: string,
  opts?: { fileId?: string; filename?: string },
) => {
```

Change to:

```typescript
const storeMedia = (
  ctx: any,
  placeholder: string,
  opts?: { fileId?: string; filename?: string; transcribe?: boolean },
) => {
```

- [ ] **Step 3: Update the download callback to call transcription**

Find the async download block inside `storeMedia` (around line 284):

```typescript
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }
```

Replace with:

```typescript
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          async (filePath) => {
            if (filePath && opts?.transcribe) {
              const attachFilename = filePath.split('/').pop()!;
              const hostPath = path.join(
                resolveGroupFolderPath(group.folder),
                'attachments',
                attachFilename,
              );
              const transcript = await transcribeAudio(hostPath);
              if (transcript) {
                deliver(`[Voice: ${transcript}]${caption}`);
              } else {
                deliver(`[Voice message - transcription failed]${caption}`);
              }
            } else if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }
```

> **Note:** `path` is already imported at the top of `telegram.ts` as `import path from 'path'`. Replace `require('path').join` with `path.join`.

- [ ] **Step 4: Pass `transcribe: true` for voice and audio handlers**

Find the voice handler (around line 315):

```typescript
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
```

Replace with:

```typescript
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
        transcribe: true,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
        transcribe: true,
      });
    });
```

- [ ] **Step 5: Build to check for type errors**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Add telegram.test.ts tests for transcription**

In `src/channels/telegram.test.ts`, add a mock for the new transcription module at the top (with other mocks):

```typescript
// Mock transcription module
const mockTranscribeAudio = vi.fn();
vi.mock('./transcription.js', () => ({ transcribeAudio: mockTranscribeAudio }));
```

Then add a new `describe` block at the end of the test file:

```typescript
describe('voice message transcription', () => {
  beforeEach(() => {
    mockTranscribeAudio.mockReset();
  });

  it('delivers [Voice: transcript] when transcription succeeds', async () => {
    mockTranscribeAudio.mockResolvedValue('今天天气很好');
    mockDownloadFile.mockResolvedValue(
      '/workspace/group/attachments/voice_42.ogg',
    );

    const voiceHandler = captureHandler('message:voice');
    const ctx = makeCtx({ voice: { file_id: 'fid_voice' }, message_id: 42 });
    voiceHandler(ctx);

    await vi.waitFor(() =>
      expect(mockOnMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: '[Voice: 今天天气很好]',
        }),
      ),
    );
  });

  it('delivers fallback when transcription returns null', async () => {
    mockTranscribeAudio.mockResolvedValue(null);
    mockDownloadFile.mockResolvedValue(
      '/workspace/group/attachments/voice_43.ogg',
    );

    const voiceHandler = captureHandler('message:voice');
    const ctx = makeCtx({ voice: { file_id: 'fid_voice' }, message_id: 43 });
    voiceHandler(ctx);

    await vi.waitFor(() =>
      expect(mockOnMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: '[Voice message - transcription failed]',
        }),
      ),
    );
  });
});
```

> **Note:** Before writing these tests, read `src/channels/telegram.test.ts` to find the actual names of the existing mock/helper functions (e.g. how media handler tests set up a fake `message:voice` context, capture the `onMessage` callback, and trigger the handler). Adapt the test code above to match those patterns exactly.

- [ ] **Step 7: Run all channel tests**

```bash
npx vitest run src/channels/telegram.test.ts
```

Expected: all tests pass (including new transcription tests).

- [ ] **Step 8: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat: transcribe Telegram voice/audio messages via whisper-cli"
```

---

## Task 4: End-to-end verification

- [ ] **Step 1: Rebuild and restart service**

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 2: Send a voice message in the Telegram group**

Send a short voice message in the NanoClaw001 group.

- [ ] **Step 3: Verify transcript in logs**

```bash
tail -f logs/nanoclaw.log
```

Expected: message stored event with content `[Voice: <transcript text>]` (not the old `[Voice message]` placeholder).

- [ ] **Step 4: Confirm agent replies to the transcript**

The agent should receive the transcribed text and reply normally. Verify in Telegram.
