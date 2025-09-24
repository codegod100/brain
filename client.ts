import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import player from "play-sound";

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let host = "ws://localhost:8787";
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--host" || arg === "-h") {
      if (i + 1 < args.length) {
        host = args[i + 1];
        i++; // Skip next arg
      } else {
        console.error("Error: --host requires a value");
        process.exit(1);
      }
    } else if (arg === "--help") {
      console.log("Usage: node client.ts [options]");
      console.log("Options:");
      console.log("  --host, -h <host>    WebSocket host to connect to (default: ws://localhost:8787)");
      console.log("  --help               Show this help message");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Use --help for usage information");
      process.exit(1);
    }
  }
  
  return { host };
}

const { host } = parseArgs();
const CONTROL_HOST = process.env.CLIENT_HTTP_HOST ?? "127.0.0.1";
const CONTROL_PORT = Number.parseInt(process.env.CLIENT_HTTP_PORT ?? "4455", 10);
const CONTROL_URL = `http://${CONTROL_HOST}:${CONTROL_PORT}`;

type ClientDescriptor = {
  id: string;
  joinedAt: string;
  vector: number[];
};

class Client extends RpcTarget {
  broadcast(message: unknown) {
    if (typeof message === "string") {
      console.log(`Incoming message! ${message}`);
    } else if (typeof message === "object" && message !== null) {
      const msg = message as any;
      if (msg.type === "play-audio" && msg.filename) {
        // Don't play if this broadcast is from ourselves
        if (msg.from === descriptor.id) {
          console.log(`🎵 You initiated audio broadcast: ${msg.filename}`);
          return;
        }
        console.log(`🎵 Incoming audio broadcast: ${msg.filename} from ${msg.from || 'unknown'}`);
        // Construct the audio URL based on our host
        const httpHost = host.replace(/^ws/, 'http');
        const audioUrl = `${httpHost}/audio/${msg.filename}`;
        // Play the audio asynchronously
        playAudio(audioUrl, msg.filename).catch(err => {
          console.error(`Failed to play broadcasted audio: ${err}`);
        });
        return;
      }
      try {
        console.log("Incoming message!\n" + JSON.stringify(message, null, 2));
      } catch (error) {
        console.log("Incoming message!", message);
      }
    } else {
      console.log("Incoming message!", message);
    }
  }
}

type HubApi = {
  addClient(stub: Client, descriptor: ClientDescriptor): Promise<number>;
  broadcast(message: unknown): Promise<number>;
  runCommand(command: string, clientId?: string): Promise<unknown>;
};

const api = newWebSocketRpcSession<HubApi>(host);
const descriptor: ClientDescriptor = {
  id: randomUUID(),
  joinedAt: new Date().toISOString(),
  vector: Array.from({ length: 3 }, () => Number.parseFloat(Math.random().toFixed(3))),
};

const client = new Client();
const total = await api.addClient(client, descriptor);
console.log(`Connected to: ${host}`);
console.log(`Connected clients: ${total}`);
console.log('Commands available: type "files" or "help"; "exit" to quit.');

await startHttpInterface();
console.log(`HTTP control interface listening at ${CONTROL_URL}`);

const rl = createInterface({ input: stdin, output: stdout });

// Audio playback function
async function playAudio(url: string, filename: string) {
  console.log(`🎵 Downloading and playing: ${filename}`);
  console.log(`   URL: ${url}`);
  
  try {
    // Download the audio file to a temporary location
    const tempPath = `/tmp/${filename}`;
    const file = fs.createWriteStream(tempPath);
    
    const protocol = url.startsWith('https:') ? https : http;
    
    await new Promise((resolve, reject) => {
      protocol.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(undefined);
        });
      }).on('error', reject);
    });
    
    console.log(`   Downloaded to: ${tempPath}`);
    
    // Play the audio file
    const audioPlayer = player();
    audioPlayer.play(tempPath, (err: any) => {
      if (err) {
        console.error('Error playing audio:', err);
      } else {
        console.log('   Playback finished');
      }
      
      // Clean up temp file
      try {
        fs.unlinkSync(tempPath);
        console.log('   Cleaned up temporary file');
      } catch (cleanupErr) {
        console.warn('   Failed to clean up temp file:', cleanupErr);
      }
    });
    
  } catch (error) {
    console.error('Failed to play audio:', error);
  }
}

// Main command loop

