---
name: sync-marketplace-plugins
description: >-
  Sync, audit, and diff official Antigravity Marketplace plugins from the local cache
  (~/.gemini/antigravity/cache/marketplaces/antigravity-plugins-official/) against
  dicts/marketplace_plugins.json. Use this skill whenever an Antigravity version upgrade occurs,
  or when the user requests updating, auditing, or cleaning plugin marketplace translations.
---

# Antigravity 插件市场本地缓存同步与审计技能

本技能专门用于在 Antigravity 客户端发生版本更新后，或者当用户提出个性化定制插件市场区域更新需求时，自动解析本地官方插件缓存，与汉化词典进行精细化增量比对，并依据项目确立的边界标准向用户呈现比对结果。

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

**收录范围**：
1. **插件卡片基础展示简介**（`plugin.json` 中的 `description`，包含完整句及短句）。
2. **官方建议提示词**（`plugin.json` 中的 `suggestedPrompts`）。
3. **对应的斜杠技能描述**（各插件目录下的 `SKILL.md` frontmatter 完整描述及截短单句）。
4. **技能选择器安全展示绑定**：在 `localization_engine.js` 中的 `SKILL_PICKER_DISPLAY_ENTRIES` 为这 5 项技能添加行上下文绑定的显示转换规则（如 `gcalendar` -> `Google 日历`），防止污染全局代码与终端路径。

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

---

## 2. 本地缓存包路径

官方插件市场的元数据与技能包由客户端自动下载并缓存在本地：
```bash
~/.gemini/antigravity/cache/marketplaces/antigravity-plugins-official/plugins/
```
每个子目录下包含插件各版本目录（如 `0.0.5/`、`1.0.0/` 等），内部包含：
- `plugin.json`：插件基本元数据、版本、显示名称、卡片简介及 `suggestedPrompts`。
- `skills/<skill_name>/SKILL.md`：技能定义文件（Google Workspace 专区需读取其 frontmatter `description`）。

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
   - （若是 Google Workspace 插件）新增或变更的斜杠技能描述。
3. **已下架/待清理插件**：本地缓存中已不存在，但字典中可能残存的孤立词条。

### 步骤 3：向用户呈现结构化报告并征求确认
将比对得出的分析结论呈现给用户：
- 列出新上架插件及其待翻译文本；
- 列出文案变更项或下架插件；
- 询问用户：“是否确认将上述新增/变更词条按规范翻译并补充进 `dicts/marketplace_plugins.json`？”

### 步骤 4：执行增量更新与验证
在用户确认后：
1. 提取英文源文，依据行业术语规范与“零末尾句号”标点规范翻译为简体中文。
2. 写入 `dicts/marketplace_plugins.json`。
3. 若涉及 Google Workspace 插件，同步核验 `localization_engine.js` 中的 `SKILL_PICKER_DISPLAY_ENTRIES`。
4. 执行字典有效性自检与动态代码注入编译验证：
   ```bash
   node -e '
   const fs = require("fs");
   const vm = require("vm");
   const code = fs.readFileSync("localization_engine.js", "utf-8");
   const testCode = code.replace(/main\(\);?\s*$/, "const c = generateJs(); new vm.Script(c); console.log(\"[OK] 注入代码编译通过\");");
   eval(testCode);
   '
   ```
