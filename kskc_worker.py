# -*- coding: utf-8 -*-
"""
KSKC 聚类 worker 脚本
由 Flask 通过 subprocess 调用，避免 multiprocessing 在 Windows spawn 模式下的问题。

参数通过 JSON 配置文件传入（路径由命令行参数指定）。
输出：
  - result.csv    聚类分配结果（obj_name, cluster_label）
  - summary.json  各簇统计信息 + ECDF/直方图/密度曲线数据（供前端绘图）

注意：KSKC 内部的 print 输出（迭代次数、各簇大小等）会实时写到 stdout，
供后端捕获后反馈给前端展示进度。
"""
import sys
import json
import time
import numpy as np
import pandas as pd
from scipy.stats import gaussian_kde

import ks_multi as ksm


def compute_ecdf(values, max_points=1000):
    """计算一组观测值的经验累积分布函数（ECDF），返回 (x, y) 数组。
    采用右连续阶梯函数：F(x) = P(X <= x)。
    对大数据量降采样到 max_points 个点，保证前端绘图流畅。
    """
    arr = np.sort(np.asarray(values, dtype=float))
    n = len(arr)
    if n == 0:
        return [], []
    if n > max_points:
        idx = np.linspace(0, n - 1, max_points, dtype=int)
    else:
        idx = np.arange(n)
    x = arr[idx]
    y = (idx + 1) / n
    return x.tolist(), y.tolist()


def compute_histogram(values, bins, hist_range):
    """在统一 bins 边界上计算频率密度直方图，返回 (bin 中心, 密度)。"""
    arr = np.asarray(values, dtype=float)
    arr = arr[np.isfinite(arr)]
    if len(arr) == 0:
        return [], []
    hist, edges = np.histogram(arr, bins=bins, range=hist_range, density=True)
    centers = ((edges[:-1] + edges[1:]) / 2).tolist()
    return centers, hist.tolist()


def compute_density(values, grid, sample_cap=4000):
    """核密度估计（高斯核），在统一网格 grid 上求值，返回密度值列表。
    失败时返回 None（前端回退到直方图）。"""
    arr = np.asarray(values, dtype=float)
    arr = arr[np.isfinite(arr)]
    if len(arr) < 3:
        return None
    if len(arr) > sample_cap:
        rng = np.random.default_rng(0)
        arr = rng.choice(arr, sample_cap, replace=False)
    try:
        kde = gaussian_kde(arr)
        return kde(grid).tolist()
    except Exception:
        return None


def main():
    cfg_path = sys.argv[1]
    with open(cfg_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)

    source = cfg['source']
    out_result = cfg['out_result']
    out_summary = cfg['out_summary']
    K = int(cfg['K'])
    obj_name = cfg['obj_name']
    rec_name = cfg['rec_name']

    data = pd.read_csv(source)

    worker = ksm.KSKC()
    worker.obj_name = obj_name
    worker.rec_name = rec_name
    worker.NUM_THREAD = int(cfg.get('NUM_THREAD', 4))
    worker.is_fast = bool(cfg.get('is_fast', True))
    worker.is_corrected = bool(cfg.get('is_corrected', False))
    worker.sample_num = int(cfg.get('sample_num', 1000))
    worker.niter = int(cfg.get('niter', 30))

    t0 = time.time()
    result = worker.work(K, source)
    elapsed = time.time() - t0
    print('# total running time:  {:.2f}s'.format(elapsed))

    result.to_csv(out_result, index=False)

    merged = data.merge(result, on=obj_name, how='left')

    # 收集各簇观测值
    cluster_values = []
    all_chunks = []
    for k in range(K):
        sub = merged[merged['cluster_label'] == k]
        values = sub[rec_name].dropna().astype(float)
        cluster_values.append(values)
        all_chunks.append(values.values)

    # 统一可视化范围：用 0.5% ~ 99.5% 分位数裁剪，避免极端长尾撑开坐标
    allv = np.concatenate(all_chunks)
    allv = allv[np.isfinite(allv)]
    lo = float(np.percentile(allv, 0.5))
    hi = float(np.percentile(allv, 99.5))
    if not (hi > lo):
        lo, hi = float(allv.min()), float(allv.max())
    hist_range = (lo, hi)
    hist_bins = 40
    grid = np.linspace(lo, hi, 240)

    clusters = []
    for k in range(K):
        sub = merged[merged['cluster_label'] == k]
        values = cluster_values[k]

        x, y = compute_ecdf(values)
        hx, hy = compute_histogram(values, hist_bins, hist_range)
        density_y = compute_density(values, grid)

        clusters.append({
            'cluster': int(k),
            'n_objects': int(sub[obj_name].nunique()),
            'n_records': int(len(values)),
            'mean': float(values.mean()) if len(values) else None,
            'median': float(values.median()) if len(values) else None,
            'min': float(values.min()) if len(values) else None,
            'max': float(values.max()) if len(values) else None,
            'ecdf_x': x,
            'ecdf_y': y,
            'hist_x': hx,
            'hist_y': hy,
            'density_x': grid.tolist(),
            'density_y': density_y,
        })

    summary = {
        'K': K,
        'obj_name': obj_name,
        'rec_name': rec_name,
        'n_objects': int(merged[obj_name].nunique()),
        'n_records_total': int(len(data)),
        'elapsed_seconds': round(elapsed, 3),
        'x_range': [lo, hi],
        'clusters': clusters,
    }

    with open(out_summary, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False)

    print('WORKER_DONE')


if __name__ == '__main__':
    main()
