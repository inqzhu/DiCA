# -*- coding: utf-8 -*-
"""
DiCA 平台后端服务
- 首页门户 + KSKC / WSC 两个网页应用 + 使用说明
- 通过 subprocess 调用 kskc_worker.py / wsc_worker.py 运行聚类
- 返回聚类结果与各簇 ECDF / 密度 / 直方图数据供前端可视化
"""
import os
import json
import uuid
import shutil
import subprocess
import threading
import sys

from flask import Flask, request, jsonify, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
STATIC_DIR = os.path.join(BASE_DIR, 'static')
TEMPLATE_DIR = os.path.join(BASE_DIR, 'templates')
PYTHON = sys.executable

# 算法注册表：算法名 -> worker 脚本
ALGORITHMS = {
    'kskc': 'kskc_worker.py',
    'wsc': 'wsc_worker.py',
}

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATE_DIR)
app.config['MAX_CONTENT_LENGTH'] = 256 * 1024 * 1024  # 256MB

# 任务状态存储：job_id -> dict(status, result, error, ...)
JOBS = {}
JOBS_LOCK = threading.Lock()


# ===================== 页面路由 =====================
@app.route('/')
def index():
    """首页门户：介绍 DiCA 核心思路，链接到两个算法应用。"""
    return send_from_directory(TEMPLATE_DIR, 'index.html')


@app.route('/kskc')
def kskc_page():
    """KSKC 网页应用。"""
    return send_from_directory(TEMPLATE_DIR, 'kskc.html')


@app.route('/wsc')
def wsc_page():
    """WSC 网页应用。"""
    return send_from_directory(TEMPLATE_DIR, 'wsc.html')


@app.route('/help')
def help_page():
    return send_from_directory(TEMPLATE_DIR, 'help.html')


@app.route('/static/<path:filename>')
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


