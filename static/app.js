// DiCA 聚类应用共享逻辑。通过 window.APP 配置区分 KSKC / WSC。
// 页面需在 <script> 中先定义 window.APP = { algo: 'kskc', ... }。

let currentJobId = null;
const clusterColors = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
  '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
  '#5B8DB8', '#D4A24E', '#C86A6A', '#8AA9A4', '#7CA85F'];
const chartDom = document.getElementById('ecdfChart');
let myChart = null;
let lastResult = null;
let currentChartType = 'density';   // 默认展示密度分布（更直观）

const ALGO = window.APP.algo;

// ===== 上传 =====
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault(); dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const resp = await fetch(`/api/${ALGO}/upload`, { method: 'POST', body: fd });
    const data = await resp.json();
    if (!resp.ok) { showError(data.error || '上传失败'); return; }
    currentJobId = data.job_id;
    document.getElementById('fileName').textContent =
      `${data.filename} · ${data.columns.join('、')}`;
    document.getElementById('fileInfo').style.display = 'flex';

    const objSel = document.getElementById('objName');
    const recSel = document.getElementById('recName');
    objSel.innerHTML = ''; recSel.innerHTML = '';
    objSel.disabled = false; recSel.disabled = false;
    data.columns.forEach((c) => {
      objSel.add(new Option(c, c));
      recSel.add(new Option(c, c));
    });
    const lower = data.columns.map(c => c.toLowerCase());
    let objIdx = lower.findIndex(c => /id|merchant|user|对象|商户|账号/.test(c));
    if (objIdx < 0) objIdx = 0;
    let recIdx = lower.findIndex(c => /amount|transaction|交易|金额|value|数值|观测/.test(c));
    if (recIdx < 0) recIdx = data.columns.length > 1 ? 1 : 0;
    objSel.selectedIndex = objIdx;
    recSel.selectedIndex = recIdx;

    document.getElementById('paramCard').scrollIntoView({ behavior: 'smooth' });
    hideError();
  } catch (e) {
    showError('上传请求失败：' + e.message);
  }
}

// ===== 运行 =====
document.getElementById('runBtn').addEventListener('click', runClustering);

function collectParams() {
  const base = {
    job_id: currentJobId,
    obj_name: document.getElementById('objName').value,
    rec_name: document.getElementById('recName').value,
    K: parseInt(document.getElementById('K').value, 10),
  };
  // 各算法特有参数由页面内 window.APP.collectExtra 提供
  if (window.APP.collectExtra) {
    Object.assign(base, window.APP.collectExtra());
  }
  return base;
}

