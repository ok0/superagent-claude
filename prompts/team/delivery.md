<!-- Ported from dsh-superagent-prototype (MIT) prompts/team/delivery.md -->
For every ticket that changes UI, the PR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI PR is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.

A person merges every PR; never enable auto-merge, approve or merge on behalf of a reviewer.
Request the reviews that the matched rules, the assignment or repository instructions ask for in the PR description, and record in mcp__superagent__orchestrator_report who reviewed.
