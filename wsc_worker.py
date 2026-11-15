# -*- coding: utf-8 -*-
"""
WSC 聚类 worker 脚本（由 Flask 通过 subprocess 调用）。

输入：JSON 配置文件（含数据路径、超参数、输出路径）。
输出：
  - result.csv    聚类分配结果（obj_name, cluster_label）
  - summary.json  各簇统计 + ECDF/密度/直方图数据
"""
import sys
import json
import time
import numpy as np
import pandas as pd

import wsc as wsc_mod
import viz_utils


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
    mids = data[obj_name].unique().tolist()
    trans_dic = {m: data[data[obj_name] == m][rec_name].values for m in mids}

    sigma = cfg.get('sigma')
    if sigma is not None:
        sigma = float(sigma)
    worker = wsc_mod.WSC(
        K=K,
        sigma=sigma,
        sparsify=cfg.get('sparsify', 'knn'),
        k0=int(cfg.get('k0', 10)),
        lof_neighbors=int(cfg.get('lof_neighbors', 20)),
        lof_contamination=cfg.get('lof_contamination', 'auto'),
        random_state=int(cfg.get('random_state', 0)),
    )

    t0 = time.time()
    labels = worker.fit(trans_dic, mids)
    elapsed = time.time() - t0

    result = pd.DataFrame({obj_name: mids, 'cluster_label': labels})
    result.to_csv(out_result, index=False)

    merged = data.merge(result, on=obj_name, how='left')
    summary = viz_utils.build_cluster_summary(
        merged, labels, obj_name, rec_name, K, elapsed,
        n_objects=len(mids), n_records_total=len(data),
    )

    with open(out_summary, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False)

    print('WORKER_DONE')


if __name__ == '__main__':
    main()
