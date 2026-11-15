# -*- coding: utf-8 -*-
"""
公共可视化工具：从各簇的观测值计算 ECDF、密度曲线、直方图数据。
KSKC 与 WSC 两个算法的 worker 共用。
"""
import numpy as np
from scipy.stats import gaussian_kde


def compute_ecdf(values, max_points=1000):
    """经验累积分布函数 ECDF（右连续阶梯），降采样到 max_points 点。"""
    arr = np.sort(np.asarray(values, dtype=float))
    n = len(arr)
    if n == 0:
        return [], []
    if n > max_points:
        idx = np.linspace(0, n - 1, max_points, dtype=int)
    else:
        idx = np.arange(n)
    return arr[idx].tolist(), ((idx + 1) / n).tolist()


def compute_histogram(values, bins, hist_range):
    """统一 bins 边界上的频率密度直方图。"""
    arr = np.asarray(values, dtype=float)
    arr = arr[np.isfinite(arr)]
    if len(arr) == 0:
        return [], []
    hist, edges = np.histogram(arr, bins=bins, range=hist_range, density=True)
    centers = ((edges[:-1] + edges[1:]) / 2).tolist()
    return centers, hist.tolist()


def compute_density(values, grid, sample_cap=4000):
    """核密度估计（高斯核）在统一网格上求值。失败返回 None。"""
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


def build_cluster_summary(merged, labels, obj_name, rec_name, K, elapsed,
                          n_objects, n_records_total):
    """根据合并后的数据 + 簇标签，生成 summary dict（含每簇统计 + 三种图数据）。"""
    clusters = []
    all_chunks = []
    cluster_values = []

    for k in range(K):
        sub = merged[merged['cluster_label'] == k]
        values = sub[rec_name].dropna().astype(float)
        cluster_values.append(values)
        all_chunks.append(values.values)

    # 统一可视化范围：0.5%~99.5% 分位数裁剪
    allv = np.concatenate(all_chunks) if all_chunks else np.array([0.0])
    allv = allv[np.isfinite(allv)]
    lo = float(np.percentile(allv, 0.5))
    hi = float(np.percentile(allv, 99.5))
    if not (hi > lo):
        lo, hi = float(allv.min()), float(allv.max())
    hist_bins = 40
    grid = np.linspace(lo, hi, 240)

    for k in range(K):
        sub = merged[merged['cluster_label'] == k]
        values = cluster_values[k]
        x, y = compute_ecdf(values)
        hx, hy = compute_histogram(values, hist_bins, (lo, hi))
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

    return {
        'K': K,
        'obj_name': obj_name,
        'rec_name': rec_name,
        'n_objects': int(n_objects),
        'n_records_total': int(n_records_total),
        'elapsed_seconds': round(elapsed, 3),
        'x_range': [lo, hi],
        'clusters': clusters,
    }
