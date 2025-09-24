import {
  QApplication,
  DialogCode,
  FileMode,
  FlexLayout,
  QLabel,
  QLineEdit,
  QMainWindow,
  QTextEdit,
  QPushButton,
  QFileDialog,
  QWidget,
} from '@nodegui/nodegui';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

const CONTROL_URL = process.env.CLIENT_CONTROL_URL ?? 'http://127.0.0.1:4455';
const CONTROL_BASE = new URL(CONTROL_URL);

console.log('[GUI] Control URL:', CONTROL_URL);

const app = new QApplication();
const win = new QMainWindow();
win.setWindowTitle('Brain Hub Control Panel');

const centralWidget = new QWidget();
const layout = new FlexLayout();
centralWidget.setLayout(layout);

const statusLabel = new QLabel();
statusLabel.setWordWrap(true);
statusLabel.setText('Status: waiting for client...');

const refreshStatusButton = new QPushButton();
refreshStatusButton.setText('Refresh Status');

const commandInput = new QLineEdit();
commandInput.setPlaceholderText('Enter command (e.g. audio list, whoami)');
const sendCommandButton = new QPushButton();
sendCommandButton.setText('Send Command');

const playInput = new QLineEdit();
playInput.setPlaceholderText('Audio filename (e.g. song.mp3)');
const playButton = new QPushButton();
playButton.setText('Play');
const broadcastPlayButton = new QPushButton();
broadcastPlayButton.setText('Broadcast Play');

const messageInput = new QLineEdit();
messageInput.setPlaceholderText('Broadcast chat message');
const broadcastMessageButton = new QPushButton();
broadcastMessageButton.setText('Broadcast Message');

const openFileButton = new QPushButton();
openFileButton.setText('Select File');
const uploadNameInput = new QLineEdit();
uploadNameInput.setPlaceholderText('Remote filename');
const uploadButton = new QPushButton();
uploadButton.setText('Upload');
uploadButton.setEnabled(false);

const filesButton = new QPushButton();
filesButton.setText('List Local Files');

const logView = new QTextEdit();
logView.setReadOnly(true);
logView.setPlaceholderText('Log output...');
logView.setMinimumSize(420, 220);

let selectedPath: string | null = null;
let requestId = 0;
const pendingRequests = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }
>();

const worker = new Worker(new URL('./controlWorker.cjs', import.meta.url));

worker.on('message', (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
  appendLog({ event: 'worker-message', message });
  const entry = pendingRequests.get(message.id);
  if (!entry) {
    appendLog({ event: 'worker-message-miss', id: message.id });
    return;
  }
  pendingRequests.delete(message.id);
  appendLog({ event: 'pending-after-delete', size: pendingRequests.size });
  if (message.ok) {
    entry.resolve(message.result);
  } else {
    entry.reject(new Error(message.error ?? 'Unknown error'));
  }
});

worker.on('error', (error) => {
  appendLog({ event: 'worker-error', error: error instanceof Error ? error.message : String(error), pending: pendingRequests.size });
  for (const [, entry] of pendingRequests) {
    entry.reject(error);
  }
  pendingRequests.clear();
});

worker.on('exit', (code) => {
  appendLog({ event: 'worker-exit', code, pending: pendingRequests.size });
  for (const [, entry] of pendingRequests) {
    entry.reject(new Error(`Worker exited with code ${code}`));
  }
  pendingRequests.clear();
});

process.on('exit', () => {
  void worker.terminate();
});

process.on('SIGINT', () => {
  appendLog('Received SIGINT. Shutting down...');
  void worker.terminate().finally(() => {
    try {
      win.close();
    } catch (error) {
      // ignore
    }
    app.quit();
    process.exit(0);
  });
});

layout.addWidget(statusLabel);
layout.addWidget(createRow(refreshStatusButton));
layout.addWidget(createRow(commandInput, sendCommandButton));
layout.addWidget(createRow(playInput, playButton, broadcastPlayButton));
layout.addWidget(createRow(messageInput, broadcastMessageButton));
layout.addWidget(createRow(openFileButton, uploadNameInput, uploadButton));
layout.addWidget(createRow(filesButton));
layout.addWidget(logView);

