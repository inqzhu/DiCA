# DiCA · 基于分布的聚类分析平台

**DiCA**（Distribution-based Clustering Analysis）是一个面向消费与电商数据分析的聚类平台。它不依赖人工特征，而是把每个对象（商户 / 用户）的大量重复观测记录提炼为**经验分布**，再依据分布之间的差异将对象聚成行为相似的簇。平台内置两种基于分布差异的聚类算法：

- **KSKC**（Kolmogorov–Smirnov K-means Clustering，Zhu et al., 2021, *JRSS-C*）
- **WSC**（Wasserstein-distance-based Spectral Clustering，Zhu, Huang & Zhang, 2025, *ESWA*）

## 功能

- **首页门户**：介绍 DiCA 核心思路（从分布差异开展聚类、挖掘行为模式），超链接进入两个算法应用
- **两个独立网页应用**：KSKC（`/kskc`）与 WSC（`/wsc`），页面结构一致、参数不同
- **测试数据下载**：每个应用的上传区提供 `test_data.csv` 下载链接，快速体验
- **上传 CSV**：点击或拖拽上传（对象 ID 列 + 观测值列，每行一条观测记录）
- **参数配置**：簇数 K 等超参数带默认值、可修改
  - KSKC：并行线程数、度数校正、迭代次数、快速模式等
  - WSC：高斯核带宽 σ、稀疏化方式（KNN / LOF / 无）、近邻数 k0、LOF 参数等
- **运行聚类**：后台调用算法，实时日志反馈进度
- **结果可视化**：
  - 密度分布 / ECDF / 直方图三种视角切换（默认密度分布，更直观）
  - 每个簇的对象数、记录数、均值等统计卡片
  - 聚类分配明细表格，可下载结果 CSV

## 目录结构

```
KSKC-site/
├── app.py              # Flask 后端（门户 + 双算法 API + /help）
├── kskc_worker.py      # KSKC worker（子进程运行算法 + 计算可视化数据）
├── wsc_worker.py       # WSC worker（子进程运行算法 + 计算可视化数据）
├── wsc.py              # WSC 算法实现
├── ks_multi.py         # KSKC 算法实现
├── viz_utils.py        # 公共可视化工具（ECDF/密度/直方图）
├── test_kskc.py        # KSKC 算法测试脚本
├── test_wsc.py         # WSC 算法测试脚本（含 NMI/ARI/ACC 评估）
├── requirements.txt    # Python 依赖
├── templates/
│   ├── index.html      # 首页门户（介绍 DiCA + 算法入口）
│   ├── kskc.html       # KSKC 应用
│   ├── wsc.html        # WSC 应用
│   └── help.html       # 使用说明（图文教程）
├── static/
│   ├── common.css      # 共享样式
│   ├── app.js          # 共享应用逻辑（算法配置驱动）
│   ├── echarts.min.js  # 图表库（本地化）
│   ├── data/           # 测试数据（test_data.csv + test_data_label.csv）
│   └── img/            # 页面图片与截图
└── uploads/            # 上传文件与结果（运行时自动创建）
```

> 算法参考实现：KSKC 原始仓库见 [github.com/inqzhu/KSKC](https://github.com/inqzhu/KSKC)。

## 快速开始

### 1. 安装依赖（首次）

```bash
python -m venv venv
# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
```

### 2. 启动服务

```bash
python app.py
```

默认端口 `8000`，浏览器打开 <http://localhost:8000> 即可使用。

### 3. 测试数据

两个应用的上传区均可直接下载 `test_data.csv`（600 个商户、约 7.8 万条交易流水）。对象列为 `Merchant_id`，观测值列为 `Transaction`，K 取 3。`test_data_label.csv` 为真实标签，供评估脚本使用。

## API 说明

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/` | 首页门户 |
| GET  | `/kskc`、`/wsc` | 两个算法应用 |
| GET  | `/help` | 使用说明 |
| POST | `/api/<algo>/upload` | 上传 CSV，返回列名与 job_id |
| POST | `/api/<algo>/run` | 启动聚类任务（异步），返回 job_id |
| GET  | `/api/<algo>/status/<job_id>` | 查询任务状态，done 时返回结果 |
| GET  | `/api/<algo>/download/<job_id>` | 下载聚类结果 CSV |

其中 `<algo>` 为 `kskc` 或 `wsc`。

## 算法说明

**KSKC**（KS 距离 K-means）：
1. 用两样本 Kolmogorov–Smirnov 距离度量对象经验分布之间的差异；
2. 在 K-means 框架下迭代划分对象，直至收敛。

**WSC**（Wasserstein 谱聚类）：
1. 对 n 个经验分布函数计算两两 Wasserstein 距离，用 `exp(-距离/σ)` 映射为相似度；
2. 稀疏化相似度矩阵（KNN 保留 k0 近邻 / LOF 离群剪枝），弱边置 0；
3. 对稀疏化后的相似度矩阵做谱聚类。

在 `test_data.csv`（600 商户 / 3 类）上，WSC 默认参数（σ=median、KNN、k0=10）达到 NMI≈0.876、ARI≈0.896、ACC≈0.963。

## 部署说明

本项目当前为本地运行的 Flask 应用（开发服务器）。如需上线对外提供服务，建议：

- 使用生产级 WSGI 服务器（如 gunicorn / waitress）替换 Flask 开发服务器；
- 为上传目录（`uploads/`）配置定期清理，避免结果累积占用磁盘；
- 根据并发需求调整资源（两个算法均通过独立子进程运行，计算较耗资源）。
