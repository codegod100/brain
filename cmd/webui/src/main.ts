import './style.css';
import { attachUiBindings, clientApi, type AudioItem } from './client';

// DOM helpers
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = byId<HTMLDivElement>('status');
const hostEl = byId<HTMLInputElement>('host');
const connectBtn = byId<HTMLButtonElement>('connect');
const refreshBtn = byId<HTMLButtonElement>('refresh');
const peersBtn = byId<HTMLButtonElement>('peers');

const cmdEl = byId<HTMLInputElement>('command');
const runBtn = byId<HTMLButtonElement>('run');
const filesBtn = byId<HTMLButtonElement>('files');
const benchmarkBtn = byId<HTMLButtonElement>('benchmark');

const playNameEl = byId<HTMLInputElement>('playName');
const playBtn = byId<HTMLButtonElement>('play');
const broadcastPlayBtn = byId<HTMLButtonElement>('broadcastPlay');
const logsEl = byId<HTMLPreElement>('logs');
const clearLogsBtn = byId<HTMLButtonElement>('clearLogs');
const audioListEl = byId<HTMLUListElement>('audioList');
const runBenchmarkBtn = byId<HTMLButtonElement>('runBenchmark');
const benchmarkSummaryEl = byId<HTMLDivElement>('benchmarkSummary');
const benchmarkTableBody = byId<HTMLTableSectionElement>('benchmarkTableBody');
const audioFileInput = byId<HTMLInputElement>('audioFileInput');
const audioFileNameInput = byId<HTMLInputElement>('audioFileName');
const uploadAudioBtn = byId<HTMLButtonElement>('uploadAudio');
const uploadStatusEl = byId<HTMLDivElement>('uploadStatus');

const runMapReduceBtn = byId<HTMLButtonElement>('runMapReduce');
const mapReduceTasksEl = byId<HTMLTextAreaElement>('mapReduceTasks');
const mapReduceReducerEl = byId<HTMLSelectElement>('mapReduceReducer');
const mapReduceRequestIdEl = byId<HTMLInputElement>('mapReduceRequestId');
const checkMapReduceStatusBtn = byId<HTMLButtonElement>('checkMapReduceStatus');
const cancelMapReduceBtn = byId<HTMLButtonElement>('cancelMapReduce');
const mapReduceSummaryEl = byId<HTMLDivElement>('mapReduceSummary');
const mapReduceTableBody = byId<HTMLTableSectionElement>('mapReduceTableBody');

type BenchmarkResult = {
  clientId: string;
  durationMs: number;
  iterations: number;
  opsPerSecond?: number;
  receivedAt: string;
  details?: unknown;
};

type BenchmarkSummary = {
  command: 'benchmark';
  requestId: string;
  requesterId: string | null;
  iterations: number;
  timeoutMs: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  participants: number;
  responded: number;
  pending: string[];
  results: BenchmarkResult[];
  message: string;
};

type BenchmarkUpdate =
  | { kind: 'summary'; summary: BenchmarkSummary }
  | { kind: 'error'; error: string }
  | { kind: 'reset' };

type MapReduceResultEntry = {
  taskId: string;
  assignedTo?: string;
  attempts: number;
  durationMs?: number;
  result?: unknown;
  error?: string;
  metadata?: unknown;
};

type MapReduceSummary = {
  command: 'mapreduce';
  requestId: string;
  requesterId: string | null;
  reducer: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  pendingTasks: number;
  results: MapReduceResultEntry[];
  reducedValue: unknown;
  message: string;
};

type MapReduceUpdate =
  | { kind: 'summary'; summary: MapReduceSummary }
  | { kind: 'status'; status: any }
  | { kind: 'error'; error: string }
  | { kind: 'reset' };

let shouldAutoScroll = true;
let latestBenchmarkSummary: BenchmarkSummary | null = null;

const updateAutoScroll = () => {
  const { scrollTop, scrollHeight, clientHeight } = logsEl;
  shouldAutoScroll = scrollTop + clientHeight >= scrollHeight - 8;
};

logsEl.addEventListener('scroll', () => {
  updateAutoScroll();
});

// Initialize host field from URL or default
function determineHost(): string {
  const params = new URLSearchParams(window.location.search);
  if (params.has('ws')) return params.get('ws')!;
  if (params.has('host')) return params.get('host')!;
  return 'ws://localhost:8787/ws';
}
hostEl.value = determineHost();

renderBenchmarkSummary(null);
setUploadStatus('Select an audio file to upload.', 'muted');

// Set default mapreduce tasks
mapReduceTasksEl.value = '[{"data": 5}, {"data": "hello"}, {"data": [1, 2, 3]}]';
mapReduceReducerEl.value = 'collect';

