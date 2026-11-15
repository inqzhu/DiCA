# -*- coding: utf-8 -*-
"""
WSC：基于 Wasserstein 距离的谱聚类（Wasserstein-distance-based Spectral Clustering）

算法步骤：
  1. 对 n 个对象（各有若干重复观测值），计算两两之间的 Wasserstein 距离 W(i,j)（一维 W1，
     即两个经验累积分布函数 ECDF 之间的 L1 面积）。
  2. 用高斯核把距离映射为相似度：S(i,j) = exp(-W(i,j) / sigma)，sigma 为调节超参数。
  3. 对相似度矩阵做稀疏化（修剪弱边），支持三种模式：
       - 'none'：不稀疏化，使用完整相似度矩阵；
       - 'knn' ：论文 Remark 3 的 K 近邻构造，保留每个对象的 k0 个最近邻边，其余置 0；
       - 'lof' ：用局部离群因子（Local Outlier Factor）识别相似度画像异常的对象，
                 对离群对象施加更强的弱边剪枝，使矩阵更稀疏。
  4. 对（稀疏化后的）相似度矩阵做谱聚类，得到簇标签。

参考文献：
  Yingqiu Zhu, Danyang Huang, Bo Zhang. A Wasserstein distance-based spectral clustering
  method for transaction data analysis. Expert Systems With Applications, 2025.
"""
import numpy as np
from scipy.stats import wasserstein_distance
from sklearn.cluster import SpectralClustering


