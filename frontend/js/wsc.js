/**
 * DiCA 前端版 · WSC 算法（Wasserstein-distance-based Spectral Clustering）
 * 步骤：两两 Wasserstein 距离 → exp(-W/σ) 相似度 → 稀疏化（none/knn/lof）→ 谱聚类。
 * 依赖 Core（core.js）。
 */
(function (global) {
  'use strict';
  const Core = (typeof module !== 'undefined' && module.exports)
    ? require('./core.js')
    : global.Core;

  // 输入：transDic {对象ID: number[]}，mids 对象ID列表，opts 超参数
  function runWSC(transDic, mids, opts) {
    opts = opts || {};
    const K = opts.K || 3;
    const sigma = (opts.sigma == null || opts.sigma === '') ? null : parseFloat(opts.sigma);
    const sparsify = opts.sparsify || 'knn';
    const k0 = opts.k0 || 10;
    const lofNeighbors = opts.lofNeighbors || 20;
    const lofContamination = opts.lofContamination || 'auto';
    const randomState = opts.randomState == null ? 0 : opts.randomState;

    const n = mids.length;
    const log = opts.onLog || function () {};

    log('==> start!  WSC clustering');
    log('--> number of objects:  ' + n);

    // 1. Wasserstein 距离矩阵
    log('--> computing Wasserstein distance matrix ...');
    let t0 = Date.now();
    const W = [];
    for (let i = 0; i < n; i++) W.push(new Float64Array(n));
    const vals = mids.map(m => transDic[m]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Core.wassersteinDistance(vals[i], vals[j]);
        W[i][j] = d;
        W[j][i] = d;
      }
    }
    log('--> Wasserstein distance matrix done  (' + ((Date.now() - t0) / 1000).toFixed(2) + 's)');

    // 2. 相似度
    log('--> constructing similarity matrix ...');
    let sigmaVal = sigma;
    if (sigmaVal == null) {
      const triu = [];
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (W[i][j] > 0) triu.push(W[i][j]);
      sigmaVal = triu.length ? Core.median(triu) : 1.0;
    }
    if (!(sigmaVal > 0)) sigmaVal = 1e-6;
    const S = [];
    for (let i = 0; i < n; i++) {
      const row = new Float64Array(n);
      for (let j = 0; j < n; j++) row[j] = Math.exp(-W[i][j] / sigmaVal);
      row[i] = 0;
      S.push(row);
    }
    log('--> similarity matrix done  (sigma=' + sigmaVal.toFixed(6) + ')');

    // 3. 稀疏化
    log('--> sparsifying similarity matrix (' + sparsify + ' mode) ...');
    let Sfinal = S;
    if (sparsify === 'knn') {
      Sfinal = sparsifyKNN(S, W, k0, n);
    } else if (sparsify === 'lof') {
      Sfinal = sparsifyLOF(S, W, k0, lofNeighbors, lofContamination, n);
    }
    // none 模式直接使用完整相似度
    log('--> similarity matrix sparsified');

    // 4. 谱聚类
    log('--> applying spectral clustering (K=' + K + ') ...');
    const labels = spectralClustering(Sfinal, K, randomState);
    log('# total running time:  ' + ((Date.now() - t0) / 1000).toFixed(2) + 's');

    return labels;
  }

  // KNN 稀疏化：每个对象保留距离最近的 k0 个邻居，对称化
  function sparsifyKNN(S, W, k0, n) {
    const Snew = Array.from({ length: n }, () => new Float64Array(n));
    const k = Math.min(k0, n - 1);
    for (let i = 0; i < n; i++) {
      const order = Array.from(W[i]);
      const idx = order.map((v, j) => j).sort((a, b) => order[a] - order[b]);
      for (let t = 1; t <= k; t++) {
        const j = idx[t];
        Snew[i][j] = S[i][j];
      }
    }
    // 对称化
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (Snew[i][j] < Snew[j][i]) Snew[i][j] = Snew[j][i];
    }
    for (let i = 0; i < n; i++) Snew[i][i] = 0;
    return Snew;
  }

  // LOF 稀疏化：离群对象施加更强剪枝
  function sparsifyLOF(S, W, k0, lofNeighbors, lofContamination, n) {
    const outlier = computeLOFOutliers(W, lofNeighbors, lofContamination, n);
    const Snew = Array.from({ length: n }, () => new Float64Array(n));
    const topK = Math.min(k0, n - 1);
    for (let i = 0; i < n; i++) {
      const sims = Array.from(S[i]);
      sims[i] = -Infinity;
      const finite = sims.filter(x => x > -Infinity);
      const baseQ = finite.length ? Core.quantile(finite, 50) : 0;
      const q = outlier[i] ? (finite.length ? Core.quantile(finite, 75) : 0) : baseQ;
      // top-k0 强边
      const order = Array.from(sims);
      const idx = order.map((v, j) => j).sort((a, b) => order[b] - order[a]);
      const keep = new Array(n).fill(false);
      for (let t = 0; t < topK; t++) keep[idx[t]] = true;
      for (let j = 0; j < n; j++) if (sims[j] >= q) keep[j] = true;
      for (let j = 0; j < n; j++) if (keep[j]) Snew[i][j] = S[i][j];
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (Snew[i][j] < Snew[j][i]) Snew[i][j] = Snew[j][i];
    }
    for (let i = 0; i < n; i++) Snew[i][i] = 0;
    return Snew;
  }

  // Local Outlier Factor（简化实现，与 sklearn 语义一致）
  function computeLOFOutliers(W, lofNeighbors, contamination, n) {
    const k = Math.max(1, Math.min(lofNeighbors, n - 1));
    const lofScores = new Float64Array(n);
    // 每个对象的特征向量 = W 的一行（与其他对象的距离）
    for (let i = 0; i < n; i++) {
      const order = Array.from(W[i]);
      const idx = order.map((v, j) => j).sort((a, b) => order[a] - order[b]);
      // k-distance = 第 k 近邻距离（idx[0] 是自身距离 0，跳过）
      const kdist = order[idx[k]];
      // reachability distance 邻居
      const neighbors = idx.slice(1, k + 1);
      let sumReach = 0;
      for (const nb of neighbors) {
        const nbKdist = kDistanceOf(W, nb, k);
        sumReach += Math.max(kdist, nbKdist);
      }
      const lrd = neighbors.length / sumReach; // 局部可达密度
      // 邻居的平均 lrd
      let sumLrd = 0;
      for (const nb of neighbors) {
        sumLrd += lrdOf(W, nb, k);
      }
      lofScores[i] = (sumLrd / neighbors.length) / lrd;
    }
    // contamination -> 阈值
    let nOutliers;
    if (contamination === 'auto') {
      nOutliers = 0;
      for (let i = 0; i < n; i++) if (lofScores[i] > 1.5) nOutliers++;
    } else {
      nOutliers = Math.floor(n * parseFloat(contamination));
    }
    // 取 LOF 最大的 nOutliers 个为离群
    const order = Array.from(lofScores);
    const idx = order.map((v, j) => j).sort((a, b) => order[b] - order[a]);
    const outlier = new Array(n).fill(false);
    for (let t = 0; t < nOutliers; t++) outlier[idx[t]] = true;
    return outlier;
  }

  function kDistanceOf(W, i, k) {
    const order = Array.from(W[i]);
    const idx = order.map((v, j) => j).sort((a, b) => order[a] - order[b]);
    return order[idx[Math.min(k, idx.length - 1)]];
  }

  function lrdOf(W, i, k) {
    const order = Array.from(W[i]);
    const idx = order.map((v, j) => j).sort((a, b) => order[a] - order[b]);
    const kdist = order[idx[Math.min(k, idx.length - 1)]];
    const neighbors = idx.slice(1, Math.min(k + 1, idx.length));
    let sumReach = 0;
    for (const nb of neighbors) {
      sumReach += Math.max(kdist, kDistanceOf(W, nb, k));
    }
    return neighbors.length / sumReach;
  }

  // 谱聚类（Ng-Jordan-Weiss 对称归一化）
  function spectralClustering(S, K, randomState) {
    const n = S.length;
    const k = Math.min(K, n);
    // 度
    const deg = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += S[i][j];
      deg[i] = s;
    }
    // M = D^{-1/2} S D^{-1/2}
    const M = [];
    for (let i = 0; i < n; i++) {
      const row = new Float64Array(n);
      const di = deg[i] > 0 ? 1 / Math.sqrt(deg[i]) : 0;
      for (let j = 0; j < n; j++) {
        const dj = deg[j] > 0 ? 1 / Math.sqrt(deg[j]) : 0;
        row[j] = di * S[i][j] * dj;
      }
      M.push(row);
    }
    // 最大 k 个特征向量
    const vecs = Core.topEigenvectors(M, k);
    // 组成 X（n×k），每行 L2 归一化
    const X = [];
    for (let i = 0; i < n; i++) {
      const row = new Array(k);
      let norm = 0;
      for (let c = 0; c < k; c++) { row[c] = vecs[c][i]; norm += row[c] * row[c]; }
      norm = Math.sqrt(norm);
      if (norm > 1e-12) { for (let c = 0; c < k; c++) row[c] /= norm; }
      X.push(row);
    }
    // KMeans
    return Core.kmeans(X, k, randomState, 10);
  }

  const WSC = { runWSC, spectralClustering };
  if (typeof module !== 'undefined' && module.exports) module.exports = WSC;
  else global.WSC = WSC;
})(typeof window !== 'undefined' ? window : globalThis);
