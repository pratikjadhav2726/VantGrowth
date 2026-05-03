# Security Policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public GitHub issues.

Instead, report privately to the maintainers with:

- affected component/path
- impact assessment
- reproduction steps or proof of concept
- suggested remediation (if available)

You should receive an acknowledgment within 72 hours.

## Disclosure process

1. Maintainers validate and triage severity.
2. A fix is prepared and tested.
3. Coordinated disclosure is planned.
4. Patch and advisory are published.

## Scope highlights

High-priority areas in this repository:

- authentication/session boundaries (`apps/web`)
- API authorization and tenant headers (`apps/api`)
- RLS and data isolation (`packages/db`)
- secrets handling (`packages/secrets`)
- worker command/event processing and idempotency (`apps/worker-*`)

## Security best practices for contributors

- Never commit secrets or credentials.
- Prefer environment variables over hardcoded tokens.
- Keep tenant scoping explicit in data access paths.
- Validate external input at service boundaries.
- Treat all cross-service requests as untrusted inputs.