// Wire UI bindings
attachUiBindings({
  ui_append_log_line: (line) => {
    logsEl.textContent = (logsEl.textContent ?? '') + (logsEl.textContent ? '\n' : '') + line;
    if (shouldAutoScroll) {
      logsEl.scrollTop = logsEl.scrollHeight;
    }
  },
  ui_set_status_text: (text) => {
    statusEl.textContent = text;
  },
  ui_set_log_lines: (lines) => {
    logsEl.textContent = lines.join('\n');
    if (shouldAutoScroll) {
      logsEl.scrollTop = logsEl.scrollHeight;
    }
  },
  ui_set_audio_files: (files) => {
    audioListEl.innerHTML = '';
    for (const file of files) {
      const li = document.createElement('li');
      li.className = 'flex items-center justify-between py-2';
      const left = document.createElement('div');
      left.className = 'flex flex-col pr-2';

      const title = document.createElement('span');
      title.textContent = file.name;
      title.className = 'truncate text-sm font-medium text-slate-900';
      left.appendChild(title);

      const meta = formatAudioMeta(file);
      if (meta) {
        const metaEl = document.createElement('span');
        metaEl.textContent = meta;
        metaEl.className = 'text-xs text-slate-500';
        left.appendChild(metaEl);
      }

      const btns = document.createElement('div');
      btns.className = 'flex gap-2';
      const play = document.createElement('button');
      play.className = 'rounded bg-fuchsia-600 px-2 py-1 text-xs text-white hover:bg-fuchsia-700';
      play.textContent = 'Play';
      play.addEventListener('click', () => clientApi.playAudio(file.name));
      const broadcast = document.createElement('button');
      broadcast.className = 'rounded bg-purple-600 px-2 py-1 text-xs text-white hover:bg-purple-700';
      broadcast.textContent = 'Broadcast';
      broadcast.addEventListener('click', () => clientApi.broadcastPlay(file.name));
      btns.append(play, broadcast);

      li.append(left, btns);
      audioListEl.appendChild(li);
    }
  },
  ui_set_benchmark_result: (update) => {
    if (update.kind === 'summary') {
      renderBenchmarkSummary(update.summary);
    } else if (update.kind === 'error') {
      renderBenchmarkSummary(null, undefined, update.error);
    } else {
      renderBenchmarkSummary(null);
    }
  },
  ui_set_mapreduce_result: (update) => {
    if (update.kind === 'summary') {
      renderMapReduceSummary(update.summary);
    } else if (update.kind === 'error') {
      renderMapReduceSummary(null, undefined, update.error);
    } else {
      renderMapReduceSummary(null);
    }
  },
});

// Event listeners
connectBtn.addEventListener('click', () => {
  clientApi.setHost(hostEl.value.trim());
  clientApi.init();
});

refreshBtn.addEventListener('click', () => clientApi.refreshStatus());
peersBtn.addEventListener('click', () => clientApi.showPeers());

runBtn.addEventListener('click', () => {
  const cmd = cmdEl.value.trim();
  if (cmd) clientApi.sendCommand(cmd);
});
filesBtn.addEventListener('click', () => clientApi.fetchFiles());
benchmarkBtn.addEventListener('click', () => {
  renderBenchmarkSummary(null, 'Benchmark requested…');
  clientApi.runBenchmark();
});

playBtn.addEventListener('click', () => {
  const name = playNameEl.value.trim();
  if (name) clientApi.playAudio(name);
});
broadcastPlayBtn.addEventListener('click', () => {
  const name = playNameEl.value.trim();
  if (name) clientApi.broadcastPlay(name);
});

clearLogsBtn.addEventListener('click', () => {
  logsEl.textContent = '';
  shouldAutoScroll = true;
});

audioFileInput.addEventListener('change', () => {
  const file = audioFileInput.files?.[0] ?? null;
  if (file && !audioFileNameInput.value) {
    audioFileNameInput.value = file.name;
  }
  if (file) {
    setUploadStatus(`Ready to upload ${file.name} (${formatSize(file.size)})`, 'info');
  } else {
    setUploadStatus('Select an audio file to upload.', 'muted');
  }
});

