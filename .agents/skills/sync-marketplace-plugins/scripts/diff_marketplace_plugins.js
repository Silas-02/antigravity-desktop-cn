#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const OFFICIAL_REMOTE_MARKETPLACE_URL = 'https://www.gstatic.com/antigravity/plugins/marketplace.json';
const DEFAULT_LOCAL_MARKETPLACE_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'cache', 'marketplaces', 'antigravity-plugins-official', 'marketplace.json');
const DEFAULT_DICT_PATH = path.resolve(__dirname, '../../../../dicts/marketplace_plugins.json');
const DICTS_DIR = path.resolve(__dirname, '../../../../dicts');

const KNOWN_WORKSPACE_PLUGINS = new Set([
  'gcalendar',
  'gdocs',
  'gdrive',
  'gsheets',
  'gslides'
]);

function isWorkspacePlugin(pId) {
  if (KNOWN_WORKSPACE_PLUGINS.has(pId)) return true;
  if (/^g(mail|tasks|meet|chat|forms|keep|sites)$/i.test(pId)) return true;
  return false;
}

function normalizeText(text) {
  if (!text) return '';
  return text.trim().replace(/\r\n/g, '\n').replace(/\n+/g, ' ').replace(/\s+/g, ' ');
}

// 解析 ZIP Buffer 提取 Workspace 插件的 README.md 概览与 SKILL.md 技能说明
function extractWorkspaceAssetsFromZipBuffer(buf) {
  const result = {
    overviewDescription: null,
    skills: []
  };
  let offset = 0;
  while (offset < buf.length - 4) {
    if (buf.readUInt32LE(offset) === 0x04034b50) {
      const compression = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const uncompressedSize = buf.readUInt32LE(offset + 22);
      const fileNameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const fileName = buf.toString('utf-8', offset + 30, offset + 30 + fileNameLen);
      const fileDataStart = offset + 30 + fileNameLen + extraLen;

      if (fileName.endsWith('README.md') || fileName.endsWith('SKILL.md')) {
        let content;
        if (compression === 0) {
          content = buf.toString('utf-8', fileDataStart, fileDataStart + uncompressedSize);
        } else if (compression === 8) {
          const compData = buf.subarray(fileDataStart, fileDataStart + compressedSize);
          try {
            content = zlib.inflateRawSync(compData).toString('utf-8');
          } catch (e) {}
        }
        if (content) {
          if (fileName.endsWith('README.md')) {
            const normalized = normalizeText(content);
            if (normalized) {
              result.overviewDescription = normalized;
            }
          } else if (fileName.endsWith('SKILL.md')) {
            const match = content.match(/description:\s*([\s\S]+?)(?=\n---|\n[a-z]+:)/i);
            if (match) {
              result.skills.push(match[1].trim());
            }
          }
        }
      }
      offset = fileDataStart + compressedSize;
    } else {
      offset++;
    }
  }
  return result;
}

// 扫描 dicts 目录建立全字典词条索引，实现跨字典感知
function loadAllDictionaries(dictsDir, primaryDictPath) {
  const allDicts = {}; // key -> [file1, file2]
  let primaryDict = {};
  const primaryFileName = path.basename(primaryDictPath);

  if (fs.existsSync(dictsDir)) {
    const files = fs.readdirSync(dictsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const fullPath = path.join(dictsDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        if (path.resolve(fullPath) === path.resolve(primaryDictPath)) {
          primaryDict = data;
        }
        for (const key of Object.keys(data)) {
          if (!allDicts[key]) allDicts[key] = [];
          allDicts[key].push(file);
        }
      } catch (e) {}
    }
  }
  return { primaryDict, allDicts, primaryFileName };
}

function checkEntryStatus(key, primaryDict, allDicts, primaryFileName) {
  if (!key) return { covered: true, status: 'ok', files: [] };
  const inPrimary = key in primaryDict;
  const otherFiles = (allDicts[key] || []).filter(f => f !== primaryFileName);

  if (inPrimary && otherFiles.length > 0) {
    return { covered: true, status: 'duplicate', files: otherFiles };
  }
  if (inPrimary) {
    return { covered: true, status: 'ok', files: [] };
  }
  if (otherFiles.length > 0) {
    return { covered: false, status: 'in_other_dict', files: otherFiles };
  }
  return { covered: false, status: 'missing', files: [] };
}

