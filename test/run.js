#!/usr/bin/env node
'use strict';

/**
 * MCP Lint — 端到端自测
 *
 * 真的 spawn `src/index.js`，真的打线上 MCP 端点，真的读回 GITHUB_OUTPUT /
 * GITHUB_STEP_SUMMARY。不走 mock —— 这个 action 的全部价值就是「和真实端点对得上」，
 * mock 掉端点等于什么都没测。
 *
 * 覆盖四种情况：
 *   1. 合法卡片 + 合法配置 → 通过，outputs 正确
 *   2. 非法卡片            → 失败（exit 1）+ 注解
 *   3. 非法卡片 + fail-on-error=false → 只报不失败
 *   4. 没有卡片、没有配置   → 跳过而不是报错
 *
 * 用法：node test/run.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const API = process.env.MCP_LINT_TEST_API || 'https://freetoolhub.org/api/mcp';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

const VALID_CARD = {
  serverInfo: {
    name: 'example-server',
    description: 'An example MCP server used by the MCP Lint test suite.',
    version: '1.0.0',
  },
  transport: { type: 'streamable-http', url: 'https://example.com/api/mcp' },
  capabilities: {
    tools: [{ name: 'do_thing', description: 'Does the thing.' }],
    resources: false,
    prompts: false,
  },
  authentication: { required: false },
  protocolVersion: '2024-11-05',
};

const VALID_CONFIG = {
  mcpServers: {
    example: { url: 'https://example.com/api/mcp' },
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      tools: Array.from({ length: 30 }, (_, i) => ({
        name: `github_op_${i}`,
        description: 'A GitHub operation with a deliberately long description to move the token needle.',
      })),
    },
  },
};

function makeFixture(withCard, withConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lint-'));
  if (withCard) {
    const p = path.join(dir, '.well-known', 'mcp');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(
      path.join(p, 'server-card.json'),
      typeof withCard === 'string' ? withCard : JSON.stringify(withCard, null, 2),
    );
  }
  if (withConfig) {
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(withConfig, null, 2));
  }
  return dir;
}

function run(cwd, inputs = {}) {
  const outFile = path.join(cwd, '__gh_output');
  const sumFile = path.join(cwd, '__gh_summary');
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(sumFile, '');

  const env = { ...process.env, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile };
  for (const [k, v] of Object.entries(inputs)) {
    env[`INPUT_${k.toUpperCase()}`] = String(v);
  }
  env['INPUT_API-URL'] = API;

  const res = spawnSync(process.execPath, [ENTRY], { cwd, env, encoding: 'utf8' });

  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    outputs: fs.readFileSync(outFile, 'utf8'),
    summary: fs.readFileSync(sumFile, 'utf8'),
  };
}

function outputValue(outputs, name) {
  const line = outputs.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return line === undefined ? undefined : line.slice(name.length + 1);
}

(async () => {
  console.log(`\nMCP Lint e2e — endpoint: ${API}\n`);

  // ── 1. 全绿 ──
  console.log('1. valid card + valid config');
  {
    const dir = makeFixture(VALID_CARD, VALID_CONFIG);
    const r = run(dir);
    ok('exit 0', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);
    ok('card-valid=true', outputValue(r.outputs, 'card-valid') === 'true', r.outputs.trim());
    ok('tool-count 已输出', /^\d+$/.test(outputValue(r.outputs, 'tool-count') || ''), r.outputs.trim());
    ok('summary 含 Server card', /Server card/.test(r.summary));
    ok('summary 含 Context budget', /Context budget/.test(r.summary));
    ok('summary 未报错', !/INVALID/.test(r.summary));
    ok('heavy 配置产生 warning 注解', /::warning/.test(r.stdout), r.stdout.slice(0, 300));
    console.log(`     tool-count=${outputValue(r.outputs, 'tool-count')} verdict=${outputValue(r.outputs, 'budget-verdict')}`);
  }

  // ── 2. 非法卡片 → 失败 ──
  console.log('\n2. invalid card → fail');
  {
    const dir = makeFixture(
      { serverInfo: { name: 'x', description: 'y', version: 'not-semver' }, transport: { type: 'sse' } },
      null,
    );
    const r = run(dir);
    ok('exit 1', r.code === 1, `code=${r.code}`);
    ok('card-valid=false', outputValue(r.outputs, 'card-valid') === 'false');
    ok('stdout 有 error 注解', /::error/.test(r.stdout), r.stdout.slice(0, 300));
    ok('summary 标 INVALID', /INVALID/.test(r.summary));
  }

  // ── 3. 非法卡片但 fail-on-error=false → 不失败 ──
  console.log('\n3. invalid card + fail-on-error=false → annotate only');
  {
    const dir = makeFixture({ serverInfo: { name: 'x' } }, null);
    const r = run(dir, { 'fail-on-error': 'false' });
    ok('exit 0', r.code === 0, `code=${r.code}`);
    ok('card-valid=false', outputValue(r.outputs, 'card-valid') === 'false');
    ok('仍有 error 注解', /::error/.test(r.stdout));
  }

  // ── 4. 空仓库 → 跳过而非失败 ──
  console.log('\n4. no card, no config → skip cleanly');
  {
    const dir = makeFixture(null, null);
    const r = run(dir);
    ok('exit 0', r.code === 0, `code=${r.code}`);
    ok('card-valid 未设置', outputValue(r.outputs, 'card-valid') === undefined);
    ok('有 notice', /::notice/.test(r.stdout));
    ok('没有 error', !/::error/.test(r.stdout));
  }

  console.log(`\n================================`);
  console.log(`  pass ${pass} / fail ${fail}`);
  console.log(`================================\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
