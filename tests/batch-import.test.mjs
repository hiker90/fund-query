import { parseBatchText } from '../js/strategy.js';

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}${detail ? `：${detail}` : ''}`);
  }
}

// 1. 基本三列解析
{
  const r = parseBatchText('110022,10500,5.2\n161725,8200,-3.1');
  assert('三列基本解析', r.rows.length === 2 && r.errors.length === 0);
  assert('收益率支持负数', r.rows[1].returnPct === -3.1);
}

// 2. 收益率省略按 0
{
  const r = parseBatchText('005827,12000');
  assert('收益率省略按 0', r.rows.length === 1 && r.rows[0].returnPct === 0);
}

// 3. 表头自动跳过
{
  const r = parseBatchText('代码,持仓金额,收益率\n110022,10500,5.2');
  assert('表头行自动跳过', r.rows.length === 1 && r.rows[0].code === '110022');
}

// 4. 中文逗号 / Tab 分隔
{
  const r = parseBatchText('110022，10500，5.2\n161725\t8200\t-3.1');
  assert('中文逗号与 Tab 分隔', r.rows.length === 2 && r.rows[1].code === '161725');
}

// 5. 注释与空行
{
  const r = parseBatchText('# 注释\n\n110022,10500,5.2\n// 说明');
  assert('注释与空行跳过', r.rows.length === 1 && r.errors.length === 0);
}

// 6. 错误行不阻断
{
  const r = parseBatchText('11002,10500\n110022,10500,5.2\n161725,0,1');
  assert('错误行不阻断', r.rows.length === 1 && r.errors.length === 2);
  assert('代码错误提示', r.errors[0].reason.includes('6 位'));
  assert('金额必须大于 0', r.errors[1].reason.includes('大于 0'));
}

// 7. 同代码去重保留最后
{
  const r = parseBatchText('110022,100,1\n110022,200,2');
  assert('同代码去重保留最后', r.rows.length === 1 && r.rows[0].amount === 200);
}

// 8. 空文本
{
  const r = parseBatchText('');
  assert('空文本返回空', r.rows.length === 0 && r.errors.length === 0);
}

console.log(`\n${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
