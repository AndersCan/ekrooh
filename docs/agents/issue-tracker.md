# Issue tracker: GitHub

Issues and specs live as GitHub issues on `AndersCan/ekrooh`. Use the `gh` CLI
(repo is inferred from `git remote -v`). Use a heredoc for multi-line bodies.

## Operations

- Create: `gh issue create --title "..." --body "..."`
- Read with comments: `gh issue view <n> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` (add `--label`/`--state` as needed)
- Comment: `gh issue comment <n> --body "..."`
- Labels: `gh issue edit <n> --add-label "..."` / `--remove-label "..."`
- Close: `gh issue close <n> --comment "..."`

Skill mapping: "publish to the issue tracker" means create an issue; "fetch the
relevant ticket" means `gh issue view <n> --comments`.

## PRs as a triage surface

Setting: **no** (`/triage` reads this flag; set to `yes` to treat external PRs as
requests).

When `yes`, PRs use the same labels and states via `gh pr`:

- Read: `gh pr view <n> --comments`; diff: `gh pr diff <n>`
- External PRs: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`,
  keeping `authorAssociation` in `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`.
- Comment, label, close: `gh pr comment`, `gh pr edit`, `gh pr close`.

Issues and PRs share one number space. For a bare `#42`, try `gh pr view 42`, then
fall back to `gh issue view 42`.

## Wayfinding (`/wayfinder`)

- Map: one issue labelled `wayfinder:map` with Notes, Decisions-so-far and Fog
  sections. `gh issue create --label wayfinder:map`.
- Child ticket: a GitHub sub-issue of the map (sub-issues endpoint via `gh api`). If
  sub-issues are unavailable, list it in the map's task list and put `Part of #<map>`
  at the top of the child. Labels: `wayfinder:<type>` where type is `research`,
  `prototype`, `grilling` or `task`. Assign the driving dev once claimed.
- Blocking: native issue dependencies. Add an edge with
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  The blocker id is the numeric database id (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`),
  not `#number` or `node_id`. Fallback: a `Blocked by: #<n>, #<n>` line at the top
  of the child. A ticket is unblocked when every blocker is closed.
- Frontier: open children with no open blocker (`issue_dependencies_summary.blocked_by > 0`
  or open `Blocked by` entries) and no assignee. First in map order wins.
- Claim: `gh issue edit <n> --add-assignee @me`.
- Resolve: `gh issue comment <n> --body "<answer>"`, `gh issue close <n>`, then append
  a gist and link to the map's Decisions-so-far.
