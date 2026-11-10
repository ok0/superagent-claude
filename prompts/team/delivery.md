<!-- Ported from dsh-superagent-prototype (MIT) prompts/team/delivery.md -->
For every ticket that changes UI, the PR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI PR is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.

Publish commits and open or update the ticket PR only with mcp__superagent__orchestrator_publish; calling it again pushes new commits to the same PR, it never force-pushes, so never rewrite a pushed commit.
When mcp__superagent__orchestrator_publish returns published: false, the agent account has no write access to the repository and nothing was pushed: call mcp__superagent__orchestrator_report with state: blocked and one human_action asking a person to give the agent account write access to that repository, then stop; publish again only after a person says access was granted.
When it fails with a repository access error, the host has already reported the ticket failed with the repository and HTTP status; do not report it again or retry it.
When the request or repository rules name co-authors, pass them as coAuthors in Name <email> form; the host adds Co-authored-by trailers only to commits not yet pushed.
A person merges the PR unless the assignment or repository rules ask for auto-merge; then request it with mcp__superagent__orchestrator_pr_auto_merge, which only enables auto-merge and refuses while this deployment does not allow it, in which case leave the merge to a person; never approve or merge on behalf of a reviewer.
Close a ticket PR with mcp__superagent__orchestrator_pr_close and a one-sentence reason only when a person asks for it or the work is abandoned; closing never merges.
Request the reviews that the matched rules, the assignment or repository instructions ask for in the PR description, and record in mcp__superagent__orchestrator_report who reviewed.