uploadAudioBtn.addEventListener('click', async () => {
  const file = audioFileInput.files?.[0] ?? null;
  if (!file) {
    setUploadStatus('Please choose an audio file first.', 'error');
    return;
  }
  const desiredName = audioFileNameInput.value.trim() || file.name;
  if (!desiredName) {
    setUploadStatus('Provide a filename for the upload.', 'error');
    return;
  }

  uploadAudioBtn.disabled = true;
  setUploadStatus(`Uploading ${desiredName}…`, 'info');
  try {
    const result = await clientApi.uploadAudioFile(file, desiredName);
    setUploadStatus(`Uploaded ${result.filename} (${formatSize(result.size)})`, 'success');
    audioFileInput.value = '';
    audioFileNameInput.value = '';
  } catch (error) {
    setUploadStatus(`Upload failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    uploadAudioBtn.disabled = false;
  }
});

runBenchmarkBtn.addEventListener('click', () => {
  renderBenchmarkSummary(null, 'Benchmark requested…');
  clientApi.runBenchmark();
});

runMapReduceBtn.addEventListener('click', () => {
  const tasks = mapReduceTasksEl.value.trim();
  const reducer = mapReduceReducerEl.value;
  if (!tasks) {
    renderMapReduceSummary(null, undefined, 'Please provide tasks JSON');
    return;
  }
  try {
    JSON.parse(tasks); // Validate JSON
    renderMapReduceSummary(null, 'MapReduce requested…');
    clientApi.runMapReduce(tasks, reducer);
  } catch (error) {
    renderMapReduceSummary(null, undefined, 'Invalid JSON in tasks');
  }
});

checkMapReduceStatusBtn.addEventListener('click', () => {
  const requestId = mapReduceRequestIdEl.value.trim();
  if (!requestId) {
    renderMapReduceSummary(null, undefined, 'Please provide a request ID');
    return;
  }
  clientApi.checkMapReduceStatus(requestId);
});

cancelMapReduceBtn.addEventListener('click', () => {
  const requestId = mapReduceRequestIdEl.value.trim();
  if (!requestId) {
    renderMapReduceSummary(null, undefined, 'Please provide a request ID');
    return;
  }
  clientApi.cancelMapReduce(requestId);
});


// Auto-connect on load
clientApi.setHost(hostEl.value.trim());
clientApi.init();

function formatAudioMeta(file: AudioItem): string | null {
  const parts: string[] = [];
  if (typeof file.size === 'number') {
    parts.push(`${formatSize(file.size)}`);
  }
  if (file.uploaded) {
    try {
      const date = new Date(file.uploaded);
      if (!Number.isNaN(date.valueOf())) {
        parts.push(date.toLocaleString());
      }
    } catch {
      parts.push(file.uploaded);
    }
  }
  if (file.source) {
    parts.push(`source: ${file.source}`);
  }
  return parts.length ? parts.join(' • ') : null;
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = units.shift()!;
  for (const next of units) {
    if (size < 1024) break;
    size /= 1024;
    unit = next;
  }
  return `${size.toFixed(size >= 10 || unit === 'B' ? 0 : 1)} ${unit}`;
}

function renderBenchmarkSummary(summary: BenchmarkSummary | null, message?: string, error?: string) {
  if (summary) {
    latestBenchmarkSummary = summary;
  }

  const hasSummary = Boolean(summary);

  if (error) {
    benchmarkSummaryEl.innerHTML = `<span class="text-sm text-red-600">${escapeHtml(error)}</span>`;
    benchmarkTableBody.innerHTML = `<tr><td colspan="5" class="px-3 py-4 text-center text-red-500">${escapeHtml(error)}</td></tr>`;
    return;
  }

  if (!hasSummary) {
    const text = message ?? 'No benchmark results yet.';
    benchmarkSummaryEl.textContent = text;
    benchmarkTableBody.innerHTML = `<tr><td colspan="5" class="px-3 py-4 text-center text-slate-500">${escapeHtml(text)}</td></tr>`;
    return;
  }

  const data = summary!;
  const pending = data.pending.filter(Boolean);
  benchmarkSummaryEl.innerHTML = `
    <div class="grid gap-2 text-sm text-slate-700 md:grid-cols-2">
      <div><span class="font-medium">Request:</span> <span class="font-mono text-xs">${escapeHtml(data.requestId)}</span></div>
      <div><span class="font-medium">Responded:</span> ${data.responded}/${data.participants}</div>
      <div><span class="font-medium">Duration:</span> ${data.durationMs.toFixed(0)} ms</div>
      <div><span class="font-medium">Iterations:</span> ${data.iterations.toLocaleString()}</div>
      <div><span class="font-medium">Started:</span> ${formatTimestamp(data.startedAt)}</div>
      <div><span class="font-medium">Completed:</span> ${formatTimestamp(data.completedAt)}</div>
    </div>
    <div class="mt-2 text-xs text-slate-500">${escapeHtml(data.message)}</div>
    ${pending.length ? `<div class="mt-2 text-xs text-amber-600">Pending responses: ${pending.map((id) => `<span class=\"font-mono\">${escapeHtml(id)}</span>`).join(', ')}</div>` : ''}
  `;

  const rows = data.results
    .slice()
    .sort((a, b) => a.durationMs - b.durationMs)
    .map((result) => `
      <tr>
        <td class="px-3 py-2 font-mono text-xs text-slate-800">${escapeHtml(result.clientId)}</td>
        <td class="px-3 py-2">${result.durationMs.toFixed(2)}</td>
        <td class="px-3 py-2">${formatOps(result.opsPerSecond)}</td>
        <td class="px-3 py-2">${result.iterations.toLocaleString()}</td>
        <td class="px-3 py-2 text-slate-500">${formatTimestamp(result.receivedAt)}</td>
      </tr>
    `)
    .join('');

  benchmarkTableBody.innerHTML = rows || `<tr><td colspan="5" class="px-3 py-4 text-center text-slate-500">No responses received</td></tr>`;
}

function formatOps(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(value >= 100 ? 0 : 1);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderMapReduceSummary(summary: MapReduceSummary | null, message?: string, error?: string) {
  if (error) {
    mapReduceSummaryEl.innerHTML = `<span class="text-sm text-red-600">${escapeHtml(error)}</span>`;
    mapReduceTableBody.innerHTML = `<tr><td colspan="6" class="px-3 py-4 text-center text-red-500">${escapeHtml(error)}</td></tr>`;
    return;
  }

  if (!summary) {
    const text = message ?? 'No mapreduce results yet.';
    mapReduceSummaryEl.textContent = text;
    mapReduceTableBody.innerHTML = `<tr><td colspan="6" class="px-3 py-4 text-center text-slate-500">${escapeHtml(text)}</td></tr>`;
    return;
  }

  const data = summary;
  mapReduceSummaryEl.innerHTML = `
    <div class="grid gap-2 text-sm text-slate-700 md:grid-cols-2">
      <div><span class="font-medium">Request:</span> <span class="font-mono text-xs">${escapeHtml(data.requestId)}</span></div>
      <div><span class="font-medium">Tasks:</span> ${data.completedTasks}/${data.totalTasks} completed</div>
      <div><span class="font-medium">Duration:</span> ${data.durationMs.toFixed(0)} ms</div>
      <div><span class="font-medium">Reducer:</span> ${escapeHtml(data.reducer)}</div>
      <div><span class="font-medium">Started:</span> ${formatTimestamp(data.startedAt)}</div>
      <div><span class="font-medium">Completed:</span> ${formatTimestamp(data.completedAt)}</div>
    </div>
    <div class="mt-2 text-xs text-slate-500">${escapeHtml(data.message)}</div>
    ${data.failedTasks > 0 ? `<div class="mt-2 text-xs text-red-600">${data.failedTasks} task(s) failed</div>` : ''}
    ${data.pendingTasks > 0 ? `<div class="mt-2 text-xs text-amber-600">${data.pendingTasks} task(s) pending</div>` : ''}
    <div class="mt-2 text-sm">
      <span class="font-medium">Reduced Result:</span>
      <pre class="mt-1 text-xs bg-slate-50 p-2 rounded overflow-x-auto">${escapeHtml(JSON.stringify(data.reducedValue, null, 2))}</pre>
    </div>
  `;

  const rows = data.results
    .map((result) => `
      <tr>
        <td class="px-3 py-2 font-mono text-xs text-slate-800">${escapeHtml(result.taskId)}</td>
        <td class="px-3 py-2 font-mono text-xs text-slate-600">${escapeHtml(result.assignedTo || '—')}</td>
        <td class="px-3 py-2 text-center">${result.attempts}</td>
        <td class="px-3 py-2 text-right">${result.durationMs ? result.durationMs.toFixed(0) : '—'}</td>
        <td class="px-3 py-2 text-xs">
          ${result.error ? `<span class="text-red-600">${escapeHtml(result.error)}</span>` : 
            result.result !== undefined ? `<span class="text-green-600">${escapeHtml(JSON.stringify(result.result))}</span>` : 
            '<span class="text-slate-500">—</span>'}
        </td>
        <td class="px-3 py-2 text-slate-500 text-xs">${result.durationMs ? '✓' : '—'}</td>
      </tr>
    `)
    .join('');

  mapReduceTableBody.innerHTML = rows || `<tr><td colspan="6" class="px-3 py-4 text-center text-slate-500">No task results</td></tr>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function setUploadStatus(message: string, type: 'info' | 'success' | 'error' | 'muted' = 'info') {
  const classes = {
    info: 'text-slate-600',
    success: 'text-green-600',
    error: 'text-red-600',
    muted: 'text-slate-400'
  };
  uploadStatusEl.className = `text-xs ${classes[type]}`;
  uploadStatusEl.textContent = message;
}
