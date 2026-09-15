# Antigravity Chinese Localization — Project Instructions

These instructions apply to every AI agent and contributor working in this repository. The goal is to deliver natural, complete, and maintainable Simplified Chinese localization without breaking Antigravity behavior, user content, technical identifiers, or renderer performance.

## 1. Current target and sources of truth

- The current localization release is **v2.13.0**, targeting the official **Antigravity v2.13.0** client. The current version dictionary is `dicts/v2.13.0.json`; keep these values, the release date, and the support statement in `README.md` consistent.
- Treat the repository's actual files and executable behavior as authoritative. If these instructions, `README.md`, a dictionary filename, an engine comment, or the current client disagree, report the mismatch and update only what the requested task requires.
- The engine loads **every** `dicts/*.json` file. A version bump must leave exactly one active version dictionary, migrate the previous dictionary deliberately, update all current-version references, and be checked against official packaged source and metadata. If renderer source is unavailable, verify the package version and relevant packaged injection surfaces, use observed client UI as renderer evidence, and state that limitation instead of claiming a full source audit. Do not change tags or release metadata unless explicitly requested.
- Keep the user-facing installation, restoration, platform, path, dependency, and compatibility claims in `README.md` consistent with the actual engine and supported launchers.

## 2. Ownership and dictionary semantics

- `dicts/*.json` contains fixed renderer-facing text. Search existing dictionaries before editing, reuse established wording, and put each entry in the most appropriate module dictionary.
- `loadDictionary()` reads all dictionaries in lexicographic filename order, collapses whitespace, trims keys, and normalizes curly quotes. A later normalized key overrides an earlier one; the renderer also has a case-insensitive fallback. Invalid JSON is skipped by the client loader. The repository verifier is responsible for detecting these mechanical failures.
- Prefer exact entries for short labels and complete fixed sentences. Entries longer than 20 characters may also be used for substring replacement, so their source text must remain sufficiently specific. Use a fragment-only key only when the client is confirmed to render that fragment as an independent, unambiguous UI node.
- `localization_engine.js` both generates the renderer translation injection and patches packaged Electron surfaces while unpacking/repacking `app.asar`. Put fixed native menu, tray, loading, and updater text in the corresponding narrow engine injection block; use bounded engine rules for dynamic or structurally fragmented renderer text.
- Preserve `--brand-title`: English retains the official `Antigravity` brand, hidden removes its visual label, and translated permits the Chinese brand translation.
- `install.sh`, `双击安装中文汉化.command`, and `双击安装中文汉化.bat` are the supported installation entry points; `uninstall.sh`, `双击卸载还原官方英文.command`, and `双击卸载还原官方英文.bat` are the restoration entry points. `localization_engine.js` is side-effecting and is never a development test command.
- Treat shipped `.bat` files as GBK/CRLF release artifacts protected by `.gitattributes`. Change them only when explicitly requested, using `convert_to_gbk.ps1`, and verify the resulting encoding and line endings.

## 3. Translation quality and protected content

- Translate complete meaning in its real UI context rather than word by word. Keep buttons, menus, prompts, errors, and status text concise and natural, using standard Simplified Chinese punctuation.
- Use the following terminology unless context requires a documented exception:
  - `agent` → “智能体”
  - `conversation`, or a persisted chat/thread/history item → “会话”
  - `chat` used as a visible action, capability, or button → “聊天”
  - a conversational exchange or agent dialogue → “对话” when natural in context
  - `project` → “项目”; `workspace` → “工作区”; `worktree` → “工作树”
  - `goal` → “目标”; `task` → “任务”
  - `file` → “文件”; `folder` → “文件夹”
  - `page` → “页面” or counted “个页面”; `search` → “搜索” or counted “次搜索”
  - `tool` → “工具”
  - UI `artifact` or a generated deliverable → “交付件”; a technical artifact may be “构件”
- Keep project and workspace distinct even when the UI visually groups them.
- Translate only confirmed product-owned wrapper text such as dialog or toast titles, buttons, labels, and fixed explanatory copy. Never translate user prompts or chat bodies, third-party web content, generated model responses, editor or file content, terminal or subprocess output, CLI/Git diagnostics, stack traces, URLs, paths, commands, code, shortcuts, secrets, credentials, model or product names, MCP/API/configuration identifiers, environment variables, version numbers, Git refs or hashes, exit codes, or error IDs.
- Preserve placeholders and runtime values exactly. Do not drop, ambiguously reorder, or hard-code project, workspace, file, model, branch, email, date, count, shortcut, or status values.

## 4. Dynamic renderer and DOM safety

