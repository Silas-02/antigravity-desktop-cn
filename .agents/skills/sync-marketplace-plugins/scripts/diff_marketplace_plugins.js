#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const https = require('https');
const crypto = require('crypto');
const childProcess = require('child_process');

// 官方权威云端数据源（双专区）
const OFFICIAL_REMOTE_MARKETPLACE_URLS = [
  { name: 'Google 官方插件专区', url: 'https://www.gstatic.com/antigravity/plugins/marketplace.json' },
  { name: '官方合作伙伴插件专区', url: 'https://www.gstatic.com/antigravity/plugins-partners/marketplace.json' }
];

const DEFAULT_MARKETPLACES_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'cache', 'marketplaces');
const DEFAULT_DICT_PATH = path.resolve(__dirname, '../../../../dicts/marketplace_plugins.json');
const DEFAULT_MCP_DICT_PATH = path.resolve(__dirname, '../../../../dicts/page_mcp_knowledge.json');
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

function extractSkillDescription(content) {
  if (!content) return null;
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const frontmatterMatch = normalizedContent.match(/^---\n([\s\S]*?)\n---/);
  const source = frontmatterMatch ? frontmatterMatch[1] : normalizedContent;
  const match = source.match(/(?:^|\n)description:\s*([\s\S]+?)(?=\n[A-Za-z0-9_-]+:|\n*$)/i);
  if (!match) return null;
  let desc = match[1].trim();
  desc = desc.replace(/^(?:[>|][+-]?)\s*(?:\n|$)/, '');
  if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
    desc = desc.slice(1, -1);
  }
  return normalizeText(desc);
}

