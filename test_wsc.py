# -*- coding: utf-8 -*-
"""WSC 算法测试：用 test_data.csv 走通，评估 NMI/ARI/ACC 并摸索超参数。"""
import time
import numpy as np
import pandas as pd
from itertools import permutations
import math

import wsc as wsc_mod
import sys

# 复用 repo/eva.py 的评估逻辑（避免导入依赖问题，直接内联）
def cn2(x):
    return x * (x - 1) / 2

def evaluate(K, pred, true):
    labels_str = true.unique()
    label_to_number = {labels_str[i]: i for i in range(len(labels_str))}
    number_to_label = {i: labels_str[i] for i in range(len(labels_str))}
    d = pd.DataFrame({'pred': list(pred), 'true': list(true)})
    ct = np.zeros([K, K])
    for k1 in range(K):
        for k2 in range(K):
            ct[k1][k2] = len(d[(d['true'] == number_to_label[k1]) & (d['pred'] == k2)])
    n = len(true)
    MI = 0.0; h_S = 0.0; h_real_S = 0.0
    for k1 in range(K):
        for k2 in range(K):
            p_info = ct[k1][k2] / float(n)
            p_real_S = ct[k1, :].sum() / float(n)
            p_S = ct[:, k2].sum() / float(n)
            if p_info != 0:
                MI += p_info * math.log(p_info / p_S / p_real_S)
    for k in range(K):
        p_S = ct[:, k].sum() / float(n)
        p_real_S = ct[k, :].sum() / float(n)
        if p_S != 0: h_S -= p_S * math.log(p_S)
        if p_real_S != 0: h_real_S -= p_real_S * math.log(p_real_S)
    NMI = MI / math.sqrt(h_S * h_real_S)
    sa2 = sum(cn2(ct[k, :].sum()) for k in range(K))
    sb2 = sum(cn2(ct[:, k].sum()) for k in range(K))
    sab2 = sum(cn2(ct[k1][k2]) for k1 in range(K) for k2 in range(K))
    ARI = (sab2 - sa2 * sb2 / cn2(n)) / (0.5 * (sa2 + sb2) - sa2 * sb2 / cn2(n))
    perm = permutations(list(range(K)))
    acc_K = []
    for _perm in perm:
        _acc = sum(ct[k][_perm[k]] for k in range(K))
        acc_K.append(_acc)
    ACC = max(acc_K) / n
    return NMI, ARI, ACC


def run_once(source='static/data/test_data.csv', label_source='static/data/test_data_label.csv',
             K=3, sigma=None, sparsify='knn', k0=10, lof_neighbors=20,
             lof_contamination='auto', obj_name='Merchant_id', rec_name='Transaction'):
    data = pd.read_csv(source)
    mids = data[obj_name].unique().tolist()
    trans_dic = {m: data[data[obj_name] == m][rec_name].values for m in mids}

    worker = wsc_mod.WSC(K=K, sigma=sigma, sparsify=sparsify, k0=k0,
                         lof_neighbors=lof_neighbors,
                         lof_contamination=lof_contamination, random_state=0)
    t0 = time.time()
    labels = worker.fit(trans_dic, mids)
    elapsed = time.time() - t0

    result = pd.DataFrame({obj_name: mids, 'cluster_label': labels})
    true_labels = pd.read_csv(label_source)
    merged = pd.merge(result, true_labels, on=obj_name)
    nmi, ari, acc = evaluate(K, merged['cluster_label'], merged['label'])
    return nmi, ari, acc, elapsed


if __name__ == '__main__':
    print('=' * 70)
    print('WSC 算法测试（test_data.csv，600 商户 / 3 类各 200）')
    print('=' * 70)

    # 基础跑通：默认参数
    nmi, ari, acc, el = run_once()
    print(f'\n[默认参数] sparsify=knn, k0=10, sigma=median')
    print(f'  NMI={nmi:.4f}  ARI={ari:.4f}  ACC={acc:.4f}  耗时={el:.2f}s')

    # 摸索 sigma（带宽）
    print('\n--- 摸索 sigma（固定 knn, k0=10）---')
    for s in [None, 0.1, 0.2, 0.5, 1.0]:
        nmi, ari, acc, el = run_once(sigma=s)
        tag = 'median' if s is None else str(s)
        print(f'  sigma={tag:>6}: NMI={nmi:.4f}  ARI={ari:.4f}  ACC={acc:.4f}')

    # 摸索 k0（KNN 近邻数）
    print('\n--- 摸索 k0（固定 knn, sigma=median）---')
    for k0 in [3, 5, 8, 10, 15, 20]:
        nmi, ari, acc, el = run_once(k0=k0)
        print(f'  k0={k0:>3}: NMI={nmi:.4f}  ARI={ari:.4f}  ACC={acc:.4f}')

    # 三种稀疏化方式对比
    print('\n--- 三种稀疏化方式（sigma=median）---')
    for sp in ['none', 'knn', 'lof']:
        kw = {}
        if sp == 'lof':
            kw = dict(lof_neighbors=20, lof_contamination=0.1)
        nmi, ari, acc, el = run_once(sparsify=sp, **kw)
        print(f'  {sp:>4}: NMI={nmi:.4f}  ARI={ari:.4f}  ACC={acc:.4f}')

    print('\n完成。')
