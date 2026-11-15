/**
 * 前端算法验证脚本：用 test_data.csv 跑 JS 版 WSC / KSKC，
 * 复现 Python test_wsc.py 的 NMI/ARI/ACC 评估，与 Python 结果对比。
 * 运行：node test_frontend.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Core = require('./js/core.js');
const WSC = require('./js/wsc.js');
const KSKC = require('./js/kskc.js');

// ---------- CSV 读取 ----------
function readCSV(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  const lines = text.split('\n').filter(l => l.trim());
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    rows.push({ [header[0]]: parts[0], [header[1]]: parts[1] });
  }
  return rows;
}

function buildTransDic(rows, objCol, recCol) {
  const mids = [], seen = new Set(), transDic = {};
  for (const r of rows) {
    const id = r[objCol];
    if (!seen.has(id)) { seen.add(id); mids.push(id); transDic[id] = []; }
    transDic[id].push(parseFloat(r[recCol]));
  }
  return { mids, transDic };
}

// ---------- 指标（复现 Python evaluate） ----------
function cn2(x) { return x * (x - 1) / 2; }

function evaluate(K, pred, trueLabels) {
  // trueLabels: 原始字符串标签，映射到 0..K-1
  const uniq = [...new Set(trueLabels)];
  const label2num = {};
  uniq.forEach((l, i) => label2num[l] = i);
  const n = trueLabels.length;
  const ct = [];
  for (let i = 0; i < K; i++) ct.push(new Array(K).fill(0));
  for (let i = 0; i < n; i++) {
    const t = label2num[trueLabels[i]];
    const p = pred[i];
    ct[t][p]++;
  }
  let MI = 0, hS = 0, hReal = 0;
  for (let k1 = 0; k1 < K; k1++) {
    for (let k2 = 0; k2 < K; k2++) {
      const pInfo = ct[k1][k2] / n;
      const pReal = ct[k1].reduce((a, b) => a + b, 0) / n;
      const pS = ct.reduce((a, row) => a + row[k2], 0) / n;
      if (pInfo !== 0) MI += pInfo * Math.log(pInfo / pS / pReal);
    }
  }
  for (let k = 0; k < K; k++) {
    const pS = ct.reduce((a, row) => a + row[k], 0) / n;
    const pReal = ct[k].reduce((a, b) => a + b, 0) / n;
    if (pS !== 0) hS -= pS * Math.log(pS);
    if (pReal !== 0) hReal -= pReal * Math.log(pReal);
  }
  const NMI = MI / Math.sqrt(hS * hReal);
  const sa2 = ct.reduce((a, row) => a + cn2(row.reduce((x, y) => x + y, 0)), 0);
  const sb2 = Array.from({ length: K }, (_, k) => ct.reduce((a, row) => a + row[k], 0))
    .reduce((a, b) => a + cn2(b), 0);
  const sab2 = ct.reduce((a, row) => a + row.reduce((x, y) => x + cn2(y), 0), 0);
  const ARI = (sab2 - sa2 * sb2 / cn2(n)) / (0.5 * (sa2 + sb2) - sa2 * sb2 / cn2(n));
  // ACC：全排列对齐
  const perms = permutations([...Array(K).keys()]);
  let bestAcc = 0;
  for (const perm of perms) {
    let acc = 0;
    for (let k = 0; k < K; k++) acc += ct[k][perm[k]];
    bestAcc = Math.max(bestAcc, acc);
  }
  const ACC = bestAcc / n;
  return { NMI, ARI, ACC };
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

// ---------- 主流程 ----------
const base = path.join(__dirname, 'data');
const dataRows = readCSV(path.join(base, 'test_data.csv'));
const labelRows = readCSV(path.join(base, 'test_data_label.csv'));
const { mids, transDic } = buildTransDic(dataRows, 'Merchant_id', 'Transaction');

// 真值标签（按 mids 顺序对齐）
const trueByMid = {};
for (const r of labelRows) trueByMid[r['Merchant_id']] = r['label'];
const trueLabels = mids.map(m => trueByMid[m]);

console.log('='.repeat(70));
console.log('JS 前端算法验证（test_data.csv，' + mids.length + ' 对象 / ' + dataRows.length + ' 记录）');
console.log('='.repeat(70));

// ---- WSC ----
console.log('\n【WSC】默认参数 knn, k0=10, sigma=median');
let t0 = Date.now();
let pred = WSC.runWSC(transDic, mids, { K: 3, sparsify: 'knn', k0: 10, randomState: 0 });
let el = (Date.now() - t0) / 1000;
let m = evaluate(3, pred, trueLabels);
console.log('  NMI=' + m.NMI.toFixed(4) + '  ARI=' + m.ARI.toFixed(4) + '  ACC=' + m.ACC.toFixed(4) + '  耗时=' + el.toFixed(2) + 's');
const wscSizes = [0, 0, 0];
pred.forEach(p => wscSizes[p]++);
console.log('  簇规模: ' + wscSizes.join(' / '));

// ---- KSKC ----
console.log('\n【KSKC】K=3, fast=true, sample=1000, niter=30');
t0 = Date.now();
pred = KSKC.runKSKC(transDic, mids, { K: 3, isFast: true, sampleNum: 1000, niter: 30, isCorrected: false, randomSeed: 0 });
el = (Date.now() - t0) / 1000;
m = evaluate(3, pred, trueLabels);
console.log('  NMI=' + m.NMI.toFixed(4) + '  ARI=' + m.ARI.toFixed(4) + '  ACC=' + m.ACC.toFixed(4) + '  耗时=' + el.toFixed(2) + 's');
const kskcSizes = [0, 0, 0];
pred.forEach(p => kskcSizes[p]++);
console.log('  簇规模: ' + kskcSizes.join(' / '));

console.log('\n完成。');