win.setCentralWidget(centralWidget);
win.resize(560, 520);
win.show();

function appendLog(message: unknown) {
  const text = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  writeSync(process.stdout.fd, `[GUI] ${text}\n`);
  logView.append(line);
}

function refreshStatus() {
  statusLabel.setText('Status: refreshing...');
  setImmediate(() => {
    controlRequest<{
      host: string;
      descriptor: unknown;
      connected: boolean;
      timestamp: string;
      whoami?: unknown;
      audioList?: unknown;
    }>('GET', '/status')
      .then((status) => {
        statusLabel.setText(`Status: connected to ${status.host} @ ${new Date(status.timestamp).toLocaleTimeString()}`);
        appendLog({ event: 'status', status });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        statusLabel.setText(`Status: error - ${message}`);
        appendLog({ event: 'status-error', error: message });
      });
  });
}

refreshStatusButton.addEventListener('clicked', () => {
  void refreshStatus();
});

sendCommandButton.addEventListener('clicked', () => {
  const command = commandInput.text().trim();
  if (!command) {
    appendLog('Command is empty');
    return;
  }
  appendLog({ event: 'command-send', command });
  commandInput.setEnabled(false);
  sendCommandButton.setEnabled(false);
  setImmediate(() => {
    controlRequest<{ result: unknown }>('POST', '/command', { command })
      .then((response) => {
        appendLog({ event: 'command-result', response: response.result });
      })
      .catch((error) => {
        appendLog({ event: 'command-error', error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        commandInput.setEnabled(true);
        sendCommandButton.setEnabled(true);
      });
  });
});

playButton.addEventListener('clicked', () => {
  const filename = playInput.text().trim();
  if (!filename) {
    appendLog('Provide a filename to play');
    return;
  }
  appendLog({ event: 'play-request', filename });
  invokeEndpoint('POST', '/play', { filename });
});

broadcastPlayButton.addEventListener('clicked', () => {
  const filename = playInput.text().trim();
  if (!filename) {
    appendLog('Provide a filename to broadcast');
    return;
  }
  appendLog({ event: 'broadcast-play-request', filename });
  invokeEndpoint('POST', '/broadcast-play', { filename });
});

broadcastMessageButton.addEventListener('clicked', () => {
  const message = messageInput.text().trim();
  if (!message) {
    appendLog('Provide a message to broadcast');
    return;
  }
  appendLog({ event: 'broadcast-message-request', message });
  invokeEndpoint('POST', '/broadcast', { message });
});

filesButton.addEventListener('clicked', () => {
  appendLog('Requesting local files list');
  invokeEndpoint('GET', '/files');
});

openFileButton.addEventListener('clicked', () => {
  const dialog = new QFileDialog(
    win,
    'Select a file to upload',
    process.cwd(),
    'All Files (*.*)'
  );
  dialog.setFileMode(FileMode.ExistingFile);

  const result = dialog.exec();
  const files = result === DialogCode.Accepted ? dialog.selectedFiles() : [];
  if (files.length > 0) {
    selectedPath = files[0];
    uploadButton.setEnabled(true);
    const remoteName = basename(selectedPath);
    uploadNameInput.setText(remoteName);
    appendLog({ event: 'file-selected', path: selectedPath, remoteName });
  } else {
    appendLog('File selection cancelled');
    selectedPath = null;
    uploadButton.setEnabled(false);
    uploadNameInput.clear();
  }
});

uploadButton.addEventListener('clicked', () => {
  if (!selectedPath) {
    appendLog('Select a file before uploading');
    uploadButton.setEnabled(false);
    return;
  }

  const remoteName = uploadNameInput.text().trim() || basename(selectedPath);
  uploadButton.setEnabled(false);
  openFileButton.setEnabled(false);
  setImmediate(async () => {
    try {
      appendLog({ event: 'upload-read-start', file: selectedPath });
      const data = await readFile(selectedPath);
      appendLog({ event: 'upload-read-complete', bytes: data.byteLength });
      const base64 = data.toString('base64');
      appendLog({ event: 'upload-start', file: selectedPath, remoteName, size: data.byteLength });
      const response = await controlRequest('POST', '/upload', {
        filename: remoteName,
        base64,
        contentType: guessContentType(remoteName),
      });
      appendLog({ event: 'upload-complete', response });
    } catch (error) {
      appendLog({ event: 'upload-error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      openFileButton.setEnabled(true);
      uploadButton.setEnabled(Boolean(selectedPath));
    }
  });
});

function invokeEndpoint(method: 'GET' | 'POST', path: string, payload?: unknown) {
  setImmediate(() => {
    appendLog({ event: 'invoke-start', method, path, payload: summarizePayload(path, payload) });
    controlRequest(method, path, payload)
      .then((result) => {
        appendLog({ event: `${path}-response`, result: summarizeResult(path, result) });
      })
      .catch((error) => {
        appendLog({ event: `${path}-error`, error: error instanceof Error ? error.message : String(error) });
      });
  });
}

function guessContentType(path: string) {
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.ogg')) return 'audio/ogg';
  if (path.endsWith('.flac')) return 'audio/flac';
  if (path.endsWith('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
}

type HttpMethod = 'GET' | 'POST';

type ControlResponse<T> = T;

async function controlRequest<T>(method: HttpMethod, path: string, payload?: unknown): Promise<ControlResponse<T>> {
  return new Promise<ControlResponse<T>>((resolve, reject) => {
    const id = ++requestId;
    appendLog({ event: 'controlRequest-dispatch', id, method, path, payload: summarizePayload(path, payload) });
    pendingRequests.set(id, {
      resolve: (value) => {
        appendLog({ event: 'controlRequest-resolve', id, result: summarizeResult(path, value) });
        resolve(value as ControlResponse<T>);
      },
      reject: (reason) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        appendLog({ event: 'controlRequest-reject', id, error: message });
        reject(reason);
      },
    });
    appendLog({ event: 'controlRequest-pending-size', size: pendingRequests.size });
    try {
      worker.postMessage({
        id,
        baseUrl: CONTROL_BASE.toString(),
        method,
        path,
        payload,
      });
      appendLog({ event: 'controlRequest-posted', id });
    } catch (error) {
      pendingRequests.delete(id);
      const message = error instanceof Error ? error.message : String(error);
      appendLog({ event: 'controlRequest-postMessage-error', id, error: message });
      reject(error);
    }
  });
}

function createRow(...widgets: QWidget[]) {
  const row = new QWidget();
  const rowLayout = new FlexLayout();
  row.setLayout(rowLayout);
  rowLayout.setContentsMargins(0, 0, 0, 0);
  widgets.forEach((widget) => {
    rowLayout.addWidget(widget);
  });
  return row;
}

function summarizePayload(path: string, payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  if (path === '/upload') {
    const data = payload as { filename?: string; base64?: string; contentType?: string };
    return {
      filename: data.filename,
      base64Length: typeof data.base64 === 'string' ? data.base64.length : undefined,
      contentType: data.contentType,
    };
  }
  return payload;
}

function summarizeResult(path: string, result: unknown) {
  if (path === '/files' && result && typeof result === 'object') {
    const data = result as { files?: unknown };
    if (Array.isArray(data.files)) {
      return {
        fileCount: data.files.length,
        sample: data.files.slice(0, 5),
      };
    }
  }
  if (path === '/upload' && result && typeof result === 'object') {
    const data = result as { filename?: string; size?: number; contentType?: string };
    return {
      filename: data.filename,
      size: data.size,
      contentType: data.contentType,
    };
  }
  return result;
}

// Keep references alive so widgets are not GC'd while the app is running.
(globalThis as typeof globalThis & { win?: QMainWindow }).win = win;

void refreshStatus();

app.exec();
