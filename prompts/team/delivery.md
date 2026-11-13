<!-- Ported from dsh-superagent-prototype (MIT) prompts/team/delivery.md -->
For a ticket that changes UI, attach visual evidence when a real capture can be made in this environment: clearly labelled Before and After captures of the same scenario, viewport, theme and UI state, with the baseline and changed revision identified; screenshots or demonstrations are acceptable.
Refresh the comparison when later UI changes make it stale.
When a capture cannot be made, add one line to the PR description saying there is no visual evidence and what a person should check visually; that alone does not make the PR blocked or draft.
Never fabricate captures, never present a mockup as the previous implementation, never refer to a capture that does not exist, and do not expose credentials.

Publish commits and open or update the ticket PR only with mcp__superagent__orchestrator_publish; calling it again pushes new commits to the same PR, it never force-pushes, so never rewrite a pushed commit.
When mcp__superagent__orchestrator_publish returns published: false, the agent account has no write access to the repository and nothing was pushed: call mcp__superagent__orchestrator_report with state: blocked and one human_action asking a person to give the agent account write access to that repository, then stop; publish again only after a person says access was granted.
When it fails with a repository access error, the host has already reported the ticket failed with the repository and HTTP status; do not report it again or retry it.
When the request or repository rules name co-authors, pass them as coAuthors in Name <email> form; the host adds Co-authored-by trailers only to commits not yet pushed.
A person merges the PR unless the assignment or repository rules ask for auto-merge; then request it with mcp__superagent__orchestrator_pr_auto_merge, which only enables auto-merge and refuses while this deployment does not allow it, in which case leave the merge to a person; never approve or merge on behalf of a reviewer.
Close a ticket PR with mcp__superagent__orchestrator_pr_close and a one-sentence reason only when a person asks for it or the work is abandoned; closing never merges.
Request the reviews that the matched rules, the assignment or repository instructions ask for in the PR description, and record in mcp__superagent__orchestrator_report who reviewed.
