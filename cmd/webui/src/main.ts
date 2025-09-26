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

const playNameEl = byId<HTMLInputElement>('playName');
const playBtn = byId<HTMLButtonElement>('play');
const broadcastPlayBtn = byId<HTMLButtonElement>('broadcastPlay');
const logsEl = byId<HTMLPreElement>('logs');
const audioListEl = byId<HTMLUListElement>('audioList');

// Initialize host field from URL or default
function determineHost(): string {
  const params = new URLSearchParams(window.location.search);
  if (params.has('ws')) return params.get('ws')!;
  if (params.has('host')) return params.get('host')!;
  const { protocol, host } = window.location;
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProto}://${host}/ws`;
}
hostEl.value = determineHost();

// Wire UI bindings
attachUiBindings({
  ui_append_log_line: (line) => {
    logsEl.textContent = (logsEl.textContent ?? '') + (logsEl.textContent ? '\n' : '') + line;
    logsEl.scrollTop = logsEl.scrollHeight;
  },
  ui_set_status_text: (text) => {
    statusEl.textContent = text;
  },
  ui_set_log_lines: (lines) => {
    logsEl.textContent = lines.join('\n');
    logsEl.scrollTop = logsEl.scrollHeight;
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

playBtn.addEventListener('click', () => {
  const name = playNameEl.value.trim();
  if (name) clientApi.playAudio(name);
});
broadcastPlayBtn.addEventListener('click', () => {
  const name = playNameEl.value.trim();
  if (name) clientApi.broadcastPlay(name);
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
