# DraftPilot — Backend API

Backend service for the DraftPilot platform.

The backend receives draft data from the worker, persists state, and updates external systems (e.g. spreadsheets) via API.

➡️ **Project overview:** https://github.com/kevinperumal/draftpilot

## Responsibilities
- Receive draft data from the worker
- Persist and manage draft state
- Update spreadsheets and external services via API
- Expose APIs used by the frontend and worker

## Tech stack
TypeScript, NestJS, Google Sheets API

## Notes
Secrets and credentials are managed via environment variables and are not committed to the repository.
