#!/usr/bin/env node
// One-time script to get a Google OAuth2 refresh token.
// Run: node scripts/get-refresh-token.js path/to/client-secret.json
const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');

const credentialsPath = process.argv[2];
if (!credentialsPath) {
  console.error('Usage: node scripts/get-refresh-token.js path/to/client-secret.json');
  process.exit(1);
}

const { client_secret, client_id, redirect_uris } = JSON.parse(
  fs.readFileSync(credentialsPath, 'utf8')
).installed;

const REDIRECT_URI = 'http://localhost:4242/oauth2callback';
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for redirect on http://localhost:4242 ...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:4242');
  const code = url.searchParams.get('code');
  if (!code) { res.end('No code'); return; }

  res.end('<html><body><h2>Done! Check your terminal for the tokens.</h2></body></html>');
  server.close();

  const { tokens } = await oAuth2Client.getToken(code);
  console.log('\n=== Add these to Railway env vars ===\n');
  console.log(`GOOGLE_OAUTH_CLIENT_ID=${client_id}`);
  console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${client_secret}`);
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\n=====================================\n');
});

server.listen(4242);
