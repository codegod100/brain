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

runBenchmarkBtn.addEventListener('click', () => {
  renderBenchmarkSummary(null, 'Benchmark requested…');
  clientApi.runBenchmark();
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
