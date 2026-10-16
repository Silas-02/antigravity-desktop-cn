#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const OFFICIAL_REMOTE_MARKETPLACE_URL = 'https://www.gstatic.com/antigravity/plugins/marketplace.json';
const DEFAULT_LOCAL_MARKETPLACE_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'cache', 'marketplaces', 'antigravity-plugins-official', 'marketplace.json');
const DEFAULT_DICT_PATH = path.resolve(__dirname, '../../../../dicts/marketplace_plugins.json');

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

// 解析 ZIP Buffer 提取 SKILL.md 技能说明
function extractSkillsFromZipBuffer(buf) {
  const skills = [];
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

      if (fileName.endsWith('SKILL.md')) {
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
          const match = content.match(/description:\s*([\s\S]+?)(?=\n---|\n[a-z]+:)/i);
          if (match) {
            skills.push(match[1].trim());
          }
        }
      }
      offset = fileDataStart + compressedSize;
    } else {
      offset++;
    }
  }
  return skills;
}

async function loadMarketplaceCatalog(targetPath, forceRemote = false) {
  if (!forceRemote) {
    let resolvedPath = targetPath;
    if (fs.existsSync(resolvedPath)) {
      if (fs.statSync(resolvedPath).isDirectory()) {
        const inDir = path.join(resolvedPath, 'marketplace.json');
        const inParent = path.join(path.dirname(resolvedPath), 'marketplace.json');
        if (fs.existsSync(inDir)) resolvedPath = inDir;
        else if (fs.existsSync(inParent)) resolvedPath = inParent;
      }
    }

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      try {
        const text = fs.readFileSync(resolvedPath, 'utf-8');
        return { catalog: JSON.parse(text), source: `本地文件 (${resolvedPath})`, error: null };
      } catch (err) {
        return { catalog: null, source: null, error: `解析本地 marketplace.json 失败: ${err.message}` };
      }
    }
  }

  // 回退拉取官方云端数据
  try {
    const res = await fetch(OFFICIAL_REMOTE_MARKETPLACE_URL);
    if (!res.ok) {
      return { catalog: null, source: null, error: `拉取官方远端市场失败，HTTP 状态码: ${res.status}` };
    }
    const text = await res.text();
    return { catalog: JSON.parse(text), source: `官方云端 (${OFFICIAL_REMOTE_MARKETPLACE_URL})`, error: null };
  } catch (err) {
    return { catalog: null, source: null, error: `无法获取官方市场清单: ${err.message}` };
  }
}

async function parseMarketplace(catalog) {
  const plugins = {};
  if (!catalog || !Array.isArray(catalog.plugins)) {
    return { plugins, error: '市场元数据格式不正确，缺少 plugins 数组' };
  }

  for (const p of catalog.plugins) {
    const pId = p.name;
    const isWorkspace = isWorkspacePlugin(pId);
    const info = {
      id: pId,
      displayName: p.displayName || p.name || pId,
      version: p.version || 'unknown',
      description: (p.description || '').trim(),
      suggestedPrompts: Array.isArray(p.suggestedPrompts) ? p.suggestedPrompts : [],
      is_workspace: isWorkspace,
      workspace_skills: [],
      sourceUrl: (p.source && p.source.url) ? p.source.url : null
    };

    // Workspace 专区插件流式提取技能说明
    if (isWorkspace && info.sourceUrl) {
      try {
        const res = await fetch(info.sourceUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const memSkills = extractSkillsFromZipBuffer(buf);
          if (memSkills.length > 0) {
            info.workspace_skills = memSkills;
          }
        }
      } catch (err) {
      }
    }

    plugins[pId] = info;
  }

  return { plugins, error: null };
}

function diffPlugins(cachePlugins, dictData) {
  const missingDescriptions = [];
  const missingPrompts = [];
  const missingWorkspaceSkills = [];
  const coveredPlugins = [];
  const newPlugins = [];

  for (const [pId, info] of Object.entries(cachePlugins)) {
    const desc = info.description;
    const prompts = info.suggestedPrompts;
    const skills = info.workspace_skills;

    const descCovered = !desc || (desc in dictData);
    const promptsMissing = prompts.filter(pr => !(pr in dictData));
    const skillsMissing = [];

    if (info.is_workspace) {
      for (const sk of skills) {
        if (!(sk in dictData)) {
          skillsMissing.push(sk);
        }
      }
    }

    if (!descCovered) {
      missingDescriptions.push({ id: pId, desc });
    }
    for (const pr of promptsMissing) {
      missingPrompts.push({ id: pId, prompt: pr });
    }
    for (const sk of skillsMissing) {
      missingWorkspaceSkills.push({ id: pId, skill: sk });
    }

    if (!descCovered && promptsMissing.length === prompts.length && prompts.length > 0) {
      newPlugins.push(pId);
    } else {
      coveredPlugins.push(pId);
    }
  }

  return {
    newPlugins,
    coveredPlugins,
    missingDescriptions,
    missingPrompts,
    missingWorkspaceSkills
  };
}

