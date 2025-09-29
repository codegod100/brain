#!/usr/bin/env node

const { execSync } = require('child_process');
const wsUrl = process.argv[2];

if (!wsUrl) {
  console.error('Usage: node build-deploy.js <websocket-url>');
  process.exit(1);
}

console.log(`Building with WS_URL: ${wsUrl}`);

execSync(`VITE_WS_URL=${wsUrl} vite build`, { stdio: 'inherit' });