async function loadMarketplaceCatalog(targetPath, forceRemote = false) {
  let resolvedBaseDir = null;
  if (!forceRemote) {
    let resolvedPath = targetPath;
    if (fs.existsSync(resolvedPath)) {
      if (fs.statSync(resolvedPath).isDirectory()) {
        const inDir = path.join(resolvedPath, 'marketplace.json');
        const inParent = path.join(path.dirname(resolvedPath), 'marketplace.json');
        if (fs.existsSync(inDir)) {
          resolvedPath = inDir;
          resolvedBaseDir = resolvedPath;
        } else if (fs.existsSync(inParent)) {
          resolvedPath = inParent;
          resolvedBaseDir = path.dirname(resolvedPath);
        }
      } else {
        resolvedBaseDir = path.dirname(resolvedPath);
      }
    }

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      try {
        const text = fs.readFileSync(resolvedPath, 'utf-8');
        return { catalog: JSON.parse(text), source: `本地文件 (${resolvedPath})`, localBaseDir: resolvedBaseDir, error: null };
      } catch (err) {
        return { catalog: null, source: null, localBaseDir: null, error: `解析本地 marketplace.json 失败: ${err.message}` };
      }
    }
  }

  // 回退拉取官方云端数据
  try {
    const res = await fetch(OFFICIAL_REMOTE_MARKETPLACE_URL);
    if (!res.ok) {
      return { catalog: null, source: null, localBaseDir: null, error: `拉取官方远端市场失败，HTTP 状态码: ${res.status}` };
    }
    const text = await res.text();
    return { catalog: JSON.parse(text), source: `官方云端 (${OFFICIAL_REMOTE_MARKETPLACE_URL})`, localBaseDir: null, error: null };
  } catch (err) {
    return { catalog: null, source: null, localBaseDir: null, error: `无法获取官方市场清单: ${err.message}` };
  }
}

async function parseMarketplace(catalog, localBaseDir, forceRemote = false) {
  const plugins = {};
  if (!catalog || !Array.isArray(catalog.plugins)) {
    return { plugins, error: '市场元数据格式不正确，缺少 plugins 数组' };
  }

  const localPluginsDir = localBaseDir ? path.join(localBaseDir, 'plugins') : null;

  for (const p of catalog.plugins) {
    const pId = p.name;
    const isWorkspace = isWorkspacePlugin(pId);
    const info = {
      id: pId,
      displayName: p.displayName || p.name || pId,
      version: p.version || 'unknown',
      card_description: (p.description || '').trim(),
      overview_description: null,
      suggestedPrompts: Array.isArray(p.suggestedPrompts) ? p.suggestedPrompts : [],
      is_workspace: isWorkspace,
      workspace_skills: [],
      sourceUrl: (p.source && p.source.url) ? p.source.url : null
    };

    // Google Workspace 专区插件提取 Tier 2 (README 概览) 与 Tier 3 (SKILL.md 技能说明)
    if (isWorkspace) {
      let loadedFromLocal = false;
      if (!forceRemote && localPluginsDir) {
        const pVerDir = path.join(localPluginsDir, pId, info.version);
        const readmePath = path.join(pVerDir, 'README.md');
        if (fs.existsSync(readmePath)) {
          const rawReadme = fs.readFileSync(readmePath, 'utf-8');
          info.overview_description = normalizeText(rawReadme);
          loadedFromLocal = true;
        }

        const skillsDir = path.join(pVerDir, 'skills');
        if (fs.existsSync(skillsDir)) {
          try {
            const subEntries = fs.readdirSync(skillsDir);
            for (const sub of subEntries) {
              const skillFile = path.join(skillsDir, sub, 'SKILL.md');
              if (fs.existsSync(skillFile)) {
                const content = fs.readFileSync(skillFile, 'utf-8');
                const match = content.match(/description:\s*([\s\S]+?)(?=\n---|\n[a-z]+:)/i);
                if (match) {
                  info.workspace_skills.push(match[1].trim());
                }
              }
            }
          } catch (e) {}
        }
      }

      // 若未从本地读取到，且存在 sourceUrl，则从内存 ZIP Buffer 流式提取
      if (!loadedFromLocal && info.sourceUrl) {
        try {
          const res = await fetch(info.sourceUrl);
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            const assets = extractWorkspaceAssetsFromZipBuffer(buf);
            if (assets.overviewDescription) {
              info.overview_description = assets.overviewDescription;
            }
            if (assets.skills.length > 0) {
              info.workspace_skills = assets.skills;
            }
          }
        } catch (err) {}
      }
    }

    plugins[pId] = info;
  }

  return { plugins, error: null };
}

