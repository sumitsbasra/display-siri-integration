#!/usr/bin/env node
/**
 * Iris WSS Relay
 *
 * Bridges the glasses web app (which needs wss://) to iris-mac's GatewayServer
 * (which runs plain ws:// on localhost:18789). Run this on your Mac mini.
 *
 * Usage:
 *   node relay.js
 *
 * Environment variables:
 *   RELAY_PORT  - port this relay listens on (default: 8443)
 *   IRIS_PORT   - iris-mac GatewayServer port (default: 18789)
 *   IRIS_HOST   - iris-mac host (default: localhost)
 *   CERT_PATH   - path to TLS cert (default: ./cert.pem)
 *   KEY_PATH    - path to TLS key  (default: ./key.pem)
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const { WebSocketServer, WebSocket } = require('ws');

const RELAY_PORT = parseInt(process.env.RELAY_PORT || '8443', 10);
const IRIS_PORT  = parseInt(process.env.IRIS_PORT  || '18789', 10);
const IRIS_HOST  = process.env.IRIS_HOST  || 'localhost';
const CERT_PATH  = process.env.CERT_PATH  || './cert.pem';
const KEY_PATH   = process.env.KEY_PATH   || './key.pem';

let cert, key;
try {
  cert = fs.readFileSync(CERT_PATH);
  key  = fs.readFileSync(KEY_PATH);
} catch (err) {
  console.error(`\nCould not load TLS cert/key: ${err.message}`);
  console.error('Run ./generate-cert.sh first, or set CERT_PATH / KEY_PATH.\n');
  process.exit(1);
}

const server = https.createServer({ cert, key });
const wss    = new WebSocketServer({ server });

wss.on('connection', (glasses, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[+] Glasses connected from ${ip}`);

  const iris = new WebSocket(`ws://${IRIS_HOST}:${IRIS_PORT}`);

  iris.on('open',  ()    => console.log(`    -> iris-mac connected`));
  iris.on('error', (err) => {
    console.error(`    iris-mac error: ${err.message}`);
    glasses.terminate();
  });

  // iris-mac -> glasses
  iris.on('message', (data) => {
    if (glasses.readyState === WebSocket.OPEN) glasses.send(data);
  });

  // glasses -> iris-mac
  glasses.on('message', (data) => {
    if (iris.readyState === WebSocket.OPEN) iris.send(data);
  });

  glasses.on('close', () => {
    console.log(`[-] Glasses disconnected from ${ip}`);
    iris.terminate();
  });

  iris.on('close', () => {
    console.log(`    iris-mac closed connection`);
    glasses.terminate();
  });
});

server.listen(RELAY_PORT, '0.0.0.0', () => {
  console.log(`\nIris WSS Relay running`);
  console.log(`  Listening : wss://0.0.0.0:${RELAY_PORT}`);
  console.log(`  Iris host : ws://${IRIS_HOST}:${IRIS_PORT}`);
  console.log(`\nIn the glasses app Settings, use:`);
  console.log(`  wss://<your-mac-mini-ip>:${RELAY_PORT}\n`);
});
