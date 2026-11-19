# github-core-clone — v4

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Plowester1/github-core-clone-01-v4/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Plowester1/github-core-clone-01-v4/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A from-scratch GitHub-compatible git forge for the [make.fun](https://make.fun/bounty/github-core-clone-01) github-core-clone-01 bounty — built entirely on the Node.js standard library with zero runtime dependencies. Fourth variant (daggerdash account); v3 scored 996/990 locally but was rejected on its run record (missing system prompt), and its main.ts never registered with the trial env, so v3 would have scored 0 under the official grader. v4 fixes both: a complete run record with the system prompt uploaded, and a main.ts that self-registers with the env and polls /done, exactly as the server runs it.

It speaks the four protocols a GitHub-style server needs: smart-HTTP Git (protocol v0 and v2), the GitHub REST API v3, GraphQL, and the Model Context Protocol (MCP) over Streamable HTTP.

## Local trial scores (official `grade-local --driver process`, all 3 practice trials)

| trial | checks | score | perf pts | p50 |
|---|---|---|---|---|
| trial-1 | 120/120 | 979 | 179 | 271 ms |
| trial-2 | 120/120 | 968 | 168 | 310 ms |
| trial-3 | 120/120 | 976 | 176 | 283 ms |

Mean 974.3 (90% interval 965–984). Smoke test 18/18. See `STATE.md` for the full build history and `trial-*.json` for the raw results.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<redacted>
```

The server speaks Git smart HTTP at `/<owner>/<repo>.git`, REST at `/api/v3`, GraphQL at `/api/graphql`, and MCP at `/api/mcp`. Any bearer <redacted> value works as long as server and client agree (`MAKEFUN_SHOP_TOKEN`). With `MAKEFUN_ENV_URL` set it registers with the trial env and exits when the env says done; without it, it prints `PORT=<n>` and keeps running.

## Layout

- `store.ts` — in-memory object store (blobs, trees, commits, tags), refs, repos, issues, pulls
- `git.ts` — pack codec (read/write), upload-pack (fetch, shallow/deepen), receive-pack (push, fast-forward validation), ref advertisement, sideband framing
- `rest.ts` — REST API v3 (repos, contents, commits, issues, labels, pulls, merges)
- `graphql.ts` — hand-written GraphQL lexer/parser, projection, connections, introspection, mutations
- `mcp.ts` — MCP tools over Streamable HTTP (repo/issue/PR tools)
- `main.ts` — HTTP server, routing, auth, trial-env lifecycle (register + poll /done)
