#!/usr/bin/env node
'use strict';

/**
 * MCP Lint — GitHub Action
 *
 * 在 PR 上检查两件事：
 *   1. SEP-1649 MCP Server Card 是否合法（结构 + 格式）
 *   2. 仓库里的 MCP 配置会不会把 agent 的上下文窗口撑爆 / 工具数超过建议上限
 *
 * 为什么放在 CI 里：这两类问题都是**静默**的。
 *   · 卡片写错 → registry / crawler 直接丢弃，没有任何报错
 *   · 工具装太多 → 上下文被吃掉、agent 选错工具，同样没有任何报错
 * 只有把检查放在 PR 上，问题才会在合并前暴露。
 *
 * 设计约束：**零依赖**。
 * 只用 Node 内置能力（global fetch / fs），因此不需要 ncc 打包、
 * 不需要 dist/ 构建产物 —— 仓库里的 src/index.js 就是运行时真正执行的代码。
 * 供应链面也因此只有一个文件。
 */

const fs = require('fs');
const path = require('path');

const ACTION_VERSION = '1.0.0';

// ════════════════════════════════════════════════════════════════
// GitHub Actions 输出助手（零依赖，直接发 workflow command）
// ════════════════════════════════════════════════════════════════

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}=${value}\n`);
}

function annotate(level, message, props) {
  const suffix = props
    ? ' ' + Object.entries(props).map(([k, v]) => `${k}=${v}`).join(',')
    : '';
  // 换行会把 annotation 截断，必须压成一行
  console.log(`::${level}${suffix}::${String(message).replace(/\r?\n/g, ' ')}`);
}

const notice = (m, p) => annotate('notice', m, p);
const warn = (m, p) => annotate('warning', m, p);
const fail = (m, p) => annotate('error', m, p);

function writeSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, markdown + '\n');
}

/** 读取 action input。GitHub 把 `card-path` 映射成环境变量 `INPUT_CARD-PATH`。 */
function input(name, fallback) {
  const v = process.env[`INPUT_${name.toUpperCase()}`];
  return v === undefined || v === '' ? fallback : v;
}

// ════════════════════════════════════════════════════════════════
// 极简 MCP 客户端（JSON-RPC 2.0 over HTTP）
// ════════════════════════════════════════════════════════════════

let rpcId = 0;

/**
 * 端点可能返回 `application/json`，也可能返回 `text/event-stream`（SSE）——
 * 两种都必须能解析，否则换个实现就挂。
 */
function parseRpcBody(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty response from MCP endpoint');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);

  const dataLines = trimmed.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (!dataLines.length) {
    throw new Error(`Unrecognised response (expected JSON or SSE): ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(dataLines[dataLines.length - 1].slice(5).trim());
}

