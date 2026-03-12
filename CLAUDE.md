# CLAUDE.md - Exit Button WebSDK

## Project Overview

This is the Exit Button WebSDK - an AI-native cancel button that intercepts subscription cancellations, conducts real-time voice exit-interviews using AI, and generates personalized win-back offers.

## Repository Structure

```
/
├── packages/
│   ├── core/           # Shared types and API client
│   │   └── src/
│   │       ├── types.ts      # TypeScript interfaces
│   │       ├── api-client.ts # HTTP API client
│   │       └── index.ts      # Exports
│   │
│   ├── embed/          # Vanilla JS widget (<script> tag)
│   │   └── src/
│   │       ├── index.ts      # Main entry, auto-init
│   │       ├── modal.ts      # Modal DOM management
│   │       ├── voice.ts      # WebSocket voice handler
│   │       ├── styles.ts     # CSS-in-JS styles
│   │       └── icons.ts      # SVG icons
│   │
│   └── react/          # React SDK
│       └── src/
│           ├── context.tsx         # ExitButtonProvider
│           ├── hooks/
│           │   ├── useCancelFlow.ts  # Main orchestration
│           │   ├── useVoiceState.ts  # Voice connection
│           │   ├── useTranscript.ts  # Conversation history
│           │   └── useOffers.ts      # Win-back offers
│           ├── components/
│           │   └── CancelModal.tsx   # Modal component
│           └── index.ts
│
├── examples/
│   ├── vanilla-html/   # Simple HTML example
│   └── react-app/      # React example app
│
├── package.json        # Root workspace config
├── pnpm-workspace.yaml # pnpm workspaces
└── tsconfig.json       # Base TypeScript config
```

## Key Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Build specific package
pnpm build:core
pnpm build:embed
pnpm build:react

# Watch mode for development
pnpm dev

# Type check all packages
pnpm typecheck

# Clean build artifacts
pnpm clean
```

## Architecture

### Flow Sequence

1. User clicks "Cancel Subscription" button
2. Exit Button modal opens → `connecting` state
3. Session initiated via POST `/cancel/initiate`
4. Request microphone permission → `permission` state
5. WebSocket voice connection established → `interview` state
6. AI conducts empathetic exit interview
7. AI generates win-back offers → `offers` state
8. User accepts offer or proceeds with cancellation
9. Session completed via POST `/cancel/complete` → `done` state

### Modal States

- `closed` - Modal not visible
- `connecting` - Initializing session
- `permission` - Requesting microphone access
- `interview` - Active voice conversation
- `offers` - Displaying win-back offers
- `completing` - Processing final response
- `done` - Thank you + close
- `error` - Error with retry option

### API Endpoints

- `POST /cancel/initiate` - Start cancellation session
- `WSS /cancel/voice` - Real-time voice interview
- `POST /cancel/complete` - Finalize session
- `GET /cancel/sessions/:id` - Get session details

### Voice Protocol

WebSocket messages follow OpenAI Realtime API format:

**Client → Server:**
- `input_audio_buffer.append` - Send audio chunk (base64 PCM16)
- `input_audio_buffer.commit` - End of utterance
- `conversation.item.create` - Text fallback

**Server → Client:**
- `audio` - AI voice response (base64)
- `transcript` - Real-time transcript
- `interview_complete` - Interview finished
- `offers` - Win-back offers generated
- `error` - Error occurred

## Coding Guidelines

1. **TypeScript**: All code is written in TypeScript with strict mode
2. **Build Tool**: Using `tsup` for bundling (esbuild under the hood)
3. **Package Manager**: pnpm with workspaces
4. **Styling**: CSS-in-JS for embed, inline styles for React
5. **Target**: ES2020, supports modern browsers

## Bundle Size Target

- Embed widget: <25KB gzipped
- React SDK: <15KB gzipped (excluding React)

## Testing

When making changes:
1. Run `pnpm typecheck` to ensure no type errors
2. Build with `pnpm build` to verify bundle
3. Test the embed widget in `examples/vanilla-html/`
4. Test React SDK in `examples/react-app/`

## Important Notes

- The API base URL is `https://api.tranzmitai.com/v1`
- API keys start with `eb_live_` (production) or `eb_test_` (test)
- Voice uses WebSocket at `wss://api.tranzmitai.com/v1/cancel/voice`
- Microphone fallback: If mic unavailable, use text input
- Accessibility: WCAG 2.1 AA compliance required

## Pre-Churn Voice Widget (`packages/widget`)

A standalone polling widget that enables on-demand voice interview popups.

### How it works

1. Embed `widget.js` on your site with `TRANZMIT_WIDGET_CONFIG` set
2. The widget polls `GET /api/widget/check` every 5 seconds
3. Trigger a popup from the dashboard (or `POST /api/widget/trigger`)
4. A glass-morphism invite popup appears for the target user
5. Clicking "Start Voice Interview" loads `embed.js` and launches the full voice interview

### Widget config

```html
<script>
  window.TRANZMIT_WIDGET_CONFIG = {
    apiKey:      'eb_live_...',               // Your Tranzmit API key
    endpoint:    'https://api.tranzmitai.com', // Your Tranzmit backend URL
    distinctId:  currentUser.id,              // Logged-in user's distinct ID
    pollInterval: 5000,                       // Optional, default 5000ms
  };
</script>
<script src="https://api.tranzmitai.com/widget.js"></script>
```

### Widget backend endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/widget/trigger` | Bearer token | Queue a trigger for one or more users (from dashboard) |
| GET | `/api/widget/check` | `?key=` query param | Poll for a pending trigger (called by widget JS) |
| POST | `/api/widget/complete` | None (triggerId as secret) | Record outcome (clicked/dismissed) |

### Build

```bash
pnpm build:widget
```
