# Paperless Engineering Guide

This document outlines the standard development workflows, commands, and architectural patterns for the Paperless project.

## Development Workflows

### Prerequisites
- Node.js (v18+)
- MongoDB (Local or Atlas)

### Installation
Install dependencies across the monorepo from the root directory:
```bash
npm run install:all
```
This command automatically installs dependencies for both the `client` and `server` workspaces.

### Running the Application (Development)
The easiest way to run the application is to open two separate terminals:

**Terminal 1 (Backend):**
```bash
npm run server
```
*Note: Ensure your `server/.env` is configured with `MONGO_URI`.*

**Terminal 2 (Frontend):**
```bash
npm run client
```

### Code Quality

**Linting (ESLint):**
Run the linter across the entire project to catch JavaScript and React errors:
```bash
npm run lint
```

**Formatting (Prettier):**
Format all files:
```bash
npm run format
```
Check formatting (useful for CI):
```bash
npm run format:check
```

### Testing Architecture

Paperless uses **Vitest** for both frontend component testing and backend API/utility testing.
- Frontend tests run using `jsdom` and React Testing Library.
- Backend tests run in a standard `node` environment.
- Tests are co-located next to the code they are testing (e.g., `helpers.test.js`).

**Run tests once:**
```bash
npm run test
```

**Run tests in watch mode (interactive):**
```bash
npm run test:watch
```

## Architectural Service Abstractions

To isolate the core business logic from external third-party dependencies, Paperless enforces the use of Service Abstractions.

Do not directly import AWS, Resend, or OpenAI SDKs in controllers. Always use these abstractions:

1. **StorageService** (`server/src/services/StorageService.js`): Handles file uploads, deletions, and presigned URLs (Future: AWS S3).
2. **EmailService** (`server/src/services/EmailService.js`): Handles sending transactional emails like password resets and response notifications (Future: Resend).
3. **AIService** (`server/src/services/AIService.js`): Handles all LLM interactions, including form generation, wording improvement, and data summary.
   - **Provider Pattern:** `AIService` defines Zod schemas and delegates to `OpenAIProvider` (`server/src/services/OpenAIProvider.js`).
   - **Structured Outputs:** Uses OpenAI's structured outputs (`response_format: json_schema`). The application only interacts with valid, typed JavaScript objects instead of raw LLM text.
   - **Error Normalization:** `OpenAIProvider` maps SDK exceptions (e.g., 429 Rate Limit, network timeout, model refusal) to controlled internal error messages (`AI_RATE_LIMIT_EXCEEDED`, `AI_TIMEOUT`).
   - **Safeguards:** Features explicit size limits on prompts, configured model names, and distinct API route rate limiters (`aiLimiter`).
