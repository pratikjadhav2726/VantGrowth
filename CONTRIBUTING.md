# Contributing to GrowthOS

Thanks for contributing to GrowthOS.

## Development setup

Prerequisites:

- Node.js 22+
- pnpm 10+
- Docker (recommended for local stack)

Install:

```bash
pnpm install
```

Run app locally:

```bash
pnpm dev
```

Run Docker demo stack:

```bash
cp .env.example .env
docker compose -f compose.dev.yaml up --build -d
```

## Branch and PR workflow

1. Fork the repository.
2. Create a feature branch from `main`.
3. Keep changes focused and small.
4. Add or update tests when behavior changes.
5. Open a PR with:
   - what changed
   - why it changed
   - how it was tested
   - screenshots for UI changes

## Quality checks

Before opening a PR:

```bash
pnpm check
pnpm typecheck
pnpm test
```

If your change touches DB migration logic:

```bash
pnpm migrate:dry-run
pnpm atlas:validate
pnpm atlas:lint
```

## Coding expectations

- Keep code tenant-scoped and explicit.
- Prefer typed boundaries (Zod schemas and typed repositories).
- Avoid hidden side-effects and implicit global state.
- Keep API behavior backward compatible unless versioned.
- Add concise docs when adding new env vars, routes, or workflows.

## Commit messages

Use clear, descriptive messages:

- `feat(api): add workflow status endpoint`
- `fix(web): validate onboarding fields inline`
- `docs: add open-source user guide`

## Reporting issues

Use GitHub Issues with:

- expected behavior
- actual behavior
- reproducible steps
- logs/screenshots if relevant

For security issues, do not open a public issue. See `SECURITY.md`.
