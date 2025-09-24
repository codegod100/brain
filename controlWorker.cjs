const { parentPort } = require('worker_threads');
const { request: httpRequest } = require('http');
const { request: httpsRequest } = require('https');
const { Buffer } = require('buffer');
const { writeSync } = require('fs');

if (!parentPort) {
  throw new Error('controlWorker must be run as a Worker');
}

parentPort.on('message', async (message) => {
  debug('message-received', summarizeMessage(message));
  try {
    const result = await handleRequest(message);
    debug('message-resolved', { id: message.id, ok: true });
    parentPort.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    debug('message-rejected', { id: message.id, error: error instanceof Error ? error.message : String(error) });
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

function handleRequest(message) {
  const url = new URL(message.path, message.baseUrl);
  const body = message.payload !== undefined ? JSON.stringify(message.payload) : undefined;
  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;

  debug('request-start', { id: message.id, url: url.toString(), method: message.method, hasBody: Boolean(body) });
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: 'application/json',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: message.method,
      headers,
    };

    const req = requestFn(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          try {
            debug('request-success', { id: message.id, status, length: text.length });
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            debug('request-parse-error', { id: message.id, error: error instanceof Error ? error.message : String(error) });
            reject(new Error(`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`));
          }
        } else {
          debug('request-http-error', { id: message.id, status, body: text });
          reject(new Error(`HTTP ${status}: ${text || res.statusMessage || 'Unknown error'}`));
        }
      });
    });

    req.on('error', (error) => {
      debug('request-error', { id: message.id, error: error instanceof Error ? error.message : String(error) });
      reject(error);
    });

    req.setTimeout(5000, () => {
      debug('request-timeout', { id: message.id });
      req.destroy(new Error('Request timed out'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function debug(event, payload) {
  try {
    const line = `[WORKER ${new Date().toISOString()}] ${event} ${JSON.stringify(payload)}\n`;
    writeSync(process.stdout.fd, line);
  } catch (error) {
    // Ignore logging failures
  }
}

function summarizeMessage(message) {
  const summary = {
    id: message.id,
    method: message.method,
    path: message.path,
  };
  if (message.payload) {
    if (message.path === '/upload' && typeof message.payload === 'object' && message.payload !== null) {
      const payload = message.payload;
      const base64 = typeof payload.base64 === 'string' ? payload.base64 : '';
      summary.payload = {
        filename: payload.filename,
        base64Length: base64.length,
        contentType: payload.contentType,
      };
    } else {
      summary.payload = message.payload;
    }
  }
  return summary;
}