- For every screenshot report, identify the original English source, UI location, expected Chinese output, and whether the source is fixed, variable, or split across DOM nodes. Do not infer a key solely from the final mixed-language rendering.
- Use anchored, context-specific capture groups for dynamic counts, durations, dates, names, refs, and paths. Count rules must cover singular and plural forms and use the correct Chinese classifier; never add screenshot-specific numeric variants.
- React may split a sentence or briefly render an incomplete state. Combine only the smallest relevant container, wait for a semantically complete source, and update only the necessary text nodes. Preserve icons, links, emphasis, shortcuts, buttons, event handlers, selection, accessibility attributes, and React-owned structure.
- Respect `data-testid="user-input-step"`, `data-ag-localization-skip`, editor and terminal guards, blocked tags, content-editable regions, protected descendants, and Shadow DOM ancestor traversal. Never concatenate text across a protected boundary or use broad `innerHTML`/`textContent` replacement on interactive containers.
- Keep translation idempotent and observer work incremental: compare before every observed write, keep `startEngine()` single-start, use cheap text/length prefilters before ancestor or container scans, and do not add recurring full-document scans or delayed rescans to hide a missing rule.
- Do not write translation markers or observed attributes to SVG/path/icon nodes. A structural rule must not create observer loops, cross-item translation, lost click behavior, or material panel slowdown.

## 5. Implementation workflow

1. Inspect `git status --short --untracked-files=all` before editing and preserve every unrelated user change. Do not stage or include it implicitly.
2. Inspect the relevant dictionaries, engine functions, screenshots, current-version dictionary, callers, and available official client source. Confirm source text and DOM composition before choosing an implementation.
3. Apply the ownership, matching, translation, and DOM rules above using the smallest safe change. Do not reorder large dictionaries, reformat unrelated files, add speculative variants or dependencies, or expand release scope without authorization.
4. Document only non-obvious dynamic or structural invariants next to the rule. For performance-sensitive changes, compare observer activity and DOM writes on representative containers.

## 6. Verification and handoff

- For dictionary-only changes to fixed renderer text, do not add renderer regression cases. The dictionary audit covers every entry; run the repository-owned non-installing verifier `node scripts/verify.js`, inspect each reported failure or skip, and review the intended dictionary diff.
- Add or update the smallest focused case in `tests/renderer-regression.js` only when changing dynamic matching, structural or fragmented DOM handling, protected boundaries, attribute translation, observer behavior, or when fixing a confirmed renderer regression. Cover only the applicable mechanism-level equivalence classes, such as a representative positive case, negative case, dynamic update, repeat processing, sibling isolation, or preserved interactive node. Do not duplicate ordinary fixed dictionary entries or screenshot-specific values merely to increase the assertion count.
- The lightweight DOM contract suite prevents known engine regressions but does not prove compatibility with an official renderer. Confirm source text, DOM composition, interactions, and representative performance in the target client for release-sensitive engine changes, and state when that validation is unavailable.
- When a confirmed official `preload.js` is available, additionally run `node scripts/verify.js --preload "/absolute/path/to/preload.js"`. The verifier accepts an explicit file path and does not discover or prove the provenance of that file; without the option, preload compatibility is skipped rather than passed.
- For a version-dictionary migration, review the verifier's old/new entry totals and every reported missing or changed existing entry. Use `--acknowledge-version-entry-changes` only after confirming each such change is intentional.
- Review the final diff and every untracked path reported by the verifier. Its format, compilation, regression, and status checks do not determine whether a file or semantic change was intended. If the verification infrastructure itself changes, review it directly before relying on its result.
- For documentation- or rule-only changes, runtime DOM validation is unnecessary. Perform a coherence and repository-reference review plus `git diff --check`; also run `node scripts/verify.js` when changing version references or claims about executable behavior.
- Report the files changed, verification actually run or skipped, and any material remaining limitation or risk.

## 7. Installation, destructive actions, and Git

- Never run `node localization_engine.js`, `install.sh`, `uninstall.sh`, either Windows batch launcher, either macOS command launcher, or any equivalent command that installs, injects, restores, repacks, or otherwise modifies the user's Antigravity client during development. Read-only extraction of a confirmed official package into a separate temporary directory is allowed for verification; never write the result into the application directory.
- Do not delete `_temp_asar`, backups, application files, or user data unless the user explicitly requests the exact destructive action and the target has been verified.
- After source changes, instruct the user to run the supported installer manually: Linux starts with `./install.sh` and adds `sudo` only when write permissions require it; macOS starts by double-clicking `双击安装中文汉化.command` or running `./install.sh` (adding `sudo` only on permission failure); Windows starts by double-clicking `双击安装中文汉化.bat` and uses “Run as administrator” only after a permission failure. Restoration follows the same escalation rule with the corresponding uninstall entry point.
- Update versions, tags, releases, Git staging, commits, pushes, rebases, or history only when explicitly requested. Before staging, verify the exact file list and exclude unrelated user changes.
