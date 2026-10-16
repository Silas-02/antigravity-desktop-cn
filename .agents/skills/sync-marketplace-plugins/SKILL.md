---
name: sync-marketplace-plugins
description: >-
  同步、审计并比对官方 Antigravity 插件市场插件与插件市场专用词典。在 Antigravity 版本升级或需要更新、审计及清理插件市场汉化文案时使用此技能。
---

# Antigravity 插件市场官方同步与审计技能

本技能采用渐进式披露规范，专门用于在 Antigravity 客户端发生版本更新或需要维护插件市场区域时，以官方权威元数据（`marketplace.json`）为唯一基准，采用流式内存零落盘技术精准提取核心技能详情，与汉化词典进行精细化增量比对，并依据项目确立的边界标准向用户呈现比对结果。

---

## 1. 核心翻译标准与关注点边界

在处理插件市场相关文案时，**严格按以下标准分类处理**，严禁过度翻译：

### 🟢 Google Workspace 官方协同办公专区（完全汉化）
指 Google 官方第一方 Workspace 协同办公生态系列插件。当前已上架的核心插件包括（**此清单为开放集合，非封闭闭集；后续若官方增补如 `gmail`、`gtasks`、`gmeet` 等同族套件，同理归入本专区**）：
- **Google Calendar** (`gcalendar`)
- **Google Docs** (`gdocs`)
- **Google Drive** (`gdrive`)
- **Google Sheets** (`gsheets`)
- **Google Slides** (`gslides`)

**收录范围与文案分类说明**：
1. **插件基础描述**（来自 `description`，如 `Read, draft, and edit docs.`。市场卡片与技能栏展示的统一描述）。
2. **官方建议提示词**（来自 `suggestedPrompts` 快速操作提示词列表）。
3. **技能详情完整说明**（来自各插件归档内部 `SKILL.md` frontmatter `description` 完整段落，负责插件技能详情页及路由规则展示）。
4. **技能选择器安全展示绑定**：在 `localization_engine.js` 中的 `SKILL_PICKER_DISPLAY_ENTRIES` 为技能添加行上下文绑定的显示转换规则（如 `gcalendar` -> `Google 日历`，`gdocs` -> `Google 文档`），防止污染全局代码与终端路径。

---

### 🟡 其余官方插件专区（精准轻量汉化）
包含 Flutter、Firebase、Data Agent Kit、Modern Web Guidance、Science、Chrome DevTools、Android CLI、Gemini API、Google Maps Platform 等其余所有官方插件。

**严格限定仅收录以下三项**：
1. **市场通用界面与交互控制**（导航、分类筛选、安装/启用/禁用状态标签、配置/认证弹窗、错误提示等通用 DOM 控件文案）。
2. **插件卡片基础展示简介**（各插件在市场卡片列表展示的一句话简介与概述描述）。
3. **官方建议提示词列表**（各插件配套的 `suggestedPrompts` 快速操作提示词）。

**严格禁止收录以下内容**：
- ❌ **严禁收录各插件抽屉详情的 README/文档长篇 Markdown**（如功能详情长段、前置依赖配置、自动化评测用例、开源协议免责声明等）。
- ❌ **严禁收录各插件内部单个技能函数的功能说明**（如内部小技能描述），避免产生大量污染并增加字典维护负担。

### 🔴 版本升级替换与废弃清理准则（严禁保留旧版冗余词条）

- **1:1 原文对应，及时替换更新**：当官方插件版本升级或文案发生调整时（例如 `gdocs` 从 v0.0.5 升级到 v0.0.6 时官方描述发生变更），**必须将旧词条直接更新替换为最新词条，并彻底删除已废弃的旧英文及其旧译文**。
- **严禁保留冗余历史变体**：字典全局保持 1:1 官方最新源文映射，严禁在 `dicts/marketplace_plugins.json` 中保留两个版本的变体或已废弃的历史孤立词条。
- **引擎绑定同步替换**：对于 Google Workspace 核心插件的斜杠技能，若描述发生变更，必须同步在 `localization_engine.js` 的 `SKILL_PICKER_DISPLAY_ENTRIES` 中把旧的 description 描述更新为官方最新描述，彻底清除旧文案。

---

## 2. 官方权威元数据与内存零落盘解析体系

### 唯一权威来源：官方 `marketplace.json`

比对工具统一以官方发布的 `marketplace.json` 清单为唯一数据源：
- **默认优先**：自动定位读取本地客户端缓存的官方市场元数据：
  - Windows: `%USERPROFILE%\.gemini\antigravity\cache\marketplaces\antigravity-plugins-official\marketplace.json`
  - Linux / macOS: `~/.gemini/antigravity/cache/marketplaces/antigravity-plugins-official/marketplace.json`
- **云端回退 / 独立运行**：若本地客户端尚未生成缓存（如纯净环境或 CI 构建），或附加 `--remote` 参数时，直接从 Google 官方权威源拉取：
  - URL: `https://www.gstatic.com/antigravity/plugins/marketplace.json`

### Google Workspace 技能详情：流式内存零落盘提取

针对 Google Workspace 专区插件深层 `SKILL.md` 描述的提取：
1. **纯内存流拉取**：从 `marketplace.json` 中记载的官方 `source.url` 归档地址直接将约 40KB 的 zip 数据拉入内存 `Buffer`；
2. **纯原生解压提取**：使用 Node.js 内置 `zlib` 在内存中解压提取 `skills/*/SKILL.md` 的 frontmatter `description`；
3. **零落盘立即回收**：提取完毕后内存缓冲区立即由垃圾回收器（GC）释放。

---

## 3. 标准操作工作流

当用户要求更新插件市场、或者在版本升级审计过程中需要检查插件时，请执行以下流程：

### 步骤 1：运行自动化比对脚本
在项目根目录下执行自带的比对工具（默认自动加载本地官方缓存，按需流式提取 Workspace 技能）：
```bash
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js
```
若需要强制拉取官方云端最新清单：
```bash
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js --remote
```
若需要程序化结构体，可添加 `--json` 参数：
```bash
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js --json
```

### 步骤 2：分析比对结果
脚本将自动输出三类结果：
1. **新上架插件**：官方清单中出现，但 `dicts/marketplace_plugins.json` 尚未收录的全新插件。
2. **待翻译/变更文案**：
   - 基础卡片简介变动或新增；
   - 新增的 `suggestedPrompts` 建议提示词；
   - （Google Workspace 专区插件）官方最新版本中新增或变更的斜杠技能完整描述。
3. **已下架/待清理插件**：官方清单中已不存在，但字典中可能残存的孤立词条。

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
