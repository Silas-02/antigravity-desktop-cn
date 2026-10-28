---
name: sync-marketplace-plugins
description: >-
  同步、审计并比对官方 Antigravity 插件市场插件与插件市场专用词典。在 Antigravity 版本升级或需要更新、审计及清理插件市场汉化文案时使用此技能。
---

# Antigravity 插件市场官方同步与审计技能

本技能专门用于在 Antigravity 客户端发生版本更新或维护插件市场区域时，以官方权威元数据（`marketplace.json`）为唯一基准，采用流式内存零落盘与本地缓存深度解析技术，全方位比对插件市场文案与汉化词典，并支持跨字典感知与多层文案架构审计。

---

## 1. Google Workspace 专区三层文案架构解析

Google Workspace 协同办公专区插件（`gcalendar`、`gdocs`、`gdrive`、`gsheets`、`gslides` 及后续同族套件）具备**三层独立并存**的文案体系。**这三层文案在客户端界面的不同区域同时生效展示，绝非新旧版本的覆盖替换关系**：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Google Workspace 专区三层文案架构                │
├─────────┬──────────────────────┬────────────────────────┬──────────────┤
│ 层级    │ 文案类型             │ 数据源                 │ 客户端展示区 │
├─────────┼──────────────────────┼────────────────────────┼──────────────┤
│ Tier 1  │ 卡片一句话简介       │ marketplace.json /     │ 插件市场卡片 │
│         │ (Card Description)   │ plugin.json            │ 列表与概览网格
├─────────┼──────────────────────┼────────────────────────┼──────────────┤
│ Tier 2  │ 详情抽屉概览描述     │ 插件包根目录           │ 点开卡片后的 │
│         │ (Overview / README)  │ README.md (首段概览)   │ 详情抽屉首段 │
├─────────┼──────────────────────┼────────────────────────┼──────────────┤
│ Tier 3  │ 技能路由完整规则     │ skills/*/SKILL.md      │ 斜杠技能弹窗 │
│         │ (Skill Routing Desc) │ frontmatter description│ 与路由调度区 │
└─────────┴──────────────────────┴────────────────────────┴──────────────┘
```

> [!CAUTION]
> **严禁跨层级混淆与误删**：
> 1. **Tier 1**（卡片简介）与 **Tier 2**（README 概览）在界面中是**同时存在**的。绝不能因为录入了 Tier 1 卡片简介，就将 Tier 2 的 README 概览描述当作“已废弃旧文案”删除！
> 2. 只有当官方插件发布新版本、且**同一层级**的官方源文确实发生修改时，才允许对该层级进行原位更新替换。

---

## 2. 核心翻译标准与收录边界

在处理插件市场文案时，严格执行以下收录标准：

### 🟢 Google Workspace 官方协同办公专区（全量深度汉化）
包含 `gcalendar`、`gdocs`、`gdrive`、`gsheets`、`gslides`（以及未来官方增补的 `gmail`、`gtasks`、`gmeet` 等）：
1. **Tier 1: 卡片一句话简介**（源自 `marketplace.json` 的 `description`）。
2. **Tier 2: 详情抽屉概览描述**（源自插件包根目录 `README.md`，归整为单行）。
3. **Tier 3: 技能详情完整说明**（源自 `skills/*/SKILL.md` frontmatter `description`）。
4. **官方建议提示词**（源自 `suggestedPrompts` 快速操作提示词列表）。
5. **技能选择器安全展示绑定**：在 `localization_engine.js` 中的 `SKILL_PICKER_DISPLAY_ENTRIES` 为技能添加行上下文绑定的安全中文转换规则（如 `gcalendar` -> `Google 日历`，`gdocs` -> `Google 文档`）。

### 🟡 其余官方插件专区（精准轻量汉化）
包含 Flutter、Firebase、Data Agent Kit、Modern Web Guidance、Science、Chrome DevTools、Android CLI、Gemini API、Google Maps Platform 等其余所有官方通用插件。
**严格限定仅收录以下三项**：
1. **市场通用界面与交互控制**（导航、分类筛选、安装/启用/禁用状态标签、配置/认证弹窗、错误提示等通用 DOM 控件文案）。
2. **插件卡片一句话简介**（各插件在市场卡片列表展示的 `description`）。
3. **官方建议提示词列表**（各插件配套的 `suggestedPrompts` 快速操作提示词）。

**严格禁止收录**：
- ❌ **严禁收录通用插件抽屉详情的 README/文档长篇 Markdown**（如依赖配置、环境要求、命令行使用指南、开源协议等）。
- ❌ **严禁收录通用插件内部单个技能函数/工具的深层描述**。

---

## 3. 跨字典感知与字典归属原则

- **唯一主字典**：插件市场专区的所有卡片描述、README 概览、建议提示词、Workspace 技能说明统一收录在 `dicts/marketplace_plugins.json`。
- **严禁跨字典重复**：严禁将上述内容重复录入到主版本字典（如 `v2.28.0.json`）或其他分包字典中。
- **跨字典错位迁移**：比对脚本具备全字典感知能力（自动扫描 `dicts/*.json`）。
  - 若比对报告标记 `[已存在于 dicts/xxx.json，建议迁移归位]`，说明该词条已有翻译，但放错了字典文件。应将其从原字典迁移剪切至 `dicts/marketplace_plugins.json`，严禁重复录入或判定为完全缺失。
  - 若比对报告标记 `🚨 【跨字典重复收录警告】`，应清理其他非主字典中的冗余条目。

---

## 4. 自动化比对与审计操作工作流

### 步骤 1：运行自动化比对脚本
在项目根目录下执行自带的比对工具：
```bash
# 默认优先加载本地官方缓存，按需流式提取 Workspace 技能与 README
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js

# 强制拉取官方云端最新 marketplace.json 与 ZIP 归档（纯内存流零落盘）
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js --remote

# 以结构化 JSON 格式输出结果
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js --json
```

### 步骤 2：解读结构化比对报告
脚本自动输出以下三部分：
1. **插件覆盖状态概览**：
   - Workspace 插件清晰呈现四维指标：`✅ 卡片简介 | ✅ 详情概览(README) | ✅ 技能路由 (1/1) | ✅ 提示词 (3/3)`
   - 通用插件清晰呈现双维指标：`✅ 卡片简介 | ✅ 提示词 (3/3)`
2. **增量待补充/更新清单**：
   - 🟢 全新上架插件
   - ⚠️ Tier 1: 市场卡片一句话简介待翻译 / 变更
   - ⚠️ Tier 2: 详情抽屉概览待翻译 (Workspace README.md)
   - ⚠️ Tier 3: 技能路由完整规则待翻译 (Workspace SKILL.md)
   - ⚠️ 官方建议提示词待翻译
3. **跨字典错位迁移与重复收录警告**：
   - 明确指出需要从其他字典迁移归位的词条，以及跨字典重复冗余项。

### 步骤 3：向用户呈现结构化报告并征求确认
将比对得出的分析结论呈现给用户：
- 列出新上架插件及其待翻译文本；
- 列出文案变更项（注明需**原位更新替换**并**清理废弃旧词条**）；
- 列出跨字典错位迁移建议；
- 征询用户确认后再执行修改。

### 步骤 4：执行更新、迁移与验证
在用户确认后：
1. **严格 1:1 格式与标点对齐**：英文是什么标点，译文必须严格对应半角标点（句号 `.`、冒号 `:`、叹号 `!`、问号 `?` 严禁替换为中文全角标点）。
2. **执行字典写入或迁移**：
   - 增量新词条写入 `dicts/marketplace_plugins.json`；
   - 错位词条从原字典迁移至 `dicts/marketplace_plugins.json`；
   - 同一层级因版本升级发生变动的文案，执行原位替换并清理旧英文。
3. 若涉及 Workspace 技能描述变更，同步更新 `localization_engine.js` 中的 `SKILL_PICKER_DISPLAY_ENTRIES`。
4. 执行轻量字典校验：
   ```bash
   node -e "require('fs').readdirSync('dicts').filter(f=>f.endsWith('.json')).forEach(f=>JSON.parse(require('fs').readFileSync('dicts/'+f,'utf8'))); console.log('Dicts valid!');"
   ```
5. 再次运行比对脚本，验证是否达到 100% 同步且无任何缺失或重复：
   ```bash
   node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js
   ```