// 解析 ZIP Buffer 提取 Workspace 插件的 README.md 概览与 SKILL.md 技能说明（纯内存流零落盘）
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
            const desc = extractSkillDescription(content);
            if (desc) {
              result.skills.push(desc);
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

// 跨平台代理感知网络拉取器（自动继承 HTTP_PROXY / HTTPS_PROXY，保证云端实时直连稳定可靠）
async function fetchRemoteData(url, asBuffer = false) {
  // 1. 优先使用 curl，自动继承环境代理与系统证书
  try {
    const { execSync } = require('child_process');
    const buf = execSync(`curl -sL --max-time 15 "${url}"`, { maxBuffer: 100 * 1024 * 1024 });
    if (buf && buf.length > 0) {
      return asBuffer ? buf : buf.toString('utf-8');
    }
  } catch (e) {}

  // 2. 回退使用 Node 内置 fetch
  try {
    const res = await fetch(url);
    if (res.ok) {
      if (asBuffer) {
        return Buffer.from(await res.arrayBuffer());
      }
      return await res.text();
    }
  } catch (e) {}

  return null;
}

// 核心加载器：默认以官方云端下发数据为权威基准，支持离线或本地调试回退
async function loadMarketplaceCatalog(targetPath, useLocal = false) {
  // 1. 默认优先从官方云端 API 下发拉取全量专区数据
  if (!useLocal) {
    try {
      const combinedPlugins = [];
      const loadedSources = [];
      const catalogDescriptions = [];
      for (const item of OFFICIAL_REMOTE_MARKETPLACE_URLS) {
        try {
          const rawText = await fetchRemoteData(item.url, false);
          if (rawText) {
            const data = JSON.parse(rawText);
            if (data.description && typeof data.description === 'string') {
              catalogDescriptions.push({
                origin: item.name,
                description: data.description.trim()
              });
            }
            if (Array.isArray(data.plugins)) {
              const isPartner = item.url.includes('partners');
              for (const p of data.plugins) {
                p.__originCategory = isPartner ? '官方合作伙伴' : (isWorkspacePlugin(p.name) ? 'Google Workspace' : 'Google 官方');
              }
              combinedPlugins.push(...data.plugins);
              loadedSources.push(`${item.name} (${data.plugins.length}款)`);
            }
          }
        } catch (e) {}
      }

      if (combinedPlugins.length > 0) {
        return {
          catalog: { plugins: combinedPlugins, catalogDescriptions },
          source: `官方云端实时下发 [${loadedSources.join(' + ')}]`,
          localBaseDir: null,
          error: null
        };
      }
      console.warn('⚠️ 无法连接官方云端市场，尝试回退至本地缓存...');
    } catch (err) {
      console.warn(`⚠️ 拉取云端市场异常 (${err.message})，尝试回退至本地缓存...`);
    }
  }

  // 2. 本地缓存模式 (用户显式指定 --local / --cache-dir 或云端不可达时回退)
  const localTarget = targetPath || DEFAULT_MARKETPLACES_DIR;
  if (fs.existsSync(localTarget)) {
    try {
      if (fs.statSync(localTarget).isDirectory()) {
        const subDirs = fs.readdirSync(localTarget);
        const combinedPlugins = [];
        const loadedSources = [];
        const catalogDescriptions = [];
        let officialBaseDir = null;
        for (const sub of subDirs) {
          const subPath = path.join(localTarget, sub);
          const mJson = path.join(subPath, 'marketplace.json');
          if (fs.existsSync(mJson) && fs.statSync(mJson).isFile()) {
            const data = JSON.parse(fs.readFileSync(mJson, 'utf-8'));
            if (data.description && typeof data.description === 'string') {
              catalogDescriptions.push({
                origin: sub,
                description: data.description.trim()
              });
            }
            if (Array.isArray(data.plugins)) {
              const isPartner = sub.includes('partners');
              for (const p of data.plugins) {
                p.__originCategory = isPartner ? '官方合作伙伴' : (isWorkspacePlugin(p.name) ? 'Google Workspace' : 'Google 官方');
                p.__localBaseDir = subPath;
              }
              combinedPlugins.push(...data.plugins);
              const label = isPartner ? '官方合作伙伴' : 'Google 官方';
              loadedSources.push(`${label} (${data.plugins.length}款)`);
              if (!isPartner) officialBaseDir = subPath;
            }
          }
        }
        if (combinedPlugins.length > 0) {
          return {
            catalog: { plugins: combinedPlugins, catalogDescriptions },
            source: `本地缓存离线读取 [${loadedSources.join(' + ')}]`,
            localBaseDir: officialBaseDir,
            error: null
          };
        }
      } else {
        const data = JSON.parse(fs.readFileSync(localTarget, 'utf-8'));
        const catalogDescriptions = [];
        if (data.description && typeof data.description === 'string') {
          catalogDescriptions.push({ origin: '本地指定文件', description: data.description.trim() });
        }
        return {
          catalog: { plugins: data.plugins || [], catalogDescriptions },
          source: `本地指定文件 (${localTarget})`,
          localBaseDir: path.dirname(localTarget),
          error: null
        };
      }
    } catch (err) {
      return { catalog: null, source: null, localBaseDir: null, error: `读取本地市场失败: ${err.message}` };
    }
  }

  return { catalog: null, source: null, localBaseDir: null, error: '未获取到插件市场元数据（云端不可达且无可用本地缓存）' };
}

async function parseMarketplace(catalog, localBaseDir) {
  const plugins = {};
  if (!catalog || !Array.isArray(catalog.plugins)) {
    return { plugins, catalogDescriptions: [], error: '市场元数据格式不正确，缺少 plugins 数组' };
  }

  const catalogDescriptions = Array.isArray(catalog.catalogDescriptions) ? catalog.catalogDescriptions : [];
  const localPluginsDir = localBaseDir ? path.join(localBaseDir, 'plugins') : null;

  for (const p of catalog.plugins) {
    const pId = p.name;
    const isWorkspace = isWorkspacePlugin(pId);
    const originCategory = p.__originCategory || (isWorkspace ? 'Google Workspace' : 'Google 官方');
    const curLocalBaseDir = p.__localBaseDir || localBaseDir;
    const curLocalPluginsDir = curLocalBaseDir ? path.join(curLocalBaseDir, 'plugins') : localPluginsDir;
    const info = {
      id: pId,
      displayName: p.displayName || p.name || pId,
      version: p.version || 'unknown',
      card_description: (p.description || '').trim(),
      overview_description: null,
      suggestedPrompts: Array.isArray(p.suggestedPrompts) ? p.suggestedPrompts : [],
      is_workspace: isWorkspace,
      origin_category: originCategory,
      workspace_skills: [],
      sourceUrl: (p.source && p.source.url) ? p.source.url : null
    };

    // Google Workspace 专区插件提取 Tier 2 (README 概览) 与 Tier 3 (SKILL.md 技能说明)
    if (isWorkspace) {
      let loadedFromLocal = false;
      // 若处于本地缓存模式，优先读本地解压文件
      if (curLocalPluginsDir) {
        const pVerDir = path.join(curLocalPluginsDir, pId, info.version);
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
                const desc = extractSkillDescription(content);
                if (desc) {
                  info.workspace_skills.push(desc);
                }
              }
            }
          } catch (e) {}
        }
      }

      // 默认云端模式或本地未缓存时，从云端 ZIP URL 流式拉取 Buffer 并解析（纯内存流零落盘）
      if (!loadedFromLocal && info.sourceUrl) {
        try {
          const buf = await fetchRemoteData(info.sourceUrl, true);
          if (buf) {
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

  return { plugins, catalogDescriptions, error: null };
}

function diffPlugins(cachePlugins, catalogDescriptions, primaryDict, allDicts, primaryFileName) {
  const missingCardDescriptions = [];
  const missingOverviewDescriptions = [];
  const missingPrompts = [];
  const missingWorkspaceSkills = [];
  const missingCatalogDescriptions = [];
  const crossDictDuplicates = [];
  const crossDictMisplaced = [];
  const coveredPlugins = [];
  const newPlugins = [];

  // 1. 动态比对专区目录说明（来自云端下发元数据）
  for (const cat of catalogDescriptions) {
    const cStatus = checkEntryStatus(cat.description, primaryDict, allDicts, primaryFileName);
    if (!cStatus.covered) {
      missingCatalogDescriptions.push({ origin: cat.origin, text: cat.description, status: cStatus.status, files: cStatus.files });
      if (cStatus.status === 'in_other_dict') {
        crossDictMisplaced.push({ id: cat.origin, type: '专区目录说明', text: cat.description, currentFiles: cStatus.files });
      }
    } else if (cStatus.status === 'duplicate') {
      crossDictDuplicates.push({ id: cat.origin, type: '专区目录说明', text: cat.description, otherFiles: cStatus.files });
    }
  }

  // 2. 比对插件各项内容
  for (const [pId, info] of Object.entries(cachePlugins)) {
    const cardDesc = info.card_description;
    const overviewDesc = info.overview_description;
    const prompts = info.suggestedPrompts;
    const skills = info.workspace_skills;

    // (1) 卡片一句话简介
    const cardStatus = checkEntryStatus(cardDesc, primaryDict, allDicts, primaryFileName);
    if (!cardStatus.covered) {
      missingCardDescriptions.push({ id: pId, text: cardDesc, status: cardStatus.status, files: cardStatus.files });
      if (cardStatus.status === 'in_other_dict') {
        crossDictMisplaced.push({ id: pId, type: '卡片一句话简介', text: cardDesc, currentFiles: cardStatus.files });
      }
    } else if (cardStatus.status === 'duplicate') {
      crossDictDuplicates.push({ id: pId, type: '卡片一句话简介', text: cardDesc, otherFiles: cardStatus.files });
    }

    // (2) Workspace 详情抽屉概览 (README.md)
    if (info.is_workspace && overviewDesc) {
      const overviewStatus = checkEntryStatus(overviewDesc, primaryDict, allDicts, primaryFileName);
      if (!overviewStatus.covered) {
        missingOverviewDescriptions.push({ id: pId, text: overviewDesc, status: overviewStatus.status, files: overviewStatus.files });
        if (overviewStatus.status === 'in_other_dict') {
          crossDictMisplaced.push({ id: pId, type: '详情概览(README)', text: overviewDesc, currentFiles: overviewStatus.files });
        }
      } else if (overviewStatus.status === 'duplicate') {
        crossDictDuplicates.push({ id: pId, type: '详情概览(README)', text: overviewDesc, otherFiles: overviewStatus.files });
      }
    }

    // (3) 官方建议提示词
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

    // (4) Workspace 技能路由规则 (SKILL.md)
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
    missingCatalogDescriptions,
    crossDictDuplicates,
    crossDictMisplaced
  };
}

function printReport(cachePlugins, catalogDescriptions, diffResult, primaryDict, catalogSource, primaryFileName) {
  const totalCache = Object.keys(cachePlugins).length;
  const newP = diffResult.newPlugins;
  const missCardDesc = diffResult.missingCardDescriptions;
  const missOverviewDesc = diffResult.missingOverviewDescriptions;
  const missPrompts = diffResult.missingPrompts;
  const missSkills = diffResult.missingWorkspaceSkills;
  const missCatalogs = diffResult.missingCatalogDescriptions;
  const duplicates = diffResult.crossDictDuplicates;
  const misplaced = diffResult.crossDictMisplaced;

  console.log('==================================================================');
  console.log('    Antigravity 插件市场（Marketplace）权威数据与字典比对报告');
  console.log('==================================================================');
  console.log(`🌐 权威数据来源: ${catalogSource}`);
  console.log(`📦 官方插件总数: ${totalCache} 款 (Google 官方专区 + 官方合作伙伴专区)`);
  if (catalogDescriptions.length > 0) {
    const coveredCat = catalogDescriptions.length - missCatalogs.length;
    console.log(`📋 专区目录说明: ${coveredCat}/${catalogDescriptions.length} 已覆盖`);
  }
  console.log(`📖 主字典词条总数 (${primaryFileName}): ${Object.keys(primaryDict).length} 条\n`);

  console.log('------------------------------------------------------------------');
  console.log('1. 插件覆盖状态概览 (全量多专区架构 + 分层审计)');
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
      const tag = info.origin_category ? `[${info.origin_category}]` : '[通用插件]';
      const tagPadded = tag.padEnd(19, ' ');
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

  if (missCatalogs.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【专区目录说明待翻译 (来自云端下发元数据)】共 ${missCatalogs.length} 条:`);
    for (const item of missCatalogs) {
      const hint = item.status === 'in_other_dict' ? ` [已存在于 dicts/${item.files.join(', ')}，建议迁移归位]` : '';
      console.log(`   [${item.origin}] ${item.text}${hint}`);
    }
  }

  if (missCardDesc.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【Tier 1: 市场卡片一句话简介待翻译/变更】共 ${missCardDesc.length} 条:`);
    for (const item of missCardDesc) {
      const hint = item.status === 'in_other_dict' ? ` [已存在于 dicts/${item.files.join(', ')}，建议迁移归位]` : '';
      console.log(`   [${item.id}] ${item.text}${hint}`);
    }
  }

  if (missOverviewDesc.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【Tier 2: 详情抽屉概览待翻译 (Workspace 插件 README.md)】共 ${missOverviewDesc.length} 条:`);
    for (const item of missOverviewDesc) {
      const hint = item.status === 'in_other_dict' ? ` [已存在于 dicts/${item.files.join(', ')}，建议迁移归位]` : '';
      console.log(`   [${item.id}] ${item.text}${hint}`);
    }
  }

  if (missSkills.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【Tier 3: 技能路由完整规则待翻译 (Workspace 插件 SKILL.md)】共 ${missSkills.length} 条:`);
    for (const item of missSkills) {
      const hint = item.status === 'in_other_dict' ? ` [已存在于 dicts/${item.files.join(', ')}，建议迁移归位]` : '';
      console.log(`   [${item.id}] ${item.text.slice(0, 80)}...${hint}`);
    }
  }

  if (missPrompts.length > 0) {
    hasIssues = true;
    console.log(`\n⚠️ 【官方建议提示词待翻译 (suggestedPrompts)】共 ${missPrompts.length} 条:`);
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
    console.log('🎉 当前字典与官方云端插件市场全量元数据已 100% 同步并满足规范！无缺失词条。');
  }

  console.log('\n💡 核心安全提示:');
  console.log('   1. 插件市场以官方云端下发元数据为唯一权威基准，涵盖 Google 官方专区与官方合作伙伴专区。');
  console.log('   2. Google Workspace 协同办公专区具备三层独立共存文案体系：');
  console.log('      - Tier 1: 卡片简介 (marketplace.json)');
  console.log('      - Tier 2: 详情概览 (README.md)');
  console.log('      - Tier 3: 技能路由 (SKILL.md)');
  console.log('      三者在不同界面区域同时展示，切勿将卡片简介与详情概览误当成新旧替换！');
  console.log('   3. 通用官方插件与合作伙伴插件遵循轻量精准汉化原则（仅收录卡片简介与官方建议提示词）。');
  console.log('   4. 仅当官方插件版本升级且官方英文源文确实彻底被修改时，才执行原位替换并清理旧英文。');
  console.log('==================================================================');
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMcpLookupText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .trim();
}

