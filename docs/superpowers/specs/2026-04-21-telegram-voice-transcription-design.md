# Telegram Voice Transcription — Design Spec

**Date:** 2026-04-21
**Status:** Approved

## Overview

Add automatic voice message transcription to the Telegram channel using local whisper.cpp (whisper-cli). Voice messages are downloaded by the bot, transcribed on-device, and delivered to the agent as readable text. No audio data leaves the machine.

## Requirements

- Backend: local whisper.cpp (`whisper-cli` via Homebrew)
- Model: `ggml-medium.bin` (1.5GB, best accuracy for Chinese)
- Language: auto-detect (supports Chinese/English mixed)
- Transcription happens on the host before the message is stored
- Graceful degradation if whisper-cli is unavailable or fails

## Architecture

```
src/transcription.ts          ← new: shared whisper-cli wrapper
src/channels/telegram.ts      ← modified: call transcription for voice/audio
.env                          ← new var: WHISPER_MODEL
data/models/ggml-medium.bin   ← downloaded once, gitignored
```

## Components

### `src/transcription.ts` (new)

Single exported function:

```typescript
export async function transcribeAudio(filePath: string): Promise<string | null>
```

- Reads `WHISPER_MODEL` env var (default: `data/models/ggml-medium.bin`)
- Shells out: `whisper-cli -m <model> -f <filePath> --output-txt --no-prints` (exact flags confirmed against installed version during implementation)
- Returns transcript string on success, `null` on failure
- Logs warnings if model file is missing or binary not found

### `src/channels/telegram.ts` (modified)

Voice message handler (lines 311–316) and audio handler (lines 317–324):

- After downloading the file, call `transcribeAudio(localPath)`
- On success: store content as `[Voice: <transcript>]`
- On failure: keep existing placeholder `[Voice message] (<path>)`

### `.env` additions

```
WHISPER_MODEL=data/models/ggml-medium.bin
```

## Data Flow

1. User sends voice message in Telegram group
2. `downloadFile()` saves `.ogg` to `groups/telegram_main/attachments/voice_xxx.ogg`
3. `transcribeAudio()` calls `whisper-cli` with medium model
4. Transcript returned, message stored as `[Voice: 你好，今天天气怎么样]`
5. Agent receives readable text, responds normally

## Error Handling

| Failure | Behaviour |
|---------|-----------|
| `whisper-cli` not installed | Log warning, fall back to `[Voice message - transcription unavailable]` |
| Model file missing | Log warning, fall back to `[Voice message - transcription unavailable]` |
| Transcription process error | Log error, fall back to `[Voice message - transcription failed]` |
| Timeout (>60s) | Kill process, fall back to `[Voice message - transcription failed]` |

## Installation (one-time)

```bash
brew install whisper-cpp
mkdir -p data/models
curl -L -o data/models/ggml-medium.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin
```

Verify checksum after download.

## Testing

- Unit tests for `transcription.ts` with mocked `child_process`
- End-to-end: send a Telegram voice message and verify agent receives transcript
- Failure path: test with wrong model path to confirm graceful fallback

## Out of Scope

- WhatsApp/Slack/Discord voice support (future)
- Video message transcription
- Speaker diarization
