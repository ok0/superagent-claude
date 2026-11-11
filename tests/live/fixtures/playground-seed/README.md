# Task tracker

This repository is the test playground for superagent-claude. It is not a real project: its issues and pull requests are opened and closed by automated tests, and nothing here is used in production.

## Layout

The `api` workspace is a small HTTP task API. Its source is split into the `src/config`, `src/auth`, `src/store`, `src/services`, `src/http` and `src/log` layers.

The `web` workspace is a React + Vite UI for the task list, status filter and new-task form (`npm run dev --workspace web` proxies `/api` to the API on port 3000; set `VITE_API_TOKEN` to a token from `API_TOKENS`).

## Commands

- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm start --workspace api`

## API

- `GET /health`
- `GET /tasks?limit&cursor`
- `POST /tasks`
- `GET /tasks/:id`
- `DELETE /tasks/:id`

Task routes require a Bearer token from `API_TOKENS`.

## Configuration

- `PORT` (3000)
- `PAGE_SIZE` (20)
- `MAX_PAGE_SIZE` (100)
- `API_TOKENS` (`user:token,user:token`)
- `LOG_LEVEL` (info)
- `FAKE_NOW` (ISO timestamp that pins the clock for local experiments)