# ===================== 通用聚类 API =====================
@app.route('/api/<algo>/upload', methods=['POST'])
def upload(algo):
    """接收 CSV 文件，保存到 uploads/<job_id>/input.csv，返回列名。"""
    if algo not in ALGORITHMS:
        return jsonify({'error': '未知算法'}), 404
    if 'file' not in request.files:
        return jsonify({'error': '未接收到文件'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '文件名为空'}), 400

    job_id = uuid.uuid4().hex
    job_dir = os.path.join(UPLOAD_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    input_path = os.path.join(job_dir, 'input.csv')
    file.save(input_path)

    try:
        import pandas as pd
        df = pd.read_csv(input_path, nrows=5)
        columns = list(df.columns)
        preview = df.head(5).values.tolist()
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        return jsonify({'error': f'无法解析 CSV 文件：{e}'}), 400

    return jsonify({
        'job_id': job_id,
        'filename': file.filename,
        'columns': columns,
        'preview': preview,
    })


@app.route('/api/<algo>/run', methods=['POST'])
def run(algo):
    """启动聚类任务（后台线程执行）。"""
    if algo not in ALGORITHMS:
        return jsonify({'error': '未知算法'}), 404
    payload = request.get_json(force=True)
    job_id = payload.get('job_id')
    if not job_id:
        return jsonify({'error': '缺少 job_id'}), 400

    job_dir = os.path.join(UPLOAD_DIR, job_id)
    input_path = os.path.join(job_dir, 'input.csv')
    if not os.path.exists(input_path):
        return jsonify({'error': '文件不存在，请重新上传'}), 400

    K = int(payload.get('K', 3))
    obj_name = payload.get('obj_name')
    rec_name = payload.get('rec_name')
    if not obj_name or not rec_name:
        return jsonify({'error': '请指定对象 ID 列与观测值列'}), 400

    with JOBS_LOCK:
        if job_id in JOBS and JOBS[job_id].get('status') == 'running':
            return jsonify({'error': '该任务正在运行中'}), 400
        JOBS[job_id] = {'status': 'running', 'result': None, 'error': None, 'algo': algo}

    # 组装 worker 配置
    cfg = {
        'source': input_path,
        'out_result': os.path.join(job_dir, 'result.csv'),
        'out_summary': os.path.join(job_dir, 'summary.json'),
        'K': K,
        'obj_name': obj_name,
        'rec_name': rec_name,
    }
    if algo == 'kskc':
        cfg.update({
            'NUM_THREAD': int(payload.get('NUM_THREAD', 4)),
            'is_fast': bool(payload.get('is_fast', True)),
            'is_corrected': bool(payload.get('is_corrected', False)),
            'sample_num': int(payload.get('sample_num', 1000)),
            'niter': int(payload.get('niter', 30)),
        })
    else:  # wsc
        sigma = payload.get('sigma')
        if sigma is not None and str(sigma) != '':
            cfg['sigma'] = float(sigma)
        else:
            cfg['sigma'] = None
        cfg.update({
            'sparsify': payload.get('sparsify', 'knn'),
            'k0': int(payload.get('k0', 10)),
            'lof_neighbors': int(payload.get('lof_neighbors', 20)),
            'lof_contamination': payload.get('lof_contamination', 'auto'),
            'random_state': int(payload.get('random_state', 0)),
        })

    cfg_path = os.path.join(job_dir, 'config.json')
    with open(cfg_path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False)

    worker_script = os.path.join(BASE_DIR, ALGORITHMS[algo])
    thread = threading.Thread(target=_run_worker,
                              args=(job_id, job_dir, cfg_path, worker_script, algo),
                              daemon=True)
    thread.start()

    return jsonify({'job_id': job_id, 'status': 'running'})


def _run_worker(job_id, job_dir, cfg_path, worker_script, algo):
    """后台线程调用 worker 子进程，收集结果。"""
    log_path = os.path.join(job_dir, 'log.txt')
    try:
        with open(log_path, 'w', encoding='utf-8') as logf:
            proc = subprocess.Popen(
                [PYTHON, '-u', worker_script, cfg_path],
                stdout=logf, stderr=subprocess.STDOUT,
                cwd=BASE_DIR,
            )
            proc.wait()

        if proc.returncode != 0:
            with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
                err = f.read().strip() or '未知错误'
            with JOBS_LOCK:
                JOBS[job_id] = {'status': 'error', 'result': None, 'error': err, 'algo': algo}
            return

        summary_path = os.path.join(job_dir, 'summary.json')
        result_csv = os.path.join(job_dir, 'result.csv')

        with open(summary_path, 'r', encoding='utf-8') as f:
            summary = json.load(f)

        import pandas as pd
        res_df = pd.read_csv(result_csv)
        assignments = res_df.to_dict(orient='records')
        cluster_members = {}
        for row in assignments:
            lbl = int(row['cluster_label'])
            cluster_members.setdefault(lbl, []).append(str(row[summary['obj_name']]))

        result_payload = {
            'summary': summary,
            'assignments': assignments,
            'cluster_members': cluster_members,
        }
        with JOBS_LOCK:
            JOBS[job_id] = {'status': 'done', 'result': result_payload, 'error': None, 'algo': algo}
    except Exception as e:
        with JOBS_LOCK:
            JOBS[job_id] = {'status': 'error', 'result': None, 'error': str(e), 'algo': algo}


@app.route('/api/<algo>/status/<job_id>', methods=['GET'])
def status(algo, job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        return jsonify({'error': '任务不存在'}), 404

    log_tail = _read_log_tail(job_id)
    if job['status'] == 'done':
        return jsonify({'status': 'done', 'result': job['result'], 'log': log_tail})
    if job['status'] == 'error':
        return jsonify({'status': 'error', 'error': job['error'], 'log': log_tail})
    return jsonify({'status': 'running', 'log': log_tail})


def _read_log_tail(job_id, max_chars=4000):
    log_path = os.path.join(UPLOAD_DIR, job_id, 'log.txt')
    if not os.path.exists(log_path):
        return ''
    try:
        with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            start = max(0, size - max_chars)
            f.seek(start)
            return f.read()
    except Exception:
        return ''


@app.route('/api/<algo>/download/<job_id>', methods=['GET'])
def download(algo, job_id):
    """下载聚类结果 CSV。"""
    job_dir = os.path.join(UPLOAD_DIR, job_id)
    result_csv = os.path.join(job_dir, 'result.csv')
    if not os.path.exists(result_csv):
        return jsonify({'error': '结果不存在'}), 404
    return send_from_directory(job_dir, 'result.csv', as_attachment=True,
                               download_name=f'{algo}_result.csv')


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
