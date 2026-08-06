# Open Source Readiness Checklist

Use this checklist before announcing or sharing the repository.

## Project metadata

- [x] `README.md` clearly explains purpose and setup
- [x] `LICENSE` exists and is accurate
- [x] `CONTRIBUTING.md` exists
- [x] `CODE_OF_CONDUCT.md` exists
- [x] `SECURITY.md` exists

## Repository hygiene

- [x] `.gitignore` excludes local and generated artifacts
- [x] no secrets or tokens in tracked files
- [x] sample env config is in `.env.example`
- [x] generated build folders are not committed

## Developer experience

- [ ] quick-start commands work on clean machine
- [ ] Docker demo flow works end to end
- [x] basic troubleshooting docs exist
- [x] key commands are documented (`dev`, `test`, `typecheck`, migrations)

## Product clarity

- [x] user guide explains login + first-run flow
- [x] API surface and key pages are documented
- [x] integration status (Paperclip optional/strict) is documented

## Release readiness

- [ ] CI passes on default branch
- [x] known limitations are documented
- [x] issue templates and PR template are added