try {
  for await (const line of rl) {
    const command = line.trim();
    if (!command) {
      continue;
    }
    if (command === "files") {
      try {
        const files = fs.readdirSync('.');
        console.log("Local files:\n" + JSON.stringify(files, null, 2));
      } catch (error) {
        console.error("Failed to read files", error);
      }
      continue;
    }
    if (command.startsWith("upload ")) {
      const parts = command.split(" ");
      if (parts.length >= 3) {
        const localPath = parts[1];
        const remoteFilename = parts[2];
        
        try {
          // Read the local file
          const fileData = fs.readFileSync(localPath);
          // Encode as base64
          const base64Data = fileData.toString('base64');
          
          // Upload via worker HTTP endpoint
          const response = await uploadFileViaHttp(remoteFilename, base64Data, guessContentType(remoteFilename));
          console.log("Upload response:\n" + JSON.stringify(response, null, 2));
        } catch (error) {
          console.error("Failed to upload file", error);
        }
      } else {
        console.error("Usage: upload <local-path> <remote-filename>");
      }
      continue;
    }
    if (command.startsWith("broadcast-play ")) {
      const audioFile = command.slice(14).trim();
      if (audioFile) {
        try {
          // First check if the audio file exists
          const audioResponse = await api.runCommand(`audio get ${audioFile}`, descriptor.id) as any;
          if (audioResponse.exists) {
            console.log(`🎵 Broadcasting audio: ${audioFile} to all peers`);
            
            // Broadcast the play command to all clients
            const broadcastMessage = {
              type: "play-audio",
              filename: audioFile,
              from: descriptor.id,
              timestamp: new Date().toISOString()
            };
            
            await api.broadcast(broadcastMessage);
            console.log("Broadcast sent!");
            
            // Also play it locally
            const httpHost = host.replace(/^ws/, 'http');
            const audioUrl = `${httpHost}/audio/${audioFile}`;
            await playAudio(audioUrl, audioFile);
          } else {
            console.error("Audio file not found");
          }
        } catch (error) {
          console.error("Failed to broadcast audio", error);
        }
      } else {
        console.error("Usage: broadcast-play <filename>");
      }
      continue;
    }
    if (command.startsWith("play ")) {
      const audioFile = command.slice(5).trim();
      if (audioFile) {
        try {
          // First get the audio info
          const audioResponse = await api.runCommand(`audio get ${audioFile}`, descriptor.id) as any;
          if (audioResponse.exists) {
            console.log(`🎵 Audio file found: ${audioFile}`);
            console.log(`   Size: ${audioResponse.size} bytes`);
            console.log(`   Type: ${audioResponse.contentType || 'unknown'}`);
            
            // Construct the audio URL based on the host we're connected to
            // Convert ws:// or wss:// to http:// or https://
            const httpHost = host.replace(/^ws/, 'http');
            const audioUrl = `${httpHost}/audio/${audioFile}`;
            
            // Play the audio
            await playAudio(audioUrl, audioFile);
          } else {
            console.error("Audio file not found");
          }
        } catch (error) {
          console.error("Failed to get audio info", error);
        }
      } else {
        console.error("Usage: play <filename>");
      }
      continue;
    }
    if (command === "exit" || command === "quit") {
      break;
    }

    try {
      const response = await api.runCommand(command, descriptor.id);
      console.log("Command response:\n" + JSON.stringify(response, null, 2));
    } catch (error) {
      console.error("Command failed", error);
    }
  }
} finally {
  rl.close();
}