function diffPlugins(cachePlugins, primaryDict, allDicts, primaryFileName) {
  const missingCardDescriptions = [];
  const missingOverviewDescriptions = [];
  const missingPrompts = [];
  const missingWorkspaceSkills = [];
  const crossDictDuplicates = [];
  const crossDictMisplaced = [];
  const coveredPlugins = [];
  const newPlugins = [];

  for (const [pId, info] of Object.entries(cachePlugins)) {
    const cardDesc = info.card_description;
    const overviewDesc = info.overview_description;
    const prompts = info.suggestedPrompts;
    const skills = info.workspace_skills;

    // 1. 卡片基础描述
    const cardStatus = checkEntryStatus(cardDesc, primaryDict, allDicts, primaryFileName);
    if (!cardStatus.covered) {
      missingCardDescriptions.push({ id: pId, text: cardDesc, status: cardStatus.status, files: cardStatus.files });
      if (cardStatus.status === 'in_other_dict') {
        crossDictMisplaced.push({ id: pId, type: '卡片一句话简介', text: cardDesc, currentFiles: cardStatus.files });
      }
    } else if (cardStatus.status === 'duplicate') {
      crossDictDuplicates.push({ id: pId, type: '卡片一句话简介', text: cardDesc, otherFiles: cardStatus.files });
    }

    // 2. Workspace 详情抽屉概览 (README.md)
    let overviewStatus = { covered: true, status: 'ok', files: [] };
    if (info.is_workspace && overviewDesc) {
      overviewStatus = checkEntryStatus(overviewDesc, primaryDict, allDicts, primaryFileName);
      if (!overviewStatus.covered) {
        missingOverviewDescriptions.push({ id: pId, text: overviewDesc, status: overviewStatus.status, files: overviewStatus.files });
        if (overviewStatus.status === 'in_other_dict') {
          crossDictMisplaced.push({ id: pId, type: '详情概览(README)', text: overviewDesc, currentFiles: overviewStatus.files });
        }
      } else if (overviewStatus.status === 'duplicate') {
        crossDictDuplicates.push({ id: pId, type: '详情概览(README)', text: overviewDesc, otherFiles: overviewStatus.files });
      }
    }

    // 3. 官方建议提示词
    const promptsMissing = [];
    for (const pr of prompts) {
      const pStatus = checkEntryStatus(pr, primaryDict, allDicts, primaryFileName);
      if (!pStatus.covered) {
        promptsMissing.push({ id: pId, text: pr, status: pStatus.status, files: pStatus.files });
        if (pStatus.status === 'in_other_dict') {
          crossDictMisplaced.push({ id: pId, type: '官方建议提示词', text: pr, currentFiles: pStatus.files });
        }
      } else if (pStatus.status === 'duplicate') {
        crossDictDuplicates.push({ id: pId, type: '官方建议提示词', text: pr, otherFiles: pStatus.files });
      }
    }
    missingPrompts.push(...promptsMissing);

    // 4. Workspace 技能路由规则 (SKILL.md)
    const skillsMissing = [];
    if (info.is_workspace) {
      for (const sk of skills) {
        const sStatus = checkEntryStatus(sk, primaryDict, allDicts, primaryFileName);
        if (!sStatus.covered) {
          skillsMissing.push({ id: pId, text: sk, status: sStatus.status, files: sStatus.files });
          if (sStatus.status === 'in_other_dict') {
            crossDictMisplaced.push({ id: pId, type: '技能路由(SKILL.md)', text: sk, currentFiles: sStatus.files });
          }
        } else if (sStatus.status === 'duplicate') {
          crossDictDuplicates.push({ id: pId, type: '技能路由(SKILL.md)', text: sk, otherFiles: sStatus.files });
        }
      }
      missingWorkspaceSkills.push(...skillsMissing);
    }

    const isCompletelyNew = !cardStatus.covered && cardStatus.status === 'missing' &&
      promptsMissing.length === prompts.length && prompts.length > 0;

    if (isCompletelyNew) {
      newPlugins.push(pId);
    } else {
      coveredPlugins.push(pId);
    }
  }

  return {
    newPlugins,
    coveredPlugins,
    missingCardDescriptions,
    missingOverviewDescriptions,
    missingPrompts,
    missingWorkspaceSkills,
    crossDictDuplicates,
    crossDictMisplaced
  };
}

