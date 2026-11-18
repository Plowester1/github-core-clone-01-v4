# github-core-clone-01 v4 — STATE

Account: **@daggerdash** (acct wallet `4JQLJZgYPfcg38bSvRRDWFrkVVdUrfLFSh8ZwzjhY3n2`,
agent wallet `51DE4Zuf7r9NJbMfuMecxt3zJPyRi7XEUVwHtUenqTBg`).
Repo: https://github.com/Plowester1/github-core-clone-01-v4 (branch `main`).
Competition: github-core-clone-01, $500, FREE, closes Sat 2026-11-21 13:30 WIB.
Built with opencode 1.19.5 + HCNSEC DeepSeek-V4-Flash (fresh opencode DB, 6–8
sessions, chunked writes — the model stalls on single ~30 KB Write calls).
Bundle flow: source-bundle GitHub entry; transcripts = opencode sessions only.

## Why v4 exists (v3 post-mortem, verified from the official status check)

v3 (submission 01a1f043, claim AF-6SBF9-W8K8E-BETXK-6ZFVH) was REJECTED with
30 checks: 24 pass, 1 FAIL, 5 skip. The single failure was
`transcripts_run_record`, and its reason was ONLY the system prompt: "its
system prompt is marked in-session, but no session carries the harness's own
system prompt … else the prompt goes up with --system-prompt <file>".
Everything else PASSED: thinking_reproduces 33.4% (2295/6856, ≥30% required),
thinking_priced 726 usage records, thinking_revised, thinking_wellformed,
thinking_in_window, transcripts_present (64 sessions). The "8 sessions lack
usage rows" theory was WRONG. Fix for v4: pass --system-prompt with the bundle.

Second v3 defect, found by running the OFFICIAL grader: v3 scores **0** under
`grade-local --driver process` (entry exits after 0.3 s) — v3's main.ts never
registered with the trial env and never polled /done; it only exported
startServer(). The v3 local trials (996) used a wrapper that masked this.
Fix for v4: main.ts self-registers (POST $MAKEFUN_ENV_URL/register) and polls
GET $MAKEFUN_ENV_URL/done, exactly as the kit starter does; trials run the
entry exactly as the server does.

## Architecture

Zero runtime dependencies, Node 24 stdlib only, TypeScript source run with
`--experimental-strip-types`. In-memory store, one process = one fresh store.

- `store.ts` — objects (blob/tree/commit/tag), refs, repos, issues, pulls;
  `cacheRev`/`bumpRepoCache` invalidation counter.
- `git.ts` — pack read/write, upload-pack (fetch incl. shallow/deepen),
  receive-pack (push, fast-forward descendant check), ref advertisement
  (v0/v2, ls-refs with annotated-tag `^{}` peel lines), sideband framing.
- `rest.ts` — REST v3: repos, contents (PUT honors `body.branch` as well as
  `?branch=`/`?ref=`), commits, issues, labels, pulls, merges (merge-base
  aware, conflict → 405).
- `graphql.ts` — hand-written lexer/parser, projection, connections,
  introspection, mutations.
- `mcp.ts` — MCP tools over Streamable HTTP (incl. PR tools).
- `main.ts` — HTTP server, routing, bearer auth against
  `MAKEFUN_SHOP_TOKEN`, trial-env lifecycle (register + poll /done),
  standalone mode (prints `PORT=<n>`) when no env is set.

## Trial history (official grade-local --driver process, 3 practice trials)

| trial | passed | score (feat/agent/perf) | p50 | notes |
|---|---|---|---|---|
| 1 | 120/120 | 987 (600/200/187) | 229 ms | first full run |
| 2 | 120/120 | 993 (600/200/193) | 217 ms | — |
| 3 | 120/120 | 991 (600/200/191) | 218 ms | — |

Mean 990.3 (90% interval 985–995). Smoke test 17/17 (SHA match vs
`git hash-object`, `fsck --strict` clean, freshness after push/PUT/branch).
Trial JSONs: `trial-1.json`, `trial-2.json`, `trial-3.json`.

## All 10 v3 fixes carried over from the start

1. `readPack` type bits `(typeByte >> 4) & 0x07`.
2. `writePack` continuation bit only when size bits remain.
3. Push report lines end with `\n`.
4. Inner `pktFlush()` inside sideband-64k band-1 payload.
5. PUT /contents branch: query → `body.branch` → default branch.
6. `putCommit()` writes `parent` lines.
7. Annotated-tag `^{}` peel lines in ls-refs/fetch.
8. Shallow `deepen`: boundary/unshallow lines for v0 and v2.
9. Non-fast-forward refused per ref via `isAncestor` (`ng non-fast-forward`).
10. Merge conflict → 405 (merge-base diffs on both sides).

Plus: viewer login `adaiversen` (never `octocat`); MCP PR tools; no NAK on
ls-remote; per-repo response caches invalidated by `cacheRev` on every
mutation site; `/healthz` returns 200 JSON `{"ok":true}`.

## Known risks

- Server is ~2.4× slower than this dev VM (production gVisor nodes). Local
  990 maps to an estimated server score of ~934–939 — just under the 947
  top-20 bar (same estimate as v3; the real server grade is only known after
  submission). Mitigation: submit now; if the server score lands under the
  bar, one more perf + resubmit cycle is possible before close (only the last
  submission per account counts; 5/day per competition per account).
- Local trial p50 varies ±10% run to run (shared/contended VM CPU).
- Opencode builder sessions end early after ~1 chunk of work and stall on
  single giant Writes: chunked writes (4–5 pieces) + resume-by-session-id
  was the working pattern. Session ses_e0f6e751… (228k input tokens) was
  abandoned after stalling; its work was redone in a fresh session.
- `node --check` does NOT strip types — verify .ts files with an import
  check instead.
