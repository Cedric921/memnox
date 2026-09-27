---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

"Allow once" now lets the call through. A write outside the project is ruled on twice, by the rules and by the project boundary, and the first took the answer off the question, so the boundary found nothing and refused the retry, telling the agent a yes in the conversation could not allow it. A once answer now leaves a single use the boundary spends on that retry, good until the question would have expired, and the next write asks again.
