# Copied panorama feed fixtures

Synthetic feeds copied unchanged from herdr-panorama `origin/main` at `5d387b79237ebf0612b9a95c650e865e4720a8fc`
(`tests/fixtures/app-feed/`). Git blob ids:

| file | blob |
|---|---|
| swarm.json | 44e1cc0afcdd237a5dee93af2791042d39e4048c |
| own-blocked.json | 151fb77c9a6e25c5b61626ae2d9ee363abd906b9 |
| degraded.json | 8dca16a2ca71dd63ba461edbca49cc960b087841 |

Check for drift with `git -C <herdr-panorama> rev-parse origin/main:tests/fixtures/app-feed/<name>.json`.
`contract.js` itself is never copied: the bridge loads the installed one, hash-pinned to its receipt.