async function runClustering() {
  if (!currentJobId) { showError('请先上传文件'); return; }
  const obj_name = document.getElementById('objName').value;
  const rec_name = document.getElementById('recName').value;
  const K = parseInt(document.getElementById('K').value, 10);
  if (!obj_name || !rec_name) { showError('请选择对象标识列与观测值列'); return; }
  if (!K || K < 2) { showError('簇数 K 至少为 2'); return; }

  document.getElementById('runBtn').disabled = true;
  document.getElementById('progressStatus').style.display = 'block';
  document.getElementById('logConsole').style.display = 'block';
  document.getElementById('logConsole').textContent = '';
  hideError();
  document.getElementById('resultSection').style.display = 'none';

  const payload = collectParams();

  try {
    const resp = await fetch(`/api/${ALGO}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) { showError(data.error || '运行失败'); return; }
    await pollStatus(currentJobId);
  } catch (e) {
    showError('运行请求失败：' + e.message);
  } finally {
    document.getElementById('runBtn').disabled = false;
    document.getElementById('progressStatus').style.display = 'none';
    document.getElementById('logConsole').style.display = 'none';
  }
}

async function pollStatus(jobId) {
  while (true) {
    await new Promise(r => setTimeout(r, 1200));
    try {
      const resp = await fetch(`/api/${ALGO}/status/${jobId}`);
      const data = await resp.json();

      if (data.log) {
        const consoleEl = document.getElementById('logConsole');
        consoleEl.textContent = data.log;
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }

      if (data.status === 'done') { renderResult(data.result); return; }
      if (data.status === 'error') { showError('聚类失败：\n' + (data.error || '未知错误')); return; }
    } catch (e) {
      // 网络抖动，继续轮询
    }
  }
}

// ===== 渲染结果 =====
function fmtInt(n) { return (n == null) ? '-' : n.toLocaleString('en-US'); }
function fmtNum(n) { return (n == null || isNaN(n)) ? '-' : Number(n).toFixed(2); }

function renderResult(result) {
  lastResult = result;
  const summary = result.summary;
  const clusters = summary.clusters;

  document.getElementById('resultHint').textContent =
    `${fmtInt(summary.n_objects)} 个对象 · ${fmtInt(summary.n_records_total)} 条观测记录 · 划分为 ${summary.K} 个簇 · 耗时 ${summary.elapsed_seconds} s`;

  const statCards = document.getElementById('statCards');
  statCards.innerHTML = '';
  clusters.forEach((c, i) => {
    const color = clusterColors[i % clusterColors.length];
    const div = document.createElement('div');
    div.className = 'stat-card';
    div.innerHTML = `
      <div class="stat-head"><span class="dot" style="background:${color}"></span>簇 ${c.cluster}</div>
      <div class="stat-num">${fmtInt(c.n_objects)}</div>
      <div class="stat-lbl">对象数</div>
      <div class="stat-meta">${fmtInt(c.n_records)} 条记录 · 均值 ${fmtNum(c.mean)}</div>`;
    statCards.appendChild(div);
  });

  renderTable(result.assignments, clusters);

  // 先显示结果区并等待布局完成，再渲染图表，避免在隐藏容器上初始化导致图表压扁
  document.getElementById('resultSection').style.display = 'block';
  requestAnimationFrame(() => {
    renderChart(clusters);
    document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth' });
  });
}

function buildSeries(clusters, type) {
  const recName = lastResult.summary.rec_name || '观测值';
  const series = [];
  clusters.forEach((c, i) => {
    const color = clusterColors[i % clusterColors.length];
    const name = `簇 ${c.cluster}`;
    if (type === 'ecdf') {
      series.push({
        name, type: 'line',
        data: c.ecdf_x.map((x, j) => [x, c.ecdf_y[j]]),
        step: 'end', symbol: 'none',
        lineStyle: { width: 2, color },
        itemStyle: { color },
      });
    } else if (type === 'density') {
      if (!c.density_y) return;
      series.push({
        name, type: 'line',
        data: c.density_x.map((x, j) => [x, c.density_y[j]]),
        symbol: 'none', smooth: true,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        areaStyle: { color, opacity: 0.05 },
      });
    } else if (type === 'hist') {
      series.push({
        name, type: 'bar',
        data: c.hist_x.map((x, j) => [x, c.hist_y[j]]),
        barWidth: '90%',
        itemStyle: { color, opacity: 0.5 },
      });
    }
  });
  return { series, recName };
}

function renderChart(clusters, type) {
  type = type || currentChartType;
  if (!myChart) myChart = echarts.init(chartDom);
  // 关键：setOption 前同步容器尺寸，避免在隐藏/未布局容器上初始化导致图表压扁
  myChart.resize();

  const { series, recName } = buildSeries(clusters, type);
  const yNames = { ecdf: 'F(x)', density: '密度', hist: '密度' };

  const option = {
    color: clusterColors.slice(0, clusters.length),
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#e6e8ec',
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: '#1a1d24', fontSize: 12 },
      extraCssText: 'box-shadow: 0 4px 12px rgba(16,24,40,.1); border-radius: 6px;',
      formatter: (params) => {
        if (!params.length) return '';
        const x = Number(params[0].value[0]);
        let s = `${recName} ≈ ${x.toFixed(3)}<br/>`;
        params.forEach(p => {
          const val = Number(p.value[1]);
          s += `${p.marker} ${p.seriesName}: ${type === 'ecdf' ? 'F(x)=' + val.toFixed(4) : val.toFixed(4)}<br/>`;
        });
        return s;
      },
    },
    legend: {
      top: 0, left: 'center', icon: 'circle', itemWidth: 8, itemHeight: 8,
      data: clusters.map(c => `簇 ${c.cluster}`),
      textStyle: { color: '#4b5563', fontSize: 12 },
    },
    grid: { left: 56, right: 24, top: 44, bottom: 44 },
    xAxis: {
      type: 'value', name: recName, nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#7a8494', fontSize: 12 },
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#eef0f3' } },
      axisLabel: { color: '#7a8494', fontSize: 11 },
    },
    yAxis: {
      type: 'value', name: yNames[type], nameLocation: 'end', nameGap: 14,
      min: type === 'ecdf' ? 0 : undefined,
      max: type === 'ecdf' ? 1 : undefined,
      nameTextStyle: { color: '#7a8494', fontSize: 12 },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#eef0f3' } },
      axisLabel: { color: '#7a8494', fontSize: 11 },
    },
    series,
  };
  myChart.setOption(option, true);
  myChart.resize();
}

function renderTable(assignments, clusters) {
  const wrap = document.getElementById('tableWrap');
  const colorMap = {};
  clusters.forEach((c, i) => { colorMap[c.cluster] = clusterColors[i % clusterColors.length]; });
  const objKey = summaryKey(assignments);
  let html = '<table><thead><tr><th>对象标识</th><th>所属簇</th></tr></thead><tbody>';
  assignments.forEach(r => {
    const lbl = r.cluster_label;
    const color = colorMap[lbl] || '#7a8494';
    html += `<tr><td>${r[objKey]}</td><td><span class="cluster-tag"><span class="dot" style="background:${color}"></span>簇 ${lbl}</span></td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

let _summaryObjKey = null;
function summaryKey(assignments) {
  if (_summaryObjKey) return _summaryObjKey;
  const keys = Object.keys(assignments[0] || {});
  _summaryObjKey = keys.find(k => k !== 'cluster_label') || keys[0];
  return _summaryObjKey;
}

// 下载
document.getElementById('downloadBtn').addEventListener('click', () => {
  if (currentJobId) window.location.href = `/api/${ALGO}/download/${currentJobId}`;
});

// 图类型切换
document.querySelectorAll('.ct-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ct-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentChartType = btn.dataset.type;
    if (lastResult) renderChart(lastResult.summary.clusters, currentChartType);
  });
});

// 重置
document.getElementById('resetBtn').addEventListener('click', () => location.reload());

// 标签页切换
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.panel).classList.add('active');
    if (tab.dataset.panel === 'chartPanel' && myChart) setTimeout(() => myChart.resize(), 50);
  });
});

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.style.display = 'block';
  box.textContent = msg;
}
function hideError() {
  document.getElementById('errorBox').style.display = 'none';
}
window.addEventListener('resize', () => { if (myChart) myChart.resize(); });