async function startHttpInterface() {
  const server = http.createServer(async (req, res) => {
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    } as const;

    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (!req.url) {
      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: "Missing URL" }));
      return;
    }

    const url = new URL(req.url, CONTROL_URL);

    try {
      if (req.method === "GET" && url.pathname === "/status") {
        console.log(`[HTTP] /status request ${new Date().toISOString()}`);
        const whoami = await safeRunCommand("whoami");
        const audioList = await safeRunCommand("audio list");
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            host,
            descriptor,
            connected: true,
            timestamp: new Date().toISOString(),
            whoami,
            audioList,
          }),
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/files") {
        console.log(`[HTTP] /files request ${new Date().toISOString()}`);
        const files = await fs.promises.readdir(".");
        console.log(`[HTTP] /files response count=${files.length}`);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ files }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/command") {
        const body = await readJsonBody<{ command?: string }>(req);
        console.log(`[HTTP] /command request ${new Date().toISOString()} command=${body.command}`);
        if (!body.command || typeof body.command !== "string") {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: "command is required" }));
          return;
        }
        const result = await api.runCommand(body.command, descriptor.id);
        console.log(`[HTTP] /command response ${new Date().toISOString()}`);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ result }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/upload") {
        const body = await readJsonBody<{ filename?: string; base64?: string; contentType?: string }>(req);
        console.log(`[HTTP] /upload request ${new Date().toISOString()} filename=${body.filename}`);
        if (!body.filename || !body.base64) {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: "filename and base64 are required" }));
          return;
        }
        const uploadResult = await uploadFileViaHttp(
          body.filename,
          body.base64,
          body.contentType ?? guessContentType(body.filename),
        );
        console.log(`[HTTP] /upload response ${new Date().toISOString()} filename=${body.filename}`);
        res.writeHead(200, headers);
        res.end(JSON.stringify(uploadResult));
        return;
      }

      if (req.method === "POST" && url.pathname === "/play") {
        const body = await readJsonBody<{ filename?: string }>(req);
        console.log(`[HTTP] /play request ${new Date().toISOString()} filename=${body.filename}`);
        if (!body.filename) {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: "filename is required" }));
          return;
        }
        const info = await getAudioInfo(body.filename);
        if (!info || !info.exists) {
          res.writeHead(404, headers);
          res.end(JSON.stringify({ error: "Audio file not found" }));
          return;
        }
        await playAudio(buildAudioUrl(body.filename), body.filename);
        console.log(`[HTTP] /play completed ${new Date().toISOString()} filename=${body.filename}`);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ played: body.filename, info }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/broadcast-play") {
        const body = await readJsonBody<{ filename?: string }>(req);
        console.log(`[HTTP] /broadcast-play request ${new Date().toISOString()} filename=${body.filename}`);
        if (!body.filename) {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: "filename is required" }));
          return;
        }
        const info = await getAudioInfo(body.filename);
        if (!info || !info.exists) {
          res.writeHead(404, headers);
          res.end(JSON.stringify({ error: "Audio file not found" }));
          return;
        }
        const message = {
          type: "play-audio",
          filename: body.filename,
          from: descriptor.id,
          timestamp: new Date().toISOString(),
        };
        await api.broadcast(message);
        await playAudio(buildAudioUrl(body.filename), body.filename);
        console.log(`[HTTP] /broadcast-play completed ${new Date().toISOString()} filename=${body.filename}`);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ broadcast: true, filename: body.filename, info }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/broadcast") {
        const body = await readJsonBody<{ message?: string }>(req);
        console.log(`[HTTP] /broadcast request ${new Date().toISOString()} message=${body.message}`);
        if (!body.message) {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: "message is required" }));
          return;
        }
        const payload = {
          type: "user-message",
          from: descriptor.id,
          message: body.message,
          timestamp: new Date().toISOString(),
        };
        const recipients = await api.broadcast(payload);
        console.log(`[HTTP] /broadcast response ${new Date().toISOString()} recipients=${recipients}`);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ recipients, payload }));
        return;
      }

      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      console.error("HTTP interface error", error);
      res.writeHead(500, headers);
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CONTROL_PORT, CONTROL_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {} as T;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as T;
}

async function safeRunCommand(command: string) {
  try {
    return await api.runCommand(command, descriptor.id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function buildAudioUrl(filename: string) {
  const base = host.startsWith("wss") ? host.replace(/^wss/, "https") : host.replace(/^ws/, "http");
  return `${base}/audio/${filename}`;
}

async function getAudioInfo(filename: string) {
  return (await api.runCommand(`audio get ${filename}`, descriptor.id)) as any;
}

function guessContentType(path: string) {
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".ogg")) return "audio/ogg";
  if (path.endsWith(".flac")) return "audio/flac";
  if (path.endsWith(".m4a")) return "audio/mp4";
  return "application/octet-stream";
}

async function uploadFileViaHttp(filename: string, base64: string, contentType: string) {
  const uploadUrl = new URL("/upload", buildAudioUrl(""));
  uploadUrl.pathname = "/upload";
  const body = JSON.stringify({ filename, base64, contentType });
  const isHttps = uploadUrl.protocol === "https:";
  const requestFn = isHttps ? https.request : http.request;

  return new Promise<any>((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: uploadUrl.hostname,
      port: uploadUrl.port || (isHttps ? 443 : 80),
      path: uploadUrl.pathname + uploadUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
    };

    const req = requestFn(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(new Error(`Failed to parse upload response: ${error instanceof Error ? error.message : String(error)}`));
          }
        } else {
          reject(new Error(`HTTP ${status}: ${text || res.statusMessage || "Unknown error"}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
