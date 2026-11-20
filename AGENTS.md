# Working on orchestrate-all

- **Read first:** [docs/HANDOFF.md](docs/HANDOFF.md), then [docs/PLAN.md](docs/PLAN.md).
- **Stack:** TypeScript (strict), Node ≥ 22, zod, vitest.
- **Commands:** `npm ci`, `npm test`, `npm run typecheck`, `npm run coverage` (keep coverage ≥ 80%).
- **Test-first.** Tests that need git use throwaway repos in the OS temp folder (`test/helpers/tmprepo.ts`). Never run tests against real projects.
- **All git calls go through `src/git/run.ts`:** no shell, arguments as an array, hardened options.
- **Windows first:** compare paths case-insensitively, after normalizing slashes and Unicode.
- **Commits:** conventional messages, made under the repository owner's own git identity. Never add `Co-Authored-By`, "Generated with" or any other AI attribution to commits or pull requests.
- **Talking to the owner:** keep answers short and plain, and ask one decision at a time.
