# -*- coding: utf-8 -*-
import sys
import ks_multi as ksm

if __name__ == '__main__':
    worker = ksm.KSKC()
    worker.obj_name = 'Merchant_id'
    worker.rec_name = 'Transaction'
    worker.NUM_THREAD = 2
    K = 3
    source = 'static/data/test_data.csv'
    result = worker.work(K, source)
    print('---- result shape ----')
    print(result.shape)
    print(result.head())
    print('---- cluster counts ----')
    print(result['cluster_label'].value_counts().sort_index())
