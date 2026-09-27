---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

The project boundary now holds for shell commands as well as the file tools. A line that changes something is ruled as a write to every place it reaches: where it `cd`s or `pushd`es, the directory a `git -C` names, and, when it runs code Memnox cannot read, such as `python3 - <<EOF` or `node -e`, every absolute path written in it. Editing another repository by `cd`ing there first or through an interpreter used to go through without anybody being asked; now it asks as a write there would. Working inside the project and reading anywhere stay unasked.
