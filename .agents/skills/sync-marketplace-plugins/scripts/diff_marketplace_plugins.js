#!/usr/bin/env node
/**
 * Antigravity 插件市场官方缓存与汉化字典比对工具 (Node.js 原生版)
 * 纯原生 Node.js 实现，零外部依赖。
 * 用于对比本地缓存包 (~/.gemini/antigravity/cache/marketplaces/antigravity-plugins-official/plugins)
 * 与仓库中的 dicts/marketplace_plugins.json，自动检测新上架插件、文案变更及已下架插件。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.gemini/antigravity/cache/marketplaces/antigravity-plugins-official/plugins');
const DEFAULT_DICT_PATH = path.resolve(__dirname, '../../../../dicts/marketplace_plugins.json');

const GOOGLE_WORKSPACE_PLUGINS = new Set([
  'gcalendar',
  'gdocs',
  'gdrive',
  'gsheets',
  'gslides'
]);

// 递归查找匹配文件名的文件
function findFilesRecursively(dir, targetName) {
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    for (const item of list) {
      const fullPath = path.join(dir, item);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          results = results.concat(findFilesRecursively(fullPath, targetName));
        } else if (item === targetName) {
          results.push(fullPath);
        }
      } catch (err) {
        // 忽略无权限或已删除的文件
      }
    }
  } catch (err) {
    // 忽略目录不可读
  }
  return results;
}

function parseCache(cacheDir) {
  if (!fs.existsSync(cacheDir) || !fs.statSync(cacheDir).isDirectory()) {
    return { plugins: null, error: `缓存目录不存在: ${cacheDir}` };
  }

  const plugins = {};
  const entries = fs.readdirSync(cacheDir).sort();

  for (const pId of entries) {
    const pPath = path.join(cacheDir, pId);
    try {
      if (!fs.statSync(pPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const pluginJsonFiles = findFilesRecursively(pPath, 'plugin.json').sort();
    if (pluginJsonFiles.length === 0) continue;

    // 读取最新版本的 plugin.json
    const targetPj = pluginJsonFiles[pluginJsonFiles.length - 1];
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(targetPj, 'utf-8'));
    } catch (err) {
      continue;
    }

    const isWorkspace = GOOGLE_WORKSPACE_PLUGINS.has(pId);
    const info = {
      id: pId,
      displayName: meta.displayName || meta.name || pId,
      version: meta.version || 'unknown',
      description: (meta.description || '').trim(),
      suggestedPrompts: Array.isArray(meta.suggestedPrompts) ? meta.suggestedPrompts : [],
      is_workspace: isWorkspace,
      workspace_skills: []
    };

    // 若属于 Google Workspace 专区，提取对应 SKILL.md 中的斜杠技能描述
    if (isWorkspace) {
      const skillMds = findFilesRecursively(pPath, 'SKILL.md');
      for (const smd of skillMds) {
        try {
          const scontent = fs.readFileSync(smd, 'utf-8');
          const match = scontent.match(/description:\s*([\s\S]+?)(?=\n---|\n[a-z]+:)/i);
          if (match) {
            const sdesc = match[1].trim();
            let sfirst = sdesc.split('. ')[0].trim();
            if (!sfirst.endsWith('.')) {
              sfirst += '.';
            }
            info.workspace_skills.push({
              full: sdesc,
              first: sfirst
            });
          }
        } catch {
          // 忽略解析失败的文件
        }
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
        if (!(sk.full in dictData) || !(sk.first in dictData)) {
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

function printReport(cachePlugins, diffResult, dictData) {
  const totalCache = Object.keys(cachePlugins).length;
  const newP = diffResult.newPlugins;
  const missDesc = diffResult.missingDescriptions;
  const missPrompts = diffResult.missingPrompts;
  const missSkills = diffResult.missingWorkspaceSkills;

  console.log('==================================================================');
  console.log('    Antigravity 插件市场（Marketplace）本地缓存与字典比对报告');
  console.log('==================================================================');
  console.log(`📦 本地缓存插件总数: ${totalCache} 个`);
  console.log(`📖 当前字典词条总数: ${Object.keys(dictData).length} 条\n`);

  console.log('------------------------------------------------------------------');
  console.log('1. 插件覆盖状态概览');
  console.log('------------------------------------------------------------------');

  for (const [pId, info] of Object.entries(cachePlugins)) {
    const tag = info.is_workspace ? '[Google Workspace]' : '[通用插件]';
    const descOk = (info.description in dictData) ? '✅ 描述已译' : '❌ 描述缺失';
    const promptCnt = info.suggestedPrompts.length;
    const promptCov = info.suggestedPrompts.filter(pr => pr in dictData).length;
    const promptsStatus = (promptCnt === promptCov) ? `✅ 提示词 (${promptCov}/${promptCnt})` : `⚠️ 提示词 (${promptCov}/${promptCnt})`;
    
    const pIdPadded = pId.padEnd(25, ' ');
    const verPadded = `v${info.version}`.padEnd(10, ' ');
    const tagPadded = tag.padEnd(18, ' ');
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
    console.log(`\n⚠️ 【卡片基础描述待翻译】共 ${missDesc.length} 条:`);
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
    console.log(`\n⚠️ 【Google Workspace 斜杠技能描述待补充】共 ${missSkills.length} 条:`);
    for (const item of missSkills) {
      console.log(`   [${item.id}] ${item.skill.first}`);
    }
  }

  if (!hasIssues) {
    console.log('🎉 当前字典与本地官方插件缓存已 100% 同步并满足规范！无缺失词条。');
  }

  console.log('==================================================================');
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let cacheDir = DEFAULT_CACHE_DIR;
  let dictFile = DEFAULT_DICT_PATH;
  let isJson = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cache-dir' && args[i + 1]) {
      cacheDir = path.resolve(args[++i]);
    } else if (args[i] === '--dict-file' && args[i + 1]) {
      dictFile = path.resolve(args[++i]);
    } else if (args[i] === '--json') {
      isJson = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`用法: node diff_marketplace_plugins.js [选项]

选项:
  --cache-dir <path>   本地插件缓存路径 (默认: ~/.gemini/antigravity/cache/.../plugins)
  --dict-file <path>   市场字典路径 (默认: dicts/marketplace_plugins.json)
  --json               以 JSON 结构化格式输出比对结果
  -h, --help           显示此帮助信息
`);
      process.exit(0);
    }
  }

  return { cacheDir, dictFile, isJson };
}

function main() {
  const { cacheDir, dictFile, isJson } = parseCliArgs();

  const { plugins: cachePlugins, error } = parseCache(cacheDir);
  if (error) {
    console.error(`错误: ${error}`);
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
      totalCachePlugins: Object.keys(cachePlugins).length,
      dictEntriesCount: Object.keys(dictData).length,
      diff: diffResult
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    printReport(cachePlugins, diffResult, dictData);
  }
}

main();