async function callTool(apiUrl, name, args) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': `mcp-lint-action/${ACTION_VERSION} (+https://freetoolhub.org)`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  const text = await res.text();

  if (res.status === 429) {
    throw new Error('Rate limited by the MCP endpoint (free tier is 50 calls/IP/day).');
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${apiUrl}: ${text.slice(0, 300)}`);
  }

  const payload = parseRpcBody(text);
  if (payload.error) {
    throw new Error(`JSON-RPC error ${payload.error.code}: ${payload.error.message}`);
  }
  return payload.result;
}

/** MCP 工具把结果放在 content[0].text 里，内容是 JSON 字符串。 */
function unwrap(result) {
  const item = (result.content || []).find((c) => c.type === 'text');
  if (!item) return {};
  try {
    return JSON.parse(item.text);
  } catch {
    return { _unparsed: item.text };
  }
}

// ════════════════════════════════════════════════════════════════
// 定位文件
// ════════════════════════════════════════════════════════════════

const CONFIG_CANDIDATES = [
  '.mcp.json',
  'mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.claude/mcp.json',
  '.claude/settings.json',
];

function resolveExisting(relativeOrNull) {
  if (!relativeOrNull) return null;
  const p = path.resolve(process.cwd(), relativeOrNull);
  return fs.existsSync(p) ? p : null;
}

function findConfig(explicit) {
  if (explicit) return resolveExisting(explicit);
  for (const c of CONFIG_CANDIDATES) {
    const p = resolveExisting(c);
    if (p) return p;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════

async function main() {
  const cfg = {
    cardPath: input('card-path', '.well-known/mcp/server-card.json'),
    configPath: input('config-path', ''),
    apiUrl: input('api-url', 'https://freetoolhub.org/api/mcp'),
    contextWindow: Number(input('context-window', '200000')),
    failOnError: input('fail-on-error', 'true').toLowerCase() !== 'false',
  };

  let invalidCard = false;
  let toolCount = null;
  let budgetVerdict = null;
  let apiReachable = true;

  const summary = [];
  summary.push('## MCP Lint');
  summary.push('');

  // ── 1. Server Card 校验 ──
  const cardFile = resolveExisting(cfg.cardPath);

  if (!cardFile) {
    notice(`No MCP server card at \`${cfg.cardPath}\` — skipping card validation.`);
    summary.push(`**Server card** — not found at \`${cfg.cardPath}\`, skipped.`);
  } else {
    try {
      const raw = fs.readFileSync(cardFile, 'utf8');
      const data = unwrap(await callTool(cfg.apiUrl, 'validate_mcp_server_card', { card: raw }));

      const valid = data.valid === true;
      const errors = data.errors || [];
      const warnings = data.warnings || [];

      setOutput('card-valid', String(valid));
      summary.push(`**Server card** — \`${cfg.cardPath}\`: ${valid ? 'valid' : 'INVALID'}`);
      summary.push('');

      if (valid) {
        notice(`Server card is valid${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`);
      } else {
        invalidCard = true;
        for (const e of errors) fail(e, { file: cfg.cardPath });
        for (const w of warnings) warn(w, { file: cfg.cardPath });
      }

      if (errors.length || warnings.length) {
        summary.push('| | Message |');
        summary.push('|---|---|');
        for (const e of errors) summary.push(`| error | ${e} |`);
        for (const w of warnings) summary.push(`| warning | ${w} |`);
        summary.push('');
      }

      const remaining = data._meta && data._meta.rateLimit && data._meta.rateLimit.remaining;
      if (typeof remaining === 'number') summary.push(`_Free-tier quota remaining: ${remaining}_`);
      summary.push('');
    } catch (e) {
      // 第三方端点不可用不该弄挂用户的 CI —— fail-open，但要说清楚。
      apiReachable = false;
      warn(`Could not validate the server card: ${e.message}`);
      summary.push(`**Server card** — validation skipped: ${e.message}`);
      summary.push('');
    }
  }

  // ── 2. MCP 配置的上下文预算 ──
  const configFile = findConfig(cfg.configPath);

  if (!configFile) {
    notice('No MCP config found (.mcp.json, mcp.json, .cursor/mcp.json, …) — skipping budget check.');
    summary.push('**Context budget** — no MCP config found, skipped.');
  } else if (!apiReachable) {
    summary.push('**Context budget** — skipped (endpoint unreachable).');
  } else {
    try {
      const raw = fs.readFileSync(configFile, 'utf8');
      const data = unwrap(
        await callTool(cfg.apiUrl, 'estimate_mcp_context_budget', {
          config: raw,
          contextWindow: cfg.contextWindow,
        }),
      );

      toolCount = typeof data.totalToolCount === 'number' ? data.totalToolCount : null;
      budgetVerdict = data.verdict || null;

      setOutput('tool-count', toolCount === null ? '' : String(toolCount));
      setOutput('budget-verdict', budgetVerdict || '');

      const rel = path.relative(process.cwd(), configFile).replace(/\\/g, '/');
      summary.push(`**Context budget** — \`${rel}\``);
      summary.push('');
      summary.push(
        `${toolCount ?? '?'} tools · ~${data.totalToolTokens ?? '?'} tokens · ` +
          `${((data.percentOfWindow || 0) * 100).toFixed(1)}% of a ${cfg.contextWindow.toLocaleString()} window · ` +
          `verdict **${budgetVerdict}**`,
      );
      summary.push('');

      // verdict 取值：healthy < moderate < heavy < severe < over_budget（取各维度最差）
      const CONCERNING = ['heavy', 'severe', 'over_budget'];
      if (CONCERNING.includes(budgetVerdict)) {
        warn(data._meta && data._meta.summary ? data._meta.summary : `MCP tool set verdict: ${budgetVerdict}.`);
      } else {
        notice(`MCP tool set: ${toolCount} tools, verdict ${budgetVerdict}.`);
      }

      const servers = data.servers || [];
      if (servers.length) {
        summary.push('| Server | Tools | Tokens |');
        summary.push('|---|---|---|');
        for (const s of servers) {
          summary.push(`| ${s.server} | ${s.toolCount} | ${s.tokens} |`);
        }
        summary.push('');
      }

      const advice = data.reductionAdvice || [];
      if (advice.length) {
        summary.push('**Suggestions**');
        summary.push('');
        for (const a of advice) summary.push(`- ${a}`);
        summary.push('');
      }

      summary.push(
        '_Measured with [FreeToolHub MCP Economics]' +
          '(https://freetoolhub.org/mcp-context-budget-calculator) — the same tools are ' +
          'available to your agent over MCP at `https://freetoolhub.org/api/mcp`._',
      );
    } catch (e) {
      warn(`Could not estimate the context budget: ${e.message}`);
      summary.push(`**Context budget** — check failed: ${e.message}`);
    }
  }

  summary.push('');
  summary.push('---');
  summary.push('');
  summary.push(
    '<sub>MCP Lint by [FreeToolHub](https://freetoolhub.org). ' +
      'This action calls the public MCP endpoint; free tier is 50 calls/IP/day and no key is required.</sub>',
  );

  writeSummary(summary.join('\n'));

  if (invalidCard && cfg.failOnError) {
    fail('MCP server card is invalid. Fix the errors above, or set `fail-on-error: false`.');
    process.exitCode = 1;
  }
}

// 导出给测试用；只有在被直接执行时才跑 main()，
// 否则 require() 这个文件就会连带发起网络请求。
module.exports = { main, parseRpcBody, unwrap, findConfig, resolveExisting };

if (require.main === module) {
  main().catch((e) => {
    // 未预期异常：报错但不掩盖堆栈，方便排查
    fail(`MCP Lint crashed: ${e && e.message ? e.message : String(e)}`);
    if (e && e.stack) console.error(e.stack);
    process.exitCode = 1;
  });
}