class WSC(object):
    """基于 Wasserstein 距离的谱聚类。"""

    def __init__(self, K=3, sigma=None, sparsify='knn', k0=10,
                 lof_neighbors=20, lof_contamination='auto', random_state=0):
        """
        参数
        ----
        K : int
            簇数。
        sigma : float 或 None
            高斯核带宽超参数。None 时默认为所有两两 Wasserstein 距离的中位数。
        sparsify : {'none', 'knn', 'lof'}
            相似度矩阵稀疏化方式。
        k0 : int
            knn 模式下每个对象保留的最近邻个数（不含自身）。
        lof_neighbors : int
            lof 模式下 LOF 的近邻数。
        lof_contamination : float 或 'auto'
            lof 模式下预期离群对象比例。
        random_state : int
            随机种子（谱聚类中的 KMeans）。
        """
        self.K = int(K)
        self.sigma = sigma
        self.sparsify = sparsify
        self.k0 = int(k0)
        self.lof_neighbors = int(lof_neighbors)
        self.lof_contamination = lof_contamination
        self.random_state = random_state

        self.W_ = None   # Wasserstein 距离矩阵
        self.S_ = None   # 相似度矩阵（稀疏化后）
        self.labels_ = None

    # ---------- 距离与相似度 ----------
    def compute_wasserstein(self, trans_dic, mids):
        """计算两两 Wasserstein 距离矩阵（一维 W1 = ECDF 之间的 L1 面积）。"""
        n = len(mids)
        W = np.zeros((n, n))
        for i in range(n):
            a = np.asarray(trans_dic[mids[i]], dtype=float)
            for j in range(i + 1, n):
                b = np.asarray(trans_dic[mids[j]], dtype=float)
                d = wasserstein_distance(a, b)
                W[i, j] = d
                W[j, i] = d
        return W

    def compute_similarity(self, W):
        """Wasserstein 距离 -> 高斯核相似度 S = exp(-W/sigma)。"""
        if self.sigma is None:
            # 取上三角非零距离的中位数作为默认带宽
            triu = W[np.triu_indices(W.shape[0], k=1)]
            sigma = np.median(triu[triu > 0]) if np.any(triu > 0) else 1.0
        else:
            sigma = self.sigma
        if sigma <= 0:
            sigma = 1e-6
        S = np.exp(-W / sigma)
        np.fill_diagonal(S, 0.0)
        return S

    # ---------- 稀疏化 ----------
    def sparsify_similarity(self, S, W):
        """按 self.sparsify 修剪相似度矩阵，弱边置 0。"""
        if self.sparsify == 'none':
            return S

        n = S.shape[0]
        if self.sparsify == 'knn':
            # 论文 Remark 3：保留每个对象的 k0 个最近邻（按 Wasserstein 距离）
            S_new = np.zeros_like(S)
            k = min(self.k0, n - 1)
            for i in range(n):
                # 距离最近的 k 个邻居（排除自身）
                order = np.argsort(W[i])
                nn = order[1:k + 1]  # order[0] 是自身（距离 0）
                S_new[i, nn] = S[i, nn]
            # 对称化：保留任一方向为近邻的边
            S_new = np.maximum(S_new, S_new.T)
            np.fill_diagonal(S_new, 0.0)
            return S_new

        if self.sparsify == 'lof':
            from sklearn.neighbors import LocalOutlierFactor
            # 每个对象的"相似度画像" = 该对象与其他所有对象的相似度向量
            lof = LocalOutlierFactor(
                n_neighbors=min(self.lof_neighbors, n - 1),
                contamination=self.lof_contamination,
                novelty=False,
            )
            # LOF 在距离矩阵（每行作为特征）上拟合，标记离群对象
            pred = lof.fit_predict(W)
            outlier = pred == -1

            S_new = np.zeros_like(S)
            for i in range(n):
                sims = S[i].copy()
                sims[i] = -np.inf
                # 基础剪枝阈值：该对象相似度的高分位数（保留明显强于噪声的边）
                base_q = np.quantile(sims[sims > -np.inf], 0.5) if np.any(sims > -np.inf) else 0.0
                # 离群对象施加更强剪枝：阈值提高到 75 分位数
                q = np.quantile(sims[sims > -np.inf], 0.75) if outlier[i] else base_q
                keep = sims >= q
                # 同时保留 top-k0 强边，避免阈值过高导致全剪
                top_k = min(self.k0, n - 1)
                order = np.argsort(sims)[::-1][:top_k]
                keep[order] = True
                S_new[i, keep] = S[i, keep]
            S_new = np.maximum(S_new, S_new.T)
            np.fill_diagonal(S_new, 0.0)
            return S_new

        raise ValueError(f"未知的 sparsify 方式：{self.sparsify}")

    # ---------- 主流程 ----------
    def fit(self, trans_dic, mids):
        """输入 {对象ID: 观测值序列} 与对象ID列表，返回簇标签（与 mids 对齐）。"""
        import time as _time
        mids = list(mids)
        n = len(mids)
        t_start = _time.time()

        print('==> start!  WSC clustering')
        print('--> number of objects:  {}'.format(n))

        print('--> computing Wasserstein distance matrix ...')
        self.W_ = self.compute_wasserstein(trans_dic, mids)
        print('--> Wasserstein distance matrix done  ({:.2f}s)'.format(_time.time() - t_start))

        print('--> constructing similarity matrix ...')
        S_full = self.compute_similarity(self.W_)
        print('--> similarity matrix done  ({:.2f}s)'.format(_time.time() - t_start))

        print('--> sparsifying similarity matrix ({} mode) ...'.format(self.sparsify))
        self.S_ = self.sparsify_similarity(S_full, self.W_)
        print('--> similarity matrix sparsified  ({:.2f}s)'.format(_time.time() - t_start))

        # 谱聚类（affinity='precomputed'，内部用归一化拉普拉斯 + KMeans）
        K = min(self.K, len(mids))
        sc = SpectralClustering(
            n_clusters=K, affinity='precomputed',
            assign_labels='kmeans', random_state=self.random_state,
        )
        print('--> applying spectral clustering (K={}) ...'.format(K))
        self.labels_ = sc.fit_predict(self.S_)

        print('# total running time:  {:.2f}s'.format(_time.time() - t_start))
        return self.labels_

    # ---------- 便捷入口 ----------
    def work(self, K, source, obj_name, rec_name):
        """与 KSKC 类似风格的便捷接口：读 CSV，聚类，返回 DataFrame。"""
        import pandas as pd
        data = pd.read_csv(source)
        self.K = int(K)
        mids = data[obj_name].unique().tolist()
        trans_dic = {m: data[data[obj_name] == m][rec_name].values for m in mids}
        labels = self.fit(trans_dic, mids)
        import pandas as pd
        out = pd.DataFrame({obj_name: mids, 'cluster_label': labels})
        return out
