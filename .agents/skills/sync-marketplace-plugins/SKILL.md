---
name: sync-marketplace-plugins
description: >-
  同步、审计并比对官方 Antigravity 插件市场插件与插件市场专用词典。在 Antigravity 版本升级或需要更新、审计及清理插件市场汉化文案时使用此技能。
---

# Antigravity 插件市场本地同步与审计技能

本技能采用渐进式披露规范，专门用于在 Antigravity 客户端发生版本更新后当用户提出个性化定制插件市场区域更新需求时，自动解析本地官方插件缓存，与汉化词典进行精细化增量比对，并依据项目确立的边界标准向用户呈现比对结果。

---

## 1. 核心翻译标准与关注点边界

在处理插件市场相关文案时，**严格按以下标准分类处理**，严禁过度翻译：

### 🟢 Google Workspace 官方专区（完全汉化）
包含以下 5 个官方核心插件：
- **Google Calendar** (`gcalendar`)
- **Google Docs** (`gdocs`)
- **Google Drive** (`gdrive`)
- **Google Sheets** (`gsheets`)
- **Google Slides** (`gslides`)

**收录范围与文案分类说明**：
1. **插件描述**（来自 `plugin.json` 中的 `description`，如 `Read, draft, and edit docs.`。插件市场卡片与技能栏/斜杠命令展示的均是这套统一描述）。
2. **官方建议提示词**（来自 `plugin.json` 中的 `suggestedPrompts`）。
3. **技能详情完整说明**（来自各插件目录下的 `SKILL.md` frontmatter `description` 完整段落，负责插件技能详情页及路由规则展示）。
4. **技能选择器安全展示绑定**：在 `localization_engine.js` 中的 `SKILL_PICKER_DISPLAY_ENTRIES` 为技能添加行上下文绑定的显示转换规则（如 `gcalendar` -> `Google 日历`，`gdocs` -> `Google 文档`，需兼容不同版本缓存客户端中的统一描述），防止污染全局代码与终端路径。

---

### 🟡 其余官方插件专区（精准轻量汉化）
包含 Flutter、Firebase、Data Agent Kit、Modern Web Guidance、Science、Chrome DevTools、Android CLI、Gemini API、Google Maps Platform 等其余所有官方插件。

**严格限定仅收录以下三项**：
1. **市场通用界面与交互控制**（导航、分类筛选、安装/启用/禁用状态标签、配置/认证弹窗、错误提示等通用 DOM 控件文案）。
2. **插件卡片基础展示简介**（各插件在市场卡片列表展示的一句话简介与概述描述）。
3. **官方建议提示词列表**（各插件配套的 `suggestedPrompts` 快速操作提示词）。

**严格禁止收录以下内容（绝不汉化）**：
- ❌ **严禁收录各插件抽屉详情的 README/文档长篇 Markdown**（如功能详情长段、前置依赖配置、自动化评测用例、开源协议免责声明等）。
- ❌ **严禁收录各插件内部单个技能函数的功能说明**（如内部小技能描述），避免产生大量污染并增加字典维护负担。

### 🔴 版本升级替换与废弃清理准则（严禁保留旧版冗余词条）

- **1:1 原文对应，及时替换更新**：当官方插件版本升级或文案发生调整时（例如 `gdocs` 从 v0.0.5 升级到 v0.0.6 时官方描述发生变更），**必须将旧词条直接更新替换为最新词条，并彻底删除已废弃的旧英文及其旧译文**。
- **严禁保留冗余历史变体**：字典全局保持 1:1 官方最新源文映射，严禁在 `dicts/marketplace_plugins.json` 中保留两个版本的变体或已废弃的历史孤立词条。
- **引擎绑定同步替换**：对于 Google Workspace 核心插件的斜杠技能，若描述发生变更，必须同步在 `localization_engine.js` 的 `SKILL_PICKER_DISPLAY_ENTRIES` 中把旧的 description 描述更新为官方最新描述，彻底清除旧文案。

---

## 2. 本地缓存包路径与多版本解析规则

官方插件市场的元数据与技能包由客户端自动下载并缓存在当前用户主目录下的 `.gemini/` 目录中。

### 跨平台默认缓存路径

各操作系统上的标准路径如下（Node.js 比对工具通过 `os.homedir()` 自动跨平台解析）：

