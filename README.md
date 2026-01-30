## Translate for Roam Research

Translate blocks inside your Roam graph using Deep Translate (RapidAPI). The extension detects source language (or lets you choose one) and writes the translated text into a new child block under the original.

Video walkthrough:
https://www.loom.com/share/2166ef87a8464af9b48deba226ed3d00

### Features
- Translate the current block or all child blocks in bulk.
- Single-language mode to save API calls on batches.
- Optional prompt to choose the source language.
- Compatible with Roam Research hotkeys and command palette.
- Built-in retry/backoff for transient API failures (429/502/503/504).

### Commands
- **Translate using Deep Translate (Current block)**
- **Translate using Deep Translate (All Child blocks, Same language)**
- **Translate using Deep Translate (All Child blocks, Multiple languages)**

### Settings (Roam Depot)
- **RapidAPI Key** 
  - Required. Get one from https://rapidapi.com/gatzuma/api/deep-translate1
- **Preferred Language** 
  - Two-letter ISO 639-1 code for the target language (default: `en`)
- **Always prompt for source language** 
  - When enabled, detection is skipped and you enter the source language manually.

### How it works
- Current block: detect (or prompt) -> translate -> write child block.
- Child blocks (same language): detect once on the first child, reuse for all.
- Child blocks (multiple languages): detect per child, then translate.

### Rate limits and retries
- The Basic plan shows hard limits and ~1000 requests/hour. This extension retries only on transient failures (429/502/503/504) with short exponential backoff. Auth or quota errors (401/403) are not retried.

### Privacy
- The text you translate is sent to the RapidAPI Deep Translate endpoint. Avoid sending sensitive content if that is a concern.

### Troubleshooting
- **401/403**: check RapidAPI key, plan, and host.
- **429**: you hit the rate limit; wait and retry.
- **Unexpected errors**: open the console; log messages are prefixed with `[translate]`.
