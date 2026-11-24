---
paths:
  - "*, **"
---

# Branch Naming

Format: `<type>/[<work-item>-]<description>`; leave out the work item when there is none.

Types: `feat`, `fix`, `bugfix`, `hotfix`, `release`, `chore`, `ai`, `copilot`, `cursor`, `claude`, `codex`

Examples:
- `feat/1234-add-calendar`
- `bugfix/8274-random-mongo-crashes`
- `chore/11825-update-package-versions`

# Commit Messages

Format: `[#<workitem> ]<type>[(<scope>)]: <description>`; leave out the work item when there is none.

Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`

Examples:
- `#1234 feat(calendar): add recurring events`
- `#8274 fix: prevent random Mongo crashes`
- `#11825 chore(deps): update package versions`

Optional multi-line body after a blank line.

Commits meant for the upstream repo (superGeometry/supergeometry.app) follow its own style instead: a plain-words subject with the request quoted.