function printReport(cachePlugins, diffResult, primaryDict, catalogSource, primaryFileName) {
  const totalCache = Object.keys(cachePlugins).length;
  const newP = diffResult.newPlugins;
  const missCardDesc = diffResult.missingCardDescriptions;
  const missOverviewDesc = diffResult.missingOverviewDescriptions;
  const missPrompts = diffResult.missingPrompts;
  const missSkills = diffResult.missingWorkspaceSkills;
  const duplicates = diffResult.crossDictDuplicates;
  const misplaced = diffResult.crossDictMisplaced;

  console.log('==================================================================');
  console.log('    Antigravity 插件市场（Marketplace）全量元数据与字典比对报告');
  console.log('==================================================================');
  console.log(`🌐 权威数据来源: ${catalogSource}`);
  console.log(`📦 官方插件总数: ${totalCache} 个`);
  console.log(`📖 主字典词条总数 (${primaryFileName}): ${Object.keys(primaryDict).length} 条\n`);

  console.log('------------------------------------------------------------------');
  console.log('1. 插件覆盖状态概览 (分层架构审计)');
  console.log('------------------------------------------------------------------');

  for (const [pId, info] of Object.entries(cachePlugins)) {
    const pIdPadded = pId.padEnd(26, ' ');
    const verPadded = `v${info.version}`.padEnd(10, ' ');

    const cardDescCovered = info.card_description in primaryDict;
    const cardStatus = cardDescCovered ? '✅ 卡片简介' : '❌ 卡片简介缺失';

    const promptCnt = info.suggestedPrompts.length;
    const promptCov = info.suggestedPrompts.filter(pr => pr in primaryDict).length;
    const promptsStatus = (promptCnt === promptCov) ? `✅ 提示词 (${promptCov}/${promptCnt})` : `⚠️ 提示词 (${promptCov}/${promptCnt})`;

    if (info.is_workspace) {
      const tagPadded = '[Google Workspace]'.padEnd(19, ' ');
      const overviewCovered = !info.overview_description || (info.overview_description in primaryDict);
      const overviewStatus = overviewCovered ? '✅ 详情概览(README)' : '❌ 详情概览缺失';

      const skillCnt = info.workspace_skills.length;
      const skillCov = info.workspace_skills.filter(sk => sk in primaryDict).length;
      const skillStatus = (skillCnt === skillCov) ? `✅ 技能路由 (${skillCov}/${skillCnt})` : `⚠️ 技能路由 (${skillCov}/${skillCnt})`;

      console.log(`  • ${pIdPadded} ${verPadded} ${tagPadded} ${cardStatus} | ${overviewStatus} | ${skillStatus} | ${promptsStatus}`);
    } else {
      const tagPadded = '[通用插件]'.padEnd(19, ' ');
      console.log(`  • ${pIdPadded} ${verPadded} ${tagPadded} ${cardStatus} | ${promptsStatus}`);
    }
  }

  console.log('\n------------------------------------------------------------------');
  console.log('2. 增量待补充/更新清单 (清晰三层边界与跨字典状态)');
  console.log('------------------------------------------------------------------');
  let hasIssues = false;

  if (newP.length > 0) {
    hasIssues = true;
    console.log(`🟢 【全新上架插件待翻译】共 ${newP.length} 个:`);
    for (const p of newP) {
      console.log(`   + ${p} (${cachePlugins[p].displayName})`);
    }
  }

  if (missCardDesc.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【Tier 1: 市场卡片一句话简介待翻译/变更 (来自 marketplace.json)】共 ${missCardDesc.length} 条:`);
    for (const item of missCardDesc) {
      const hint = item.status === 'in_other_dict' ? ` [已存在于 dicts/${item.files.join(', ')}，建议迁移归位]` : '';
      console.log(`   [${item.id}] ${item.text}${hint}`);
    }
  }

  if (missOverviewDesc.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【Tier 2: 详情抽屉概览待翻译 (来自 Workspace 插件 README.md)】共 ${missOverviewDesc.length} 条:`);
    for (const item of missOverviewDesc) {
      const hint = item.status === 'in_other_dict' ? ` [已存在于 dicts/${item.files.join(', ')}，建议迁移归位]` : '';
      console.log(`   [${item.id}] ${item.text}${hint}`);
    }
  }

  if (missSkills.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【Tier 3: 技能路由完整规则待翻译 (来自 Workspace 插件 SKILL.md)】共 ${missSkills.length} 条:`);
    for (const item of missSkills) {
      const hint = item.status === 'in_other_dict' ? ` [已存在于 dicts/${item.files.join(', ')}，建议迁移归位]` : '';
      console.log(`   [${item.id}] ${item.text.slice(0, 80)}...${hint}`);
    }
  }

  if (missPrompts.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【官方建议提示词待翻译 (来自 suggestedPrompts)】共 ${missPrompts.length} 条:`);
    for (const item of missPrompts) {
      const hint = item.status === 'in_other_dict' ? ` [已存在于 dicts/${item.files.join(', ')}，建议迁移归位]` : '';
      console.log(`   [${item.id}] ${item.text}${hint}`);
    }
  }

  if (misplaced.length > 0) {
    hasIssues = true;
    console.log(`\n🔄 【跨字典错位迁移建议】共 ${misplaced.length} 条:`);
    console.log('   以下词条属于插件市场范畴，但目前被放置在其他字典中。建议迁移至 marketplace_plugins.json：');
    for (const item of misplaced) {
      console.log(`   • [${item.id}] [${item.type}] 现存于: dicts/${item.currentFiles.join(', ')} -> "${item.text.slice(0, 60)}..."`);
    }
  }

  if (duplicates.length > 0) {
    console.log(`\n🚨 【跨字典重复收录警告】共 ${duplicates.length} 条:`);
    console.log('   以下词条已在 marketplace_plugins.json 中收录，但在其他字典中也重复存在，建议清理冗余：');
    for (const item of duplicates) {
      console.log(`   • [${item.id}] [${item.type}] 重复存于: dicts/${item.otherFiles.join(', ')} -> "${item.text.slice(0, 60)}..."`);
    }
  }

  if (!hasIssues) {
    console.log('🎉 当前字典与官方插件市场全量元数据已 100% 同步并满足规范！无缺失词条。');
  }

  console.log('\n💡 核心安全提示:');
  console.log('   1. Google Workspace 专区插件具备三层独立共存文案体系：');
  console.log('      - Tier 1: 卡片简介 (marketplace.json)');
  console.log('      - Tier 2: 详情概览 (README.md)');
  console.log('      - Tier 3: 技能路由 (SKILL.md)');
  console.log('      三者在不同界面区域同时展示，切勿将卡片简介与详情概览误当成新旧替换！');
  console.log('   2. 仅当官方插件版本升级且官方英文源文确实彻底被修改时，才执行原位替换并清理旧英文。');
  console.log('==================================================================');
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let marketplacePath = DEFAULT_LOCAL_MARKETPLACE_PATH;
  let dictFile = DEFAULT_DICT_PATH;
  let isJson = false;
  let forceRemote = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--cache-dir' || args[i] === '--marketplace-file') && args[i + 1]) {
      marketplacePath = path.resolve(args[++i]);
    } else if (args[i] === '--dict-file' && args[i + 1]) {
      dictFile = path.resolve(args[++i]);
    } else if (args[i] === '--json') {
      isJson = true;
    } else if (args[i] === '--remote') {
      forceRemote = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`用法: node diff_marketplace_plugins.js [选项]

选项:
  --marketplace-file <path>   marketplace.json 路径或目录 (默认: 自动定位本地缓存，缺失时回退云端)
  --dict-file <path>          市场字典路径 (默认: dicts/marketplace_plugins.json)
  --remote                    强制拉取官方云端最新 marketplace.json
  --json                      以 JSON 结构化格式输出比对结果
  -h, --help                  显示此帮助信息
`);
      process.exit(0);
    }
  }

  return { marketplacePath, dictFile, isJson, forceRemote };
}

async function main() {
  const { marketplacePath, dictFile, isJson, forceRemote } = parseCliArgs();

  const { catalog, source: catalogSource, localBaseDir, error: loadErr } = await loadMarketplaceCatalog(marketplacePath, forceRemote);
  if (loadErr) {
    console.error(`错误: ${loadErr}`);
    process.exit(1);
  }

  const { plugins: cachePlugins, error: parseErr } = await parseMarketplace(catalog, localBaseDir, forceRemote);
  if (parseErr) {
    console.error(`错误: ${parseErr}`);
    process.exit(1);
  }

  if (!fs.existsSync(dictFile)) {
    console.error(`错误: 字典文件未找到: ${dictFile}`);
    process.exit(1);
  }

  const { primaryDict, allDicts, primaryFileName } = loadAllDictionaries(DICTS_DIR, dictFile);

  const diffResult = diffPlugins(cachePlugins, primaryDict, allDicts, primaryFileName);

  if (isJson) {
    const output = {
      catalogSource,
      totalPlugins: Object.keys(cachePlugins).length,
      dictEntriesCount: Object.keys(primaryDict).length,
      diff: diffResult
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    printReport(cachePlugins, diffResult, primaryDict, catalogSource, primaryFileName);
  }
}

main();