function discoverLocalLanguageServer() {
  try {
    if (process.platform === 'win32') {
      const out = childProcess.execFileSync(
        'powershell',
        ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      if (!out.trim()) return null;
      let list = JSON.parse(out.trim());
      if (!Array.isArray(list)) list = [list];
      const proc = list.find(p => p && p.CommandLine && p.CommandLine.includes('--csrf_token'));
      if (!proc) return null;
      const tokenMatch = proc.CommandLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
      const netOut = childProcess.execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Get-NetTCPConnection -OwningProcess ${proc.ProcessId} -State Listen | Select-Object -ExpandProperty LocalPort`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const ports = netOut.trim().split(/\r?\n/).map(x => Number(x.trim())).filter(n => !isNaN(n));
      return { pid: proc.ProcessId, csrfToken: tokenMatch ? tokenMatch[1] : '', ports };
    }

    const psOut = childProcess.execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = psOut.split(/\r?\n/).find(l => l.includes('language_server') && l.includes('--csrf_token'));
    if (!line) return null;
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) return null;
    const pid = Number(m[1]);
    const cmd = m[2];
    const tokenMatch = cmd.match(/--csrf_token\s+([a-f0-9-]+)/i);
    const lsofOut = childProcess.execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ports = [];
    for (const pm of lsofOut.matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
      const p = Number(pm[1]);
      if (!ports.includes(p)) ports.push(p);
    }
    return { pid, csrfToken: tokenMatch ? tokenMatch[1] : '', ports };
  } catch (e) {
    return null;
  }
}

function localLanguageServerPost(port, method, csrfToken, payloadObj, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payloadObj || {});
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'x-codeium-csrf-token': csrfToken,
          'content-length': Buffer.byteLength(body)
        }
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode, body: raw }));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.end(body);
  });
}

function resolveLsBinaryFromPath(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim().replace(/^"|"$/g, '');
  if (!trimmed) return null;
  let resolved;
  try {
    resolved = path.resolve(trimmed);
  } catch (e) {
    return null;
  }
  if (!fs.existsSync(resolved)) return null;

  const binName = process.platform === 'win32' ? 'language_server.exe' : 'language_server';
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    return null;
  }

  if (stat.isFile()) {
    if (/^language_server(?:\.exe)?$/i.test(path.basename(resolved))) {
      return resolved;
    }
    resolved = path.dirname(resolved);
  }

  const dirsToCheck = [
    resolved,
    path.join(resolved, 'bin'),
    path.join(resolved, 'resources', 'bin'),
    path.join(resolved, 'Contents', 'Resources', 'bin'),
    path.resolve(resolved, '..'),
    path.resolve(resolved, '..', 'bin'),
    path.resolve(resolved, '..', 'resources', 'bin'),
    path.resolve(resolved, '..', 'Contents', 'Resources', 'bin')
  ];

  for (const dir of dirsToCheck) {
    const target = path.join(dir, binName);
    try {
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        return target;
      }
    } catch (e) {}
  }
  return null;
}

function detectRunningLsBinaryPaths() {
  const found = [];
  try {
    if (process.platform === 'win32') {
      const out = childProcess.execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe' OR Name='Antigravity.exe'\" | Select-Object -ExpandProperty ExecutablePath"
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      for (const line of out.split(/\r?\n/)) {
        if (line.trim()) found.push(line.trim());
      }
      return found;
    }

    if (process.platform === 'darwin') {
      const out = childProcess.execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        const lsMatch = line.match(/(\/[^\n]*?\/language_server)\b/);
        if (lsMatch) found.push(lsMatch[1]);
        const appMatch = line.match(/(\/[^\n]*?\.app)\/Contents\/MacOS\/Antigravity\b/i);
        if (appMatch) found.push(appMatch[1]);
      }
      return found;
    }

    const out = childProcess.execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('language_server') && (!/antigravity/i.test(line) || line.includes('--type='))) continue;
      const m = line.trim().match(/^(\d+)\s+/);
      if (!m) continue;
      try {
        found.push(fs.realpathSync(`/proc/${m[1]}/exe`));
      } catch (e) {}
    }
  } catch (e) {}
  return found;
}

function locateLanguageServerBinary(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.ANTIGRAVITY_LS_BIN,
    process.env.CODEIUM_LANGUAGE_SERVER_BIN,
    process.env.ANTIGRAVITY_INSTALL_DIR,
    process.env.ANTIGRAVITY_HOME
  ].filter(Boolean);

  for (const c of candidates) {
    const resolved = resolveLsBinaryFromPath(c);
    if (resolved) return resolved;
  }

  for (const p of detectRunningLsBinaryPaths()) {
    const resolved = resolveLsBinaryFromPath(p);
    if (resolved) return resolved;
  }

  // 检查 ~/.gemini/antigravity/bin/agentapi 包装脚本中记录的官方路径
  const agentApiWrapper = path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
  if (fs.existsSync(agentApiWrapper)) {
    try {
      const content = fs.readFileSync(agentApiWrapper, 'utf8');
      const m = content.match(/"([^"]*language_server(?:\.exe)?)"/i);
      if (m) {
        const resolved = resolveLsBinaryFromPath(m[1]);
        if (resolved) return resolved;
      }
    } catch (e) {}
  }

  const defaultDirs = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    if (localAppData) {
      defaultDirs.push(path.join(localAppData, 'Programs', 'Antigravity'));
      defaultDirs.push(path.join(localAppData, 'Antigravity'));
    }
    defaultDirs.push('C:\\Program Files\\Antigravity', 'C:\\Program Files (x86)\\Antigravity');
  } else if (process.platform === 'darwin') {
    defaultDirs.push('/Applications/Antigravity.app', path.join(os.homedir(), 'Applications', 'Antigravity.app'));
  } else {
    defaultDirs.push(
      '/opt/antigravity/Antigravity-x64',
      '/opt/antigravity',
      '/opt/Antigravity',
      '/usr/share/antigravity',
      '/usr/lib/antigravity',
      path.join(os.homedir(), '.local', 'share', 'antigravity'),
      path.join(os.homedir(), '.local', 'share', 'Antigravity'),
      path.join(os.homedir(), 'antigravity'),
      path.join(os.homedir(), 'Antigravity')
    );
  }

  for (const dir of defaultDirs) {
    const resolved = resolveLsBinaryFromPath(dir);
    if (resolved) return resolved;
  }
  return null;
}

/** 启动完全隔离的临时无头 language_server 实例拉取官方 MCP 商店目录（兼容 v2.34.0+） */
function fetchMcpCatalogViaEphemeralLs(lsBinPath, osName) {
  return new Promise(resolve => {
    let tmpDir = '';
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mcp-audit-'));
    } catch (e) {
      resolve({ data: null, error: `创建临时目录失败: ${e.message}` });
      return;
    }

    const csrfToken = crypto.randomUUID();
    const args = [
      '--standalone',
      '--headless',
      '--disable_telemetry',
      '--exit_on_stdin_close',
      '--gemini_dir', tmpDir,
      '--app_data_dir', 'mcp_audit',
      '--https_server_port', '0',
      '--override_ide_name', 'antigravity',
      '--subclient_type', 'hub',
      '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com'
    ];

    let proc;
    try {
      proc = childProcess.spawn(lsBinPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ANTIGRAVITY_SERVER_CSRF_TOKEN: csrfToken }
      });
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      resolve({ data: null, error: `启动临时 language_server 失败: ${e.message}` });
      return;
    }

    proc.stdin?.on('error', () => {});

    let finished = false;
    let startedQuery = false;
    let logTail = '';
    let hardTimer = null;

    const removeTmpDir = () => {
      if (!tmpDir) return;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    };

    const onSignal = () => {
      try { proc.stdin?.end(); } catch (_) {}
      try { proc.kill('SIGTERM'); } catch (_) {}
      removeTmpDir();
      process.exit(130);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const finalize = (result) => {
      if (finished) return;
      finished = true;
      if (hardTimer) clearTimeout(hardTimer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);

      const done = () => {
        removeTmpDir();
        resolve(result);
      };

      if (proc.exitCode !== null || proc.signalCode !== null) {
        done();
        return;
      }

      let exited = false;
      const finishOnce = () => {
        if (exited) return;
        exited = true;
        clearTimeout(killFallback);
        done();
      };
      proc.once('exit', finishOnce);
      try { proc.stdin?.end(); } catch (_) {}
      try { proc.kill('SIGTERM'); } catch (_) {}
      const killFallback = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        finishOnce();
      }, 1500);
      killFallback.unref?.();
    };

    hardTimer = setTimeout(() => {
      finalize({ data: null, error: '临时 language_server 查询 MCP 目录超时' });
    }, 22000);

    const handleOutput = chunk => {
      if (finished) return;
      logTail = (logTail + chunk.toString('utf8')).slice(-8192);
      if (startedQuery) return;
      const m = logTail.match(/listening on \w+ port at (\d+) for HTTPS\b/i)
        || logTail.match(/listening on \w+ port at (\d+) for HTTP(S)?\b/i);
      if (!m) return;
      startedQuery = true;
      const port = Number(m[1]);

      (async () => {
        let lastErr = '';
        for (let attempt = 0; attempt < 25 && !finished; attempt++) {
          try {
            const data = await localLanguageServerPost(
              port,
              'GetAvailableCascadePlugins',
              csrfToken,
              { os: osName, searchQuery: '' },
              10000
            );
            if (data && Array.isArray(data.plugins)) {
              finalize({ data, error: null });
              return;
            }
            lastErr = '响应缺少 plugins 列表';
            break;
          } catch (err) {
            lastErr = err && err.message ? err.message : String(err);
            if (err && typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 408 && err.statusCode !== 429) {
              break;
            }
            await new Promise(r => setTimeout(r, 250));
          }
        }
        finalize({ data: null, error: lastErr || '未能从临时 language_server 获取官方 MCP 目录' });
      })();
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);
    proc.on('error', err => {
      finalize({ data: null, error: `临时 language_server 运行异常: ${err.message}` });
    });
    proc.on('exit', code => {
      if (!finished) {
        finalize({ data: null, error: `临时 language_server 提前退出 (code=${code})` });
      }
    });
  });
}

/** 对比官方实时 MCP 服务器商店目录与独立词典 (page_mcp_knowledge.json) */
async function auditMcpStore(dictsDir, mcpDictFile, options = {}) {
  let catalogData = null;
  let sourceMode = '';
  const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');

  // 路径 1（旧版 v2.33.0 及更早快速通道）：若运行中进程仍携带 --csrf_token，直接复用
  if (!options.lsBinPath) {
    const srv = discoverLocalLanguageServer();
    if (srv && srv.csrfToken && srv.ports.length > 0) {
      for (const port of srv.ports) {
        try {
          const data = await localLanguageServerPost(port, 'GetAvailableCascadePlugins', srv.csrfToken, {
            os: osName,
            searchQuery: ''
          });
          if (data && Array.isArray(data.plugins)) {
            catalogData = data;
            sourceMode = 'running-ls';
            break;
          }
        } catch (e) {}
      }
    }
  }

  // 路径 2（v2.34.0+ 主路径及离线 GUI 兼容）：临时拉起隔离无头 language_server 查询
  if (!catalogData) {
    const lsBinPath = locateLanguageServerBinary(options.lsBinPath);
    if (!lsBinPath) {
      return {
        available: false,
        skippedReason: '未定位到 Antigravity language_server 可执行文件（可通过 --ls-bin 指定路径）'
      };
    }
    const probe = await fetchMcpCatalogViaEphemeralLs(lsBinPath, osName);
    if (!probe.data) {
      return {
        available: false,
        skippedReason: probe.error || '未能从临时 language_server 获取官方 MCP 目录'
      };
    }
    catalogData = probe.data;
    sourceMode = 'ephemeral-ls';
  }

  const mcpFileName = path.basename(mcpDictFile);
  const normLowerMap = new Map();
  let mcpDict = {};

  if (fs.existsSync(dictsDir)) {
    const files = fs.readdirSync(dictsDir).filter(f => f.endsWith('.json')).sort();
    for (const file of files) {
      const fullPath = path.join(dictsDir, file);
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      if (path.resolve(fullPath) === path.resolve(mcpDictFile)) {
        mcpDict = data;
      }
      for (const [k, v] of Object.entries(data)) {
        const nk = normalizeMcpLookupText(k).toLowerCase();
        if (!normLowerMap.has(nk)) {
          normLowerMap.set(nk, { file, key: k, value: v });
        }
      }
    }
  }

  const plugins = catalogData.plugins || [];
  const coveredInMcpDict = [];
  const misplacedInOtherDicts = [];
  const missing = [];

  for (const p of plugins) {
    if (!p.description) continue;
    const desc = normalizeMcpLookupText(p.description);
    const hit = normLowerMap.get(desc.toLowerCase());
    if (!hit) {
      missing.push({
        id: p.id,
        title: p.title,
        description: desc
      });
    } else if (hit.file === mcpFileName) {
      coveredInMcpDict.push(p.id);
    } else {
      misplacedInOtherDicts.push({
        id: p.id,
        title: p.title,
        description: desc,
        currentFile: hit.file,
        key: hit.key
      });
    }
  }

  const officialNormDescs = new Set(plugins.map(p => normalizeMcpLookupText(p.description).toLowerCase()).filter(Boolean));
  const officialByTitleWord = plugins.map(p => ({
    id: p.id,
    title: p.title,
    desc: normalizeMcpLookupText(p.description)
  }));

  const obsoleteMcpEntries = [];
  const NON_STORE_UI_PREFIX = /^(Loading|No |MCP |Installed |Add |Search|Refresh|Open |View |Could not|Failed |Error |Used |Plugins are )/i;

  for (const [k, v] of Object.entries(mcpDict)) {
    const nk = normalizeMcpLookupText(k).toLowerCase();
    if (k.length < 30 || NON_STORE_UI_PREFIX.test(k)) continue;
    if (!officialNormDescs.has(nk)) {
      const matchedPlugin = officialByTitleWord.find(p => {
        if (!p.title || p.title.length < 2) return false;
        const re = new RegExp(`\\b${escapeRegExp(p.title.toLowerCase())}\\b`, 'i');
        return re.test(nk);
      });
      obsoleteMcpEntries.push({
        key: k,
        translation: v,
        matchedTitle: matchedPlugin ? matchedPlugin.title : null,
        replacementHint: matchedPlugin ? matchedPlugin.desc : null
      });
    }
  }

  return {
    available: true,
    sourceMode,
    mcpDictFile: mcpFileName,
    mcpDictCount: Object.keys(mcpDict).length,
    totalOfficial: plugins.length,
    coveredCount: coveredInMcpDict.length + misplacedInOtherDicts.length,
    coveredInMcpDictCount: coveredInMcpDict.length,
    misplacedInOtherDicts,
    missing,
    obsoleteMcpEntries
  };
}

function printMcpSection(mcpResult) {
  console.log('\n------------------------------------------------------------------');
  console.log('3. MCP 服务器商店（MCP Store）官方目录与词典比对');
  console.log('------------------------------------------------------------------');
  if (!mcpResult) return;
  if (!mcpResult.available) {
    console.log(`ℹ️ 已跳过 MCP 商店比对：${mcpResult.skippedReason}。`);
    return;
  }

  const sourceHint = mcpResult.sourceMode === 'ephemeral-ls'
    ? '临时隔离无头 language_server (v2.34.0+ 兼容模式)'
    : '运行态 language_server';
  console.log(`📡 MCP 数据来源: ${sourceHint}`);
  console.log(`🔌 官方 MCP 服务器总数: ${mcpResult.totalOfficial} | 全词典覆盖: ${mcpResult.coveredCount}/${mcpResult.totalOfficial} | 主字典 (${mcpResult.mcpDictFile}) 收录: ${mcpResult.coveredInMcpDictCount}`);

  let hasMcpIssues = false;
  if (mcpResult.missing.length > 0) {
    hasMcpIssues = true;
    console.log(`\n⚠️ 【MCP 商店缺失未翻译描述】共 ${mcpResult.missing.length} 条:`);
    for (const m of mcpResult.missing) {
      console.log(`   [${m.id}] (${m.title}) ${m.description}`);
    }
  }
  if (mcpResult.misplacedInOtherDicts.length > 0) {
    hasMcpIssues = true;
    console.log(`\n🔄 【MCP 词条跨字典错位，建议迁移至 ${mcpResult.mcpDictFile}】共 ${mcpResult.misplacedInOtherDicts.length} 条:`);
    for (const m of mcpResult.misplacedInOtherDicts) {
      console.log(`   • [${m.id}] 现存于 dicts/${m.currentFile} -> "${m.key}"`);
    }
  }
  if (mcpResult.obsoleteMcpEntries.length > 0) {
    hasMcpIssues = true;
    console.log(`\n🗑️ 【${mcpResult.mcpDictFile} 中已改版或下架的历史描述】共 ${mcpResult.obsoleteMcpEntries.length} 条:`);
    for (const o of mcpResult.obsoleteMcpEntries) {
      const hint = o.replacementHint ? ` (现版 [${o.matchedTitle}]: ${o.replacementHint})` : ' (当前官方列表无对应描述)';
      console.log(`   • "${o.key}" => "${o.translation}"${hint}`);
    }
  }

  if (!hasMcpIssues) {
    console.log(`🎉 当前 ${mcpResult.mcpDictFile} 与官方 ${mcpResult.totalOfficial} 个 MCP 服务器已 100% 同步！无缺失、错位或过时条目。`);
  }
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let marketplacePath = null;
  let dictFile = DEFAULT_DICT_PATH;
  let mcpDictFile = DEFAULT_MCP_DICT_PATH;
  let lsBinPath = null;
  let isJson = false;
  let useLocal = false;
  let mcpMode = 'auto'; // 'auto' | 'only' | 'skip'

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--cache-dir' || args[i] === '--marketplace-file') && args[i + 1]) {
      marketplacePath = path.resolve(args[++i]);
      useLocal = true;
    } else if (args[i] === '--local') {
      useLocal = true;
    } else if (args[i] === '--dict-file' && args[i + 1]) {
      dictFile = path.resolve(args[++i]);
    } else if (args[i] === '--mcp-dict' && args[i + 1]) {
      mcpDictFile = path.resolve(args[++i]);
    } else if ((args[i] === '--ls-bin' || args[i] === '--install-dir') && args[i + 1]) {
      lsBinPath = path.resolve(args[++i]);
    } else if (args[i] === '--mcp-only') {
      mcpMode = 'only';
    } else if (args[i] === '--no-mcp') {
      mcpMode = 'skip';
    } else if (args[i] === '--json') {
      isJson = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`用法: node diff_marketplace_plugins.js [选项]

选项:
  (默认)                      直连官方云端拉取插件市场双专区数据，并同步审计官方 MCP 商店
  --local                     插件市场改用本地缓存目录进行离线比对
  --cache-dir <path>          指定本地市场缓存目录或 marketplace.json 文件路径
  --dict-file <path>          插件市场字典路径 (默认: dicts/marketplace_plugins.json)
  --mcp-dict <path>           MCP 商店字典路径 (默认: dicts/page_mcp_knowledge.json)
  --ls-bin <path>             指定 language_server 可执行文件或 Antigravity 安装目录路径
  --mcp-only                  仅运行官方 MCP 商店比对（支持 v2.34.0+ 隔离无头拉取，无需启动桌面端）
  --no-mcp                    仅运行插件市场比对（跳过 MCP 商店）
  --json                      以 JSON 结构化格式输出比对结果
  -h, --help                  显示此帮助信息
`);
      process.exit(0);
    }
  }

  return { marketplacePath, dictFile, mcpDictFile, lsBinPath, isJson, useLocal, mcpMode };
}

async function main() {
  const { marketplacePath, dictFile, mcpDictFile, lsBinPath, isJson, useLocal, mcpMode } = parseCliArgs();

  if (mcpMode === 'only') {
    if (!fs.existsSync(mcpDictFile)) {
      console.error(`错误: MCP 字典文件未找到: ${mcpDictFile}`);
      process.exit(1);
    }
    const mcpResult = await auditMcpStore(DICTS_DIR, mcpDictFile, { lsBinPath });
    if (!mcpResult.available) {
      console.error(`错误: ${mcpResult.skippedReason}`);
      process.exit(1);
    }
    if (isJson) {
      console.log(JSON.stringify({ mcp: mcpResult }, null, 2));
    } else {
      printMcpSection(mcpResult);
    }
    return;
  }

  const { catalog, source: catalogSource, localBaseDir, error: loadErr } = await loadMarketplaceCatalog(marketplacePath, useLocal);
  if (loadErr) {
    console.error(`错误: ${loadErr}`);
    process.exit(1);
  }

  const { plugins: cachePlugins, catalogDescriptions, error: parseErr } = await parseMarketplace(catalog, localBaseDir);
  if (parseErr) {
    console.error(`错误: ${parseErr}`);
    process.exit(1);
  }

  if (!fs.existsSync(dictFile)) {
    console.error(`错误: 字典文件未找到: ${dictFile}`);
    process.exit(1);
  }

  const { primaryDict, allDicts, primaryFileName } = loadAllDictionaries(DICTS_DIR, dictFile);
  const diffResult = diffPlugins(cachePlugins, catalogDescriptions, primaryDict, allDicts, primaryFileName);
  const mcpResult = mcpMode === 'skip' ? null : await auditMcpStore(DICTS_DIR, mcpDictFile, { lsBinPath });

  if (isJson) {
    const output = {
      catalogSource,
      totalPlugins: Object.keys(cachePlugins).length,
      dictEntriesCount: Object.keys(primaryDict).length,
      diff: diffResult,
      ...(mcpResult ? { mcp: mcpResult } : {})
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    printReport(cachePlugins, catalogDescriptions, diffResult, primaryDict, catalogSource, primaryFileName);
    if (mcpResult) {
      printMcpSection(mcpResult);
    }
  }
}

main();