function printReport(cachePlugins, diffResult, dictData, catalogSource) {
  const totalCache = Object.keys(cachePlugins).length;
  const newP = diffResult.newPlugins;
  const missDesc = diffResult.missingDescriptions;
  const missPrompts = diffResult.missingPrompts;
  const missSkills = diffResult.missingWorkspaceSkills;

  console.log('==================================================================');
  console.log('    Antigravity 插件市场（Marketplace）全量元数据与字典比对报告');
  console.log('==================================================================');
  console.log(`🌐 权威数据来源: ${catalogSource}`);
  console.log(`📦 官方插件总数: ${totalCache} 个`);
  console.log(`📖 当前字典词条总数: ${Object.keys(dictData).length} 条\n`);

  console.log('------------------------------------------------------------------');
  console.log('1. 插件覆盖状态概览');
  console.log('------------------------------------------------------------------');

  for (const [pId, info] of Object.entries(cachePlugins)) {
    const tag = info.is_workspace ? '[Google Workspace]' : '[通用插件]';
    const descOk = (info.description in dictData) ? '✅ 描述已译' : '❌ 描述缺失/已变更';
    const promptCnt = info.suggestedPrompts.length;
    const promptCov = info.suggestedPrompts.filter(pr => pr in dictData).length;
    const promptsStatus = (promptCnt === promptCov) ? `✅ 提示词 (${promptCov}/${promptCnt})` : `⚠️ 提示词 (${promptCov}/${promptCnt})`;
    
    const pIdPadded = pId.padEnd(26, ' ');
    const verPadded = `v${info.version}`.padEnd(10, ' ');
    const tagPadded = tag.padEnd(19, ' ');
    console.log(`  • ${pIdPadded} ${verPadded} ${tagPadded} ${descOk} | ${promptsStatus}`);
  }

  console.log('\n------------------------------------------------------------------');
  console.log('2. 增量待补充/更新清单');
  console.log('------------------------------------------------------------------');
  let hasIssues = false;

  if (newP.length > 0) {
    hasIssues = true;
    console.log(`🟢 【全新上架插件】共 ${newP.length} 个:`);
    for (const p of newP) {
      console.log(`   + ${p} (${cachePlugins[p].displayName})`);
    }
  }

  if (missDesc.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【卡片基础描述待翻译/变更（若为版本升级请更新替换旧词条）】共 ${missDesc.length} 条:`);
    for (const item of missDesc) {
      console.log(`   [${item.id}] ${item.desc}`);
    }
  }

  if (missPrompts.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【官方建议提示词待翻译】共 ${missPrompts.length} 条:`);
    for (const item of missPrompts) {
      console.log(`   [${item.id}] ${item.prompt}`);
    }
  }

  if (missSkills.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【Google Workspace 专区技能详情完整说明待补充】共 ${missSkills.length} 条:`);
    for (const item of missSkills) {
      console.log(`   [${item.id}] ${item.skill.slice(0, 80)}...`);
    }
  }

  if (!hasIssues) {
    console.log('🎉 当前字典与官方插件市场全量元数据已 100% 同步并满足规范！无缺失词条。');
  }

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

  const { catalog, source: catalogSource, error: loadErr } = await loadMarketplaceCatalog(marketplacePath, forceRemote);
  if (loadErr) {
    console.error(`错误: ${loadErr}`);
    process.exit(1);
  }

  const { plugins: cachePlugins, error: parseErr } = await parseMarketplace(catalog);
  if (parseErr) {
    console.error(`错误: ${parseErr}`);
    process.exit(1);
  }

  if (!fs.existsSync(dictFile)) {
    console.error(`错误: 字典文件未找到: ${dictFile}`);
    process.exit(1);
  }

  let dictData = {};
  try {
    dictData = JSON.parse(fs.readFileSync(dictFile, 'utf-8'));
  } catch (err) {
    console.error(`错误: 字典文件 JSON 格式非法: ${err.message}`);
    process.exit(1);
  }

  const diffResult = diffPlugins(cachePlugins, dictData);

  if (isJson) {
    const output = {
      catalogSource,
      totalPlugins: Object.keys(cachePlugins).length,
      dictEntriesCount: Object.keys(dictData).length,
      diff: diffResult
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    printReport(cachePlugins, diffResult, dictData, catalogSource);
  }
}

main();
