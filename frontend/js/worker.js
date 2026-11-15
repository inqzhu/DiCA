/**
 * DiCA 前端版 · 算法 Worker
 * 在后台线程解析 CSV、运行 WSC / KSKC、计算可视化数据，
 * 通过 postMessage 实时回传日志，最终回传结果。
 */
importScripts('./core.js', './wsc.js', './kskc.js', './viz.js');

// 简单 CSV 解析（支持引号包裹、逗号/换行）
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false, inHeader = true;
  const header = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (inHeader) { header.push(...row); inHeader = false; }
        else if (row.length) rows.push(row);
        row = [];
      } else field += ch;
    }
  }
  if (field.length) { row.push(field); if (!inHeader) rows.push(row); }
  return { header, rows };
}

function buildTransDic(text, objCol, recCol) {
  const { header, rows } = parseCSV(text);
  const objIdx = header.indexOf(objCol);
  const recIdx = header.indexOf(recCol);
  if (objIdx < 0 || recIdx < 0) throw new Error('未找到所选列');
  const mids = [], seen = new Set(), transDic = {};
  for (const row of rows) {
    if (row.length <= Math.max(objIdx, recIdx)) continue;
    const id = row[objIdx];
    const val = parseFloat(row[recIdx]);
    if (!seen.has(id)) { seen.add(id); mids.push(id); transDic[id] = []; }
    if (Number.isFinite(val)) transDic[id].push(val);
  }
  return { mids, transDic };
}

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type === 'run') {
    runTask(msg);
  }
};

function runTask(msg) {
  const { algo, csvText, params, objCol, recCol } = msg;
  try {
    const t0 = Date.now();
    const { mids, transDic } = buildTransDic(csvText, objCol, recCol);
    if (mids.length < 2) {
      self.postMessage({ type: 'error', msg: '对象数量不足（< 2），请检查对象标识列的选择' });
      return;
    }
    const onLog = (line) => self.postMessage({ type: 'log', msg: line });
    const K = params.K || 3;
    let labels;
    if (algo === 'wsc') {
      labels = WSC.runWSC(transDic, mids, Object.assign({}, params, { onLog }));
    } else {
      labels = KSKC.runKSKC(transDic, mids, Object.assign({}, params, { onLog }));
    }
    const elapsed = (Date.now() - t0) / 1000;
    const summary = Viz.buildClusterSummary(mids, labels, transDic, K, elapsed);
    const assignments = mids.map((m, i) => ({ [objCol]: m, cluster_label: labels[i] }));
    self.postMessage({ type: 'done', summary, assignments, objCol, recCol });
  } catch (err) {
    self.postMessage({ type: 'error', msg: (err && err.message) ? err.message : String(err) });
  }
}
