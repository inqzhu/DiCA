/**
 * DiCA 前端版 · KSKC 算法（Kolmogorov-Smirnov K-means）
 * 步骤：初始簇中心选择（最远距离）→ 迭代（E-step 簇分布 / M-step KS 统计量分配）。
 * 复现 ks_multi.py，多进程改为单线程，预排序优化 KS 统计量。
 */
(function (global) {
  'use strict';
  const Core = (typeof module !== 'undefined' && module.exports)
    ? require('./core.js')
    : global.Core;

  // 已排序两样本的 KS 统计量（可选度数校正）
  function ksDistanceSorted(sa, sb, isCorrected) {
    const na = sa.length, nb = sb.length;
    if (na === 0 || nb === 0) return 1;
    let i = 0, j = 0, maxD = 0;
    while (i < na && j < nb) {
      if (sa[i] <= sb[j]) i++; else j++;
      const d = Math.abs(i / na - j / nb);
      if (d > maxD) maxD = d;
    }
    if (isCorrected) return Math.sqrt(na * nb / (na + nb)) * maxD;
    return maxD;
  }

  // 降采样（复现 e_procedure 的 fast 逻辑）
  function subsample(arr, sampleNum) {
    const block = Math.floor(arr.length / sampleNum);
    const out = [];
    for (let j = 0; j < arr.length; j++) if (j % block === 0) out.push(arr[j]);
    return Float64Array.from(out);
  }

  // 判断两个簇划分是否完全相同（收敛）
  function samePartition(a, b) {
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) {
      if (a[k].length !== b[k].length) return false;
      for (let i = 0; i < a[k].length; i++) if (a[k][i] !== b[k][i]) return false;
    }
    return true;
  }

  // 输入：transDic {对象ID: number[]}，mids 对象ID列表，opts
  function runKSKC(transDic, mids, opts) {
    opts = opts || {};
    const K = opts.K || 3;
    const niter = opts.niter || 30;
    const isFast = opts.isFast !== false;
    const sampleNum = opts.sampleNum || 1000;
    const isCorrected = !!opts.isCorrected;
    const log = opts.onLog || function () {};

    const n = mids.length;
    log('==> start!  KSKC clustering');
    log('--> number of objects:  ' + n);

    // 预排序每个对象的观测值
    const sortedVals = new Array(n);
    for (let i = 0; i < n; i++) sortedVals[i] = Float64Array.from(transDic[mids[i]]).sort();

    // 初始簇中心：随机选 1 个，其余用最大最小 KS 统计量
    const rng = Core.mulberry32(opts.randomSeed || 0);
    let cSamples = [];
    for (let k = 0; k < K; k++) cSamples.push([]);
    const firstIdx = Math.floor(rng() * n);
    cSamples[0].push(mids[firstIdx]);

    let t0 = Date.now();
    for (let i = 1; i < K; i++) {
      let maxDis = -1, next = -1;
      for (let j = 0; j < n; j++) {
        let minDis = -1;
        for (let z = 0; z < i; z++) {
          const zi = mids.indexOf(cSamples[z][0]);
          const d = ksDistanceSorted(sortedVals[j], sortedVals[zi], isCorrected);
          if (d < minDis || minDis < 0) minDis = d;
        }
        if (minDis > maxDis) { maxDis = minDis; next = j; }
      }
      cSamples[i].push(mids[next]);
    }
    log('--> initial cluster center selection done  (' + ((Date.now() - t0) / 1000).toFixed(2) + 's)');

    // 迭代
    const iterT0 = Date.now();
    for (let t = 0; t < niter; t++) {
      const it0 = Date.now();
      // E-step：簇中心分布（簇内所有记录合并，可选降采样）
      const c = new Array(K);
      for (let k = 0; k < K; k++) {
        let totalLen = 0;
        for (let x = 0; x < cSamples[k].length; x++) totalLen += transDic[cSamples[k][x]].length;
        const merged = new Float64Array(totalLen);
        let p = 0;
        for (let x = 0; x < cSamples[k].length; x++) {
          const arr = transDic[cSamples[k][x]];
          for (let y = 0; y < arr.length; y++) merged[p++] = arr[y];
        }
        merged.sort();
        c[k] = (isFast && merged.length > sampleNum) ? subsample(merged, sampleNum) : merged;
      }
      // M-step：分配
      const newSamples = [];
      for (let k = 0; k < K; k++) newSamples.push([]);
      for (let i = 0; i < n; i++) {
        let minDis = -1, opt = -1;
        for (let j = 0; j < K; j++) {
          const d = ksDistanceSorted(sortedVals[i], c[j], isCorrected);
          if (d < minDis || minDis < 0) { minDis = d; opt = j; }
        }
        newSamples[opt].push(mids[i]);
      }
      log('-- iteration ' + t + ':  ' + newSamples.map(s => s.length).join(' / '));
      if (samePartition(cSamples, newSamples)) {
        cSamples = newSamples;
        log('-- converged at iteration ' + t);
        break;
      }
      cSamples = newSamples;
      log('# time of iteration:  ' + ((Date.now() - it0) / 1000).toFixed(2) + 's');
    }
    log('# total running time:  ' + ((Date.now() - iterT0) / 1000).toFixed(2) + 's');

    // 输出 labels（与 mids 对齐）
    const labels = new Array(n).fill(-1);
    for (let k = 0; k < K; k++) {
      for (let x = 0; x < cSamples[k].length; x++) {
        const idx = mids.indexOf(cSamples[k][x]);
        labels[idx] = k;
      }
    }
    return labels;
  }

  const KSKC = { runKSKC, ksDistanceSorted };
  if (typeof module !== 'undefined' && module.exports) module.exports = KSKC;
  else global.KSKC = KSKC;
})(typeof window !== 'undefined' ? window : globalThis);