| 操作系统 | 默认缓存路径 |
| :--- | :--- |
| **Linux / macOS** | `~/.gemini/antigravity/cache/marketplaces/antigravity-plugins-official/plugins/`<br>（或 `$HOME/.gemini/antigravity/...`） |
| **Windows** | `%USERPROFILE%\.gemini\antigravity\cache\marketplaces\antigravity-plugins-official\plugins\` |

> [!NOTE]
> - **通用表示法**：在文档与跨平台说明中，通常使用标准波浪号 `~/.gemini/...` 或 `<user_home>/.gemini/...` 作为通用缩写。
> - **自定义路径支持**：若在特殊环境或沙箱中修改了缓存位置，比对脚本支持通过 `--cache-dir <path>` 显式指定目录。

每个插件子目录下包含各版本目录（如 `0.0.5/`、`0.0.6/`、`1.0.0/` 等），内部包含：
- `plugin.json`：插件基本元数据、版本、显示名称、卡片简介及 `suggestedPrompts`。
- `skills/<skill_name>/SKILL.md`：技能定义文件（Google Workspace 专区需读取其 frontmatter `description`）。

> [!IMPORTANT]
> **多版本缓存扫描准则（严禁递归历史目录）**：
> 本地缓存目录中可能并存多个历史版本。比对脚本与人工审计**必须仅锁定并解析最高版本（最新版）目录**（依据 semver 语义化版本排序取最大值），严禁递归全量扫描历史旧版本目录。否则会将已废弃的历史旧文案误识别为“未汉化增量”，进而错误引入废弃冗余词条。

---

## 3. 标准操作工作流

当用户要求更新插件市场、或者在版本升级审计过程中需要检查插件时，请执行以下流程：

### 步骤 1：运行自动化比对脚本
在项目根目录下执行自带的对比工具：
```bash
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js
```
若需要程序化结构体，可添加 `--json` 参数：
```bash
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js --json
```

### 步骤 2：分析比对结果
脚本将自动输出三类结果：
1. **新上架插件**：本地缓存中出现，但 `dicts/marketplace_plugins.json` 尚未收录的全新插件。
2. **待翻译/变更文案**：
   - 基础卡片简介变动或新增；
   - 新增的 `suggestedPrompts` 建议提示词；
   - （若是 Google Workspace 插件）最新版本中新增或变更的斜杠技能描述。
3. **已下架/待清理插件**：本地缓存中已不存在，但字典中可能残存的孤立词条。

### 步骤 3：向用户呈现结构化报告并征求确认
将比对得出的分析结论呈现给用户：
- 列出新上架插件及其待翻译文本；
- 列出文案变更项（注明需**更新替换**并**清理废弃旧词条**）或下架插件；
- 询问用户：“是否确认将上述新增词条按规范翻译补充，并将变更词条更新替换进 `dicts/marketplace_plugins.json` 及引擎，清理废弃冗余条目？”

### 步骤 4：执行替换更新、废弃清理与验证
在用户确认后：
1. 提取英文源文，依据行业术语规范与官方原文 1:1 格式及标点对齐规范翻译为简体中文（英文带 `.` 译文必须带 `.`，断句用 `. `，冒号 `:`、感叹号 `!`、问号 `?` 严格对应半角英文标点，严禁强加中文全角语法标点）。
2. 写入 `dicts/marketplace_plugins.json`：
   - 新词条直接增量补充；
   - **对于版本升级带来的文案变动，必须执行原位替换更新，彻底删除废弃的旧版本词条**
3. 若涉及 Google Workspace 插件技能描述变更，同步更新 `localization_engine.js` 中的 `SKILL_PICKER_DISPLAY_ENTRIES`，将旧的 description 替换为官方最新文案。
4. 全局检索确认旧词条已无残留：
   ```bash
   grep -rn "<已废弃的旧英文关键词片段>" dicts/ localization_engine.js
   ```
5. 执行字典有效性自检与动态代码注入编译验证：
   ```bash
   node -e '
   const fs = require("fs");
   const vm = require("vm");
   const code = fs.readFileSync("localization_engine.js", "utf-8");
   const testCode = code.replace(/main\(\);?\s*$/, "const c = generateJs(); new vm.Script(c); console.log(\"[OK] 注入代码编译通过\");");
   eval(testCode);
   '
   ```
