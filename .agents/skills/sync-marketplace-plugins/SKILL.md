---
name: sync-marketplace-plugins
description: >-
  同步、审计并比对官方 Antigravity 插件市场插件与插件市场专用词典。在 Antigravity 版本升级或需要更新、审计及清理插件市场汉化文案时使用此技能。
---

# Antigravity 插件市场官方同步与审计技能

本技能专门用于在 Antigravity 客户端发生版本更新或维护插件市场区域时，**以官方云端下发的权威元数据为唯一基准**，采用流式内存零落盘技术全方位拉取并解析官方全量专区插件，深度比对插件市场文案与汉化词典，并支持跨字典感知与多层文案架构审计。

---

## 1. 权威数据源与插件市场架构

官方 Antigravity 插件市场的唯一权威源头为 Google 云端动态下发的插件市场元数据清单，由两大官方专区构成，共涵盖 67+ 款官方认证插件：

1. **Google 官方插件专区**（`antigravity-plugins-official`）：
   - 云端权威接口：`https://www.gstatic.com/antigravity/plugins/marketplace.json`
   - 涵盖 Google Workspace 协同办公套件（`gcalendar`, `gdocs`, `gdrive`, `gsheets`, `gslides`）及官方平台与开发者套件（Flutter, Firebase, Android CLI, Chrome DevTools, Gemini API 等）。
2. **官方合作伙伴插件专区**（`antigravity-plugins-partners`）：
   - 云端权威接口：`https://www.gstatic.com/antigravity/plugins-partners/marketplace.json`
   - 涵盖 Canva, Figma, Linear, Atlassian, Dropbox, Zapier, Zoho, Datadog, Supabase, Vercel 等由官方精选和认证的合作伙伴套件。

> [!IMPORTANT]
> **以云端实时下发为准，严禁依赖可能过时的本地缓存**：
> 官方插件的增删、版本升级及文案更新均直接由云端动态推送。比对审计工具默认直连官方云端接口拉取最新元数据，本地缓存仅作为无网络环境下的离线备选回退。

---

## 2. Google Workspace 专区三层文案架构解析

