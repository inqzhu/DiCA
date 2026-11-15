/**
 * DiCA 前端版 · 可视化数据（ECDF / 直方图 / 密度）
 * 复现 viz_utils.py 的计算逻辑。
 */
(function (global) {
  'use strict';
  const Core = (typeof module !== 'undefined' && module.exports)
    ? require('./core.js')
    : global.Core;

  function computeECDF(values, maxPoints) {
    maxPoints = maxPoints || 1000;
    const arr = Float64Array.from(values).sort();
    const n = arr.length;
    if (n === 0) return { x: [], y: [] };
    const xs = [], ys = [];
    if (n > maxPoints) {
      for (let k = 0; k < maxPoints; k++) {
        const idx = Math.round(k * (n - 1) / (maxPoints - 1));
        xs.push(arr[idx]);
        ys.push((idx + 1) / n);
      }
    } else {
      for (let i = 0; i < n; i++) { xs.push(arr[i]); ys.push((i + 1) / n); }
    }
    return { x: xs, y: ys };
  }

  function computeHistogram(values, bins, lo, hi) {
    const arr = Float64Array.from(values).filter(x => Number.isFinite(x));
    const n = arr.length;
    if (n === 0) return { x: [], y: [] };
    const width = (hi - lo) / bins;
    const counts = new Float64Array(bins);
    for (let i = 0; i < n; i++) {
      let b = Math.floor((arr[i] - lo) / width);
      if (b < 0) b = 0;
      if (b >= bins) b = bins - 1;
      counts[b]++;
    }
    const xs = [], ys = [];
    for (let b = 0; b < bins; b++) {
      xs.push(lo + (b + 0.5) * width);
      ys.push(counts[b] / (n * width)); // 频率密度
    }
    return { x: xs, y: ys };
  }

  function computeDensity(values, grid, sampleCap) {
    sampleCap = sampleCap || 4000;
    return Core.gaussianKDE(values, grid, sampleCap, 0);
  }

  // 与 viz_utils.build_cluster_summary 对齐
  function buildClusterSummary(mids, labels, transDic, K, elapsed, onSeed) {
    // 按簇聚合观测值
    const clusterValues = [];
    const clusterMids = [];
    for (let k = 0; k < K; k++) { clusterValues.push([]); clusterMids.push([]); }
    for (let i = 0; i < mids.length; i++) {
      const k = labels[i];
      const vals = transDic[mids[i]];
      for (let x = 0; x < vals.length; x++) clusterValues[k].push(vals[x]);
      clusterMids[k].push(mids[i]);
    }
    // 全量值（用于统一范围）
    const allv = [];
    for (let k = 0; k < K; k++) for (let x = 0; x < clusterValues[k].length; x++) {
      const v = clusterValues[k][x];
      if (Number.isFinite(v)) allv.push(v);
    }
    let lo = Core.quantile(allv, 0.5);
    let hi = Core.quantile(allv, 99.5);
    if (!(hi > lo)) { lo = Core.min(allv); hi = Core.max(allv); }
    const histBins = 40;
    const grid = [];
    for (let g = 0; g < 240; g++) grid.push(lo + (hi - lo) * g / 239);

    const clusters = [];
    for (let k = 0; k < K; k++) {
      const values = clusterValues[k];
      const ecdf = computeECDF(values);
      const hist = computeHistogram(values, histBins, lo, hi);
      const density = computeDensity(values, grid);
      clusters.push({
        cluster: k,
        n_objects: clusterMids[k].length,
        n_records: values.length,
        mean: values.length ? Core.mean(values) : null,
        median: values.length ? Core.median(values) : null,
        min: values.length ? Core.min(values) : null,
        max: values.length ? Core.max(values) : null,
        ecdf_x: ecdf.x, ecdf_y: ecdf.y,
        hist_x: hist.x, hist_y: hist.y,
        density_x: grid, density_y: density,
      });
    }
    return {
      K: K,
      n_objects: mids.length,
      n_records_total: allv.length,
      elapsed_seconds: Math.round(elapsed * 1000) / 1000,
      x_range: [lo, hi],
      clusters: clusters,
    };
  }

  const Viz = { computeECDF, computeHistogram, computeDensity, buildClusterSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = Viz;
  else global.Viz = Viz;
})(typeof window !== 'undefined' ? window : globalThis);
