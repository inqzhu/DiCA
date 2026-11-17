/**
 * DiCA 前端版 · 核心数值工具（零依赖）
 * 提供：基本统计、KS 统计量、Wasserstein 距离、高斯核密度估计、
 *       Jacobi 特征分解、KMeans、可复现随机数。
 * 浏览器（全局 Core）与 Node.js（require）均可用。
 */
(function (global) {
  'use strict';

  // ---------------- 基本统计 ----------------

  function mean(arr) {
    if (!arr || arr.length === 0) return NaN;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function min(arr) {
    let m = Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
    return m;
  }

  function max(arr) {
    let m = -Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m;
  }

  function median(arr) {
    const n = arr.length;
    if (n === 0) return NaN;
    const s = Float64Array.from(arr).sort();
    const mid = n >> 1;
    return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // 样本标准差（ddof=1，与 numpy std 默认一致）
  function std(arr) {
    const n = arr.length;
    if (n < 2) return 0;
    const m = mean(arr);
    let s = 0;
    for (let i = 0; i < n; i++) { const d = arr[i] - m; s += d * d; }
    return Math.sqrt(s / (n - 1));
  }

  // 分位数（0-100），linear 插值，等价 numpy percentile
  function quantile(arr, p) {
    const n = arr.length;
    if (n === 0) return NaN;
    if (n === 1) return arr[0];
    const s = Float64Array.from(arr).sort();
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return s[lo];
    const w = idx - lo;
    return s[lo] * (1 - w) + s[hi] * w;
  }

  function sortedCopy(arr) {
    return Float64Array.from(arr).sort();
  }

  // ---------------- 可复现随机数 ----------------
  // mulberry32：确定性 PRNG，用于 k-means++ 等
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------- 距离 ----------------

  // 两样本 KS 统计量（scipy.stats.ks_2samp 的 D 统计量）
  function ksDistance(a, b) {
    const sa = Float64Array.from(a).sort();
    const sb = Float64Array.from(b).sort();
    const na = sa.length, nb = sb.length;
    if (na === 0 || nb === 0) return 1;
    let i = 0, j = 0, maxD = 0;
    while (i < na && j < nb) {
      if (sa[i] <= sb[j]) i++; else j++;
      const d = Math.abs(i / na - j / nb);
      if (d > maxD) maxD = d;
    }
    return maxD;
  }

  // 一维 Wasserstein 距离（W1），等权重两样本，等价 scipy.stats.wasserstein_distance
  function wassersteinDistance(u, v) {
    const nu = u.length, nv = v.length;
    if (nu === 0 || nv === 0) return 0;
    const all = [];
    for (let i = 0; i < nu; i++) all.push({ x: u[i], s: 0 });
    for (let j = 0; j < nv; j++) all.push({ x: v[j], s: 1 });
    all.sort((a, b) => a.x - b.x);
    let cu = 0, cv = 0, w = 0;
    for (let i = 0; i < all.length - 1; i++) {
      if (all[i].s === 0) cu++; else cv++;
      const dx = all[i + 1].x - all[i].x;
      if (dx > 0) w += Math.abs(cu / nu - cv / nv) * dx;
    }
    return w;
  }

  // ---------------- 高斯核密度估计 ----------------
  // 复现 scipy.stats.gaussian_kde（默认 Scott 带宽）
  function gaussianKDE(values, grid, sampleCap, seed) {
    let arr = Float64Array.from(values);
    arr = Float64Array.from(arr).filter(x => Number.isFinite(x));
    const n = arr.length;
    if (n < 3) return null;
    if (n > sampleCap) {
      // 确定性降采样（保持分布近似），与 Python 的 random_state=0 降采样语义一致
      const rng = mulberry32(seed || 0);
      const idx = new Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      }
      const sampled = new Float64Array(sampleCap);
      for (let i = 0; i < sampleCap; i++) sampled[i] = arr[idx[i]];
      arr = sampled;
    }
    const nn = arr.length;
    // Scott 带宽：h = std * n^(-1/5)（ddof=1）
    const h = std(arr) * Math.pow(nn, -0.2);
    if (!(h > 0)) return null;
    const out = new Float64Array(grid.length);
    const invSqrt2Pi = 1 / Math.sqrt(2 * Math.PI);
    const coeff = 1 / (nn * h);
    for (let g = 0; g < grid.length; g++) {
      const x = grid[g];
      let s = 0;
      for (let i = 0; i < nn; i++) {
        const z = (x - arr[i]) / h;
        s += Math.exp(-0.5 * z * z);
      }
      out[g] = coeff * invSqrt2Pi * s;
    }
    return Array.from(out);
  }

  // ---------------- Jacobi 特征分解（对称矩阵） ----------------
  // 循环 Jacobi：每个 sweep 遍历全部非对角元素做旋转，O(n^3) 收敛。
  // 返回 { eigenvalues, eigenvectors }，特征值升序排列，特征向量为列向量。
  function jacobiEigen(A, maxSweeps, tol) {
    maxSweeps = maxSweeps || 60;
    tol = tol || 1e-12;
    const n = A.length;
    const a = A.map(row => row.slice());
    const V = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      let maxOff = 0;
      for (let p = 0; p < n - 1; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = a[p][q];
          if (Math.abs(apq) < 1e-15) continue;
          if (Math.abs(apq) > maxOff) maxOff = Math.abs(apq);

          const app = a[p][p], aqq = a[q][q];
          const theta = (aqq - app) / (2 * apq);
          const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;

          for (let k = 0; k < n; k++) {
            if (k === p || k === q) continue;
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
            a[p][k] = a[k][p];
            a[q][k] = a[k][q];
          }
          a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
          a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
          a[p][q] = a[q][p] = 0;

          for (let k = 0; k < n; k++) {
            const vkp = V[k][p], vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq;
            V[k][q] = s * vkp + c * vkq;
          }
        }
      }
      if (maxOff < tol) break;
    }

    // 收集特征值（对角）与特征向量（V 的列）
    const eigen = [];
    for (let i = 0; i < n; i++) {
      const vec = new Array(n);
      for (let k = 0; k < n; k++) vec[k] = V[k][i];
      eigen.push({ value: a[i][i], vector: vec });
    }
    eigen.sort((x, y) => x.value - y.value); // 升序
    return {
      eigenvalues: eigen.map(e => e.value),
      eigenvectors: eigen.map(e => e.vector),
    };
  }

  // 求对称矩阵最大的 K 个特征值对应的特征向量（按特征值降序返回）
  function topEigenvectors(A, K) {
    const r = jacobiEigen(A);
    const n = r.eigenvalues.length;
    const out = [];
    for (let i = 0; i < K && i < n; i++) {
      out.push(r.eigenvectors[n - 1 - i]); // 从最大开始
    }
    return out;
  }

  // ---------------- KMeans ----------------
  function squaredDist(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return s;
  }

  function kmeansPPInit(data, K, rng) {
    const n = data.length, dim = data[0].length;
    const centers = [];
    const first = Math.floor(rng() * n);
    centers.push(data[first].slice());
    const minD2 = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < K; c++) {
      // 更新到最近中心的距离
      let total = 0;
      for (let i = 0; i < n; i++) {
        const d2 = squaredDist(data[i], centers[c - 1]);
        if (d2 < minD2[i]) minD2[i] = d2;
        total += minD2[i];
      }
      // 加权随机选下一个中心
      let r = rng() * total, idx = 0;
      for (let i = 0; i < n; i++) {
        r -= minD2[i];
        if (r <= 0) { idx = i; break; }
      }
      centers.push(data[idx].slice());
    }
    return centers;
  }

  // Lloyd 迭代 + k-means++ 初始化 + nInit 次重启取最小 inertia
  function kmeans(data, K, seed, nInit, maxIter) {
    seed = seed || 0;
    nInit = nInit || 10;
    maxIter = maxIter || 100;
    const n = data.length;
    const dim = data[0].length;
    if (K >= n) {
      const labels = new Array(n);
      for (let i = 0; i < n; i++) labels[i] = i;
      return labels;
    }
    let bestLabels = null, bestInertia = Infinity;
    for (let init = 0; init < nInit; init++) {
      const rng = mulberry32(seed + init);
      const centers = kmeansPPInit(data, K, rng);
      const labels = new Int32Array(n);
      let changed = true, iter = 0;
      while (changed && iter++ < maxIter) {
        changed = false;
        // 分配
        for (let i = 0; i < n; i++) {
          let best = 0, bd = Infinity;
          for (let c = 0; c < K; c++) {
            const d = squaredDist(data[i], centers[c]);
            if (d < bd) { bd = d; best = c; }
          }
          if (labels[i] !== best) { labels[i] = best; changed = true; }
        }
        // 更新中心
        const sums = Array.from({ length: K }, () => new Float64Array(dim));
        const counts = new Int32Array(K);
        for (let i = 0; i < n; i++) {
          const c = labels[i]; counts[c]++;
          for (let d = 0; d < dim; d++) sums[c][d] += data[i][d];
        }
        for (let c = 0; c < K; c++) {
          if (counts[c] === 0) continue;
          for (let d = 0; d < dim; d++) centers[c][d] = sums[c][d] / counts[c];
        }
      }
      // inertia
      let inertia = 0;
      for (let i = 0; i < n; i++) inertia += squaredDist(data[i], centers[labels[i]]);
      if (inertia < bestInertia) {
        bestInertia = inertia;
        bestLabels = Array.from(labels);
      }
    }
    return bestLabels;
  }

  // ---------------- 导出 ----------------
  const Core = {
    mean, median, std, min, max, quantile, sortedCopy,
    mulberry32, ksDistance, wassersteinDistance, gaussianKDE,
    jacobiEigen, topEigenvectors, kmeans, squaredDist,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else global.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