Google Workspace 协同办公专区插件具备**三层独立并存**的文案体系。**这三层文案在客户端界面的不同区域同时生效展示，绝非新旧版本的覆盖替换关系**：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Google Workspace 专区三层文案架构                │
├─────────┬──────────────────────┬────────────────────────┬──────────────┤
│ 层级    │ 文案类型             │ 数据源                 │ 客户端展示区 │
├─────────┼──────────────────────┼────────────────────────┼──────────────┤
│ Tier 1  │ 卡片一句话简介       │ marketplace.json /     │ 插件市场卡片 │
│         │ (Card Description)   │ plugin.json            │ 列表与概览网格
├─────────┼──────────────────────┼────────────────────────┼──────────────┤
│ Tier 2  │ 详情抽屉概览描述     │ 插件 ZIP 包根目录      │ 点开卡片后的 │
│         │ (Overview / README)  │ README.md (首段概览)   │ 详情抽屉首段 │
├─────────┼──────────────────────┼────────────────────────┼──────────────┤
│ Tier 3  │ 技能路由完整规则     │ skills/*/SKILL.md      │ 斜杠技能弹窗 │
│         │ (Skill Routing Desc) │ frontmatter description│ 与路由调度区 │
└─────────┴──────────────────────┴────────────────────────┴──────────────┘
```

> [!CAUTION]
> **严禁跨层级混淆与误删**：
> 1. **Tier 1**（卡片简介）与 **Tier 2**（README 概览）在界面中是**同时存在**的。绝不能因为录入了 Tier 1 卡片简介，就将 Tier 2 的 README 概览描述当作“已废弃旧文案”删除！
> 2. 只有当官方插件发布新版本、且**同一层级**的官方英文源文确实发生修改时，才允许对该层级进行原位更新替换。

---

## 3. 核心收录边界与翻译分级规范

在处理插件市场文案时，严格执行以下分级收录标准：

### 🟢 1. Google Workspace 协同办公专区（全量深度汉化）
包含 `gcalendar`、`gdocs`、`gdrive`、`gsheets`、`gslides`（以及未来官方增补的同族套件）：
1. **Tier 1: 卡片一句话简介**（源自云端 `marketplace.json` 的 `description`）。
2. **Tier 2: 详情抽屉概览描述**（源自插件 ZIP 归档包 `README.md` 首段概览，流式解压提取并归整为单行）。
3. **Tier 3: 技能详情完整说明**（源自插件包 `skills/*/SKILL.md` frontmatter `description`）。
4. **官方建议提示词**（源自云端下发的 `suggestedPrompts` 快速操作提示词列表）。
5. **技能选择器安全展示绑定**：在 `localization_engine.js` 中的 `SKILL_PICKER_DISPLAY_ENTRIES` 为技能添加行上下文绑定的安全中文转换规则（如 `gcalendar` -> `Google 日历`，`gdocs` -> `Google 文档`）。

### 🟡 2. Google 官方平台套件与官方合作伙伴专区（精准轻量汉化）
包含官方所有通用平台工具及 50+ 款合作伙伴套件。
**严格限定仅收录**：
1. **插件卡片一句话简介**（各插件在市场卡片列表展示的 `description`）。
2. **官方建议提示词列表**（各插件配套的 `suggestedPrompts` 快速操作提示词）。

> [!IMPORTANT]
> **通用与合作伙伴插件严禁过度收录**：
> - ❌ **严禁收录抽屉详情的 README/文档长篇 Markdown**（如依赖配置、环境要求、命令行使用指南、开源协议等）。
> - ❌ **严禁收录内部单个技能函数/工具的深层描述**。

### 🟣 3. 插件市场框架与展示文案原则
插件市场承载各插件分类展示的结构性框架文案（包括专区目录描述 `catalog.description`、专区标签以及客户端用于组织插件的货架分类标题与副标题功能描述）：
1. **归属原则**：凡属于插件市场专区包装与分类框架的文案，统一归收在专用字典 `dicts/marketplace_plugins.json` 中。
2. **动态下发原则**：具体条目以云端下发元数据及客户端实际渲染的内容为准，确保适应官方随时可能新增、下架或调整分类的动态变化。
3. **标点对齐原则**：严格执行半角标点 1:1 对齐（英文以半角 `.` 结尾的，译文必须对齐以半角 `.` 结尾；无标点严禁添加标点）。

---

## 4. 跨字典感知与字典归属原则

- **唯一主字典**：插件市场专区的所有卡片描述、README 概览、建议提示词、Workspace 技能说明及专区分类框架文案统一收录在 `dicts/marketplace_plugins.json`。
- **严禁跨字典重复**：严禁将上述内容重复录入到主版本字典（如 `v2.28.2.json`）或其他分包字典中。
- **跨字典错位迁移**：比对脚本具备全字典感知能力（自动扫描 `dicts/*.json`）。
  - 若比对报告标记 `[已存在于 dicts/xxx.json，建议迁移归位]`，说明该词条已有翻译，但放错了字典文件。应将其从原字典迁移剪切至 `dicts/marketplace_plugins.json`，严禁重复录入或判定为完全缺失。
  - 若比对报告标记 `🚨 【跨字典重复收录警告】`，应清理其他非主字典中的冗余条目。

---

## 5. 自动化比对与审计操作工作流

### 步骤 1：运行自动化比对脚本
在项目根目录下直接执行自带的比对工具：
```bash
# 默认直接直连官方云端接口，拉取全量双专区最新元数据并进行流式深度审计
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js

# 离线环境或测试本地构建时，显式指定读取本地缓存
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js --local

# 以结构化 JSON 格式输出结果
node .agents/skills/sync-marketplace-plugins/scripts/diff_marketplace_plugins.js --json
```

### 步骤 2：解读结构化比对报告
脚本自动输出以下三部分：
1. **插件覆盖状态概览**：
   - 权威数据来源与双专区插件总数
   - 云端动态专区目录说明覆盖状态
   - Workspace 插件四维指标：`✅ 卡片简介 | ✅ 详情概览(README) | ✅ 技能路由 (1/1) | ✅ 提示词 (3/3)`
   - 官方与合作伙伴插件双维指标：`✅ 卡片简介 | ✅ 提示词 (3/3)`
2. **增量待补充/更新清单**：
   - 🟢 全新上架插件
   - ⚠️ 专区目录说明待翻译 (动态自云端元数据)
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
1. **严格 1:1 格式与标点对齐**：英文是什么标点，译文必须严格对应半角标点。
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
