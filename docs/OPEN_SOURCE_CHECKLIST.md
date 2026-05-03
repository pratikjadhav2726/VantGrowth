# Open Source Readiness Checklist

Use this checklist before announcing or sharing the repository.

## Project metadata

- [ ] `README.md` clearly explains purpose and setup
- [ ] `LICENSE` exists and is accurate
- [ ] `CONTRIBUTING.md` exists
- [ ] `CODE_OF_CONDUCT.md` exists
- [ ] `SECURITY.md` exists

## Repository hygiene

- [ ] `.gitignore` excludes local and generated artifacts
- [ ] no secrets or tokens in tracked files
- [ ] sample env config is in `.env.example`
- [ ] generated build folders are not committed

## Developer experience

- [ ] quick-start commands work on clean machine
- [ ] Docker demo flow works end to end
- [ ] basic troubleshooting docs exist
- [ ] key commands are documented (`dev`, `test`, `typecheck`, migrations)

## Product clarity

- [ ] user guide explains login + first-run flow
- [ ] API surface and key pages are documented
- [ ] integration status (Paperclip optional/strict) is documented

## Release readiness

- [ ] CI passes on default branch
- [ ] known limitations are documented
- [ ] issue templates and PR template are added (optional but recommended)
