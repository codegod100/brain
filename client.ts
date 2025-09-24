import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import player from "play-sound";

type ClientDescriptor = {
  id: string;
  joinedAt: string;
  vector: number[];
};

class Client extends RpcTarget {
  broadcast(message: unknown) {
    if (typeof message === "string") {
      console.log(`Incoming message! ${message}`);
    } else {
      try {
        console.log("Incoming message!\n" + JSON.stringify(message, null, 2));
      } catch (error) {
        console.log("Incoming message!", message);
      }
    }
  }
}

type HubApi = {
  addClient(stub: Client, descriptor: ClientDescriptor): Promise<number>;
  broadcast(message: unknown): Promise<number>;
  runCommand(command: string, clientId?: string): Promise<unknown>;
};

const api = newWebSocketRpcSession<HubApi>("ws://localhost:8787");
const descriptor: ClientDescriptor = {
  id: randomUUID(),
  joinedAt: new Date().toISOString(),
  vector: Array.from({ length: 3 }, () => Number.parseFloat(Math.random().toFixed(3))),
};

const client = new Client();
const total = await api.addClient(client, descriptor);
console.log(`Connected clients: ${total}`);
console.log('Commands available: type "files" or "help"; "exit" to quit.');

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
          
          // Send to server
          const response = await api.runCommand(`audio upload ${remoteFilename} ${base64Data}`, descriptor.id);
          console.log("Upload response:\n" + JSON.stringify(response, null, 2));
        } catch (error) {
          console.error("Failed to upload file", error);
        }
      } else {
        console.error("Usage: upload <local-path> <remote-filename>");
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
            
            // Play the audio if URL is available
            if (audioResponse.url) {
              await playAudio(audioResponse.url, audioFile);
            } else {
              console.log(`   Message: ${audioResponse.message}`);
              console.log(`   To play: Configure R2 public access or use signed URLs`);
            }
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
