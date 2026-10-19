# Security

Please keep credentials, raw session content, personal installation packages, and exploit details out of public issues.

For a sensitive vulnerability, use the repository's [private security advisory form](https://github.com/AndersJet/ai-dev-insight/security/advisories/new) when available. If private reporting is not enabled, open an issue that only requests a private contact channel; wait for the maintainer's response before sharing sensitive details. This document does not claim that a particular private-reporting feature is currently enabled.

Include affected versions, deployment conditions, a minimal synthetic reproduction, and the expected security boundary. Do not include other people's data.

## Deployment boundaries

- Account roles and authenticated identity are checked by the server. Statistics access does not grant access to another member's session body.
- A domain allowlist restricts account admission; it does not prove mailbox ownership.
- Treat prompts, responses, tool results, installation credentials, and backups as sensitive. Limit deployment access and protect transport and persistent storage.
- Collection, login, plugin API tokens, and short-lived download grants serve different purposes. Do not substitute one credential for another.
- Backups, credential keys, and cleanup/recovery journals have different ownership and retention requirements; follow the supplied deployment procedures.

The project does not promise a response-time SLA or claim a full penetration test. Native IDE/device support must be verified for the exact artifact and environment.

## Synthetic test materials

`trae-plugin/test/fixtures/synthetic-tls.json` intentionally contains a public localhost test certificate/key used to verify rejection of untrusted TLS. It is a test fixture and must not be used for a deployment.
