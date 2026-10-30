// One-time Google Calendar auth. Run on your own machine:
//    node src/gcal-auth.js
// Opens nothing by itself — it prints a Google URL. Open it, approve, and the
// browser redirects to localhost where this script captures the code.
require('dotenv').config();
const http = require('node:http');
const gcal = require('./gcal');

const PORT = 53682;

(async () => {
  let url;
  try {
    url = gcal.getAuthUrl();
  } catch (e) {
    console.error('Set GCAL_CLIENT_ID and GCAL_CLIENT_SECRET in .env first (see src/gcal.js header).');
    process.exit(1);
  }
  console.log('\nOpen this URL in your browser and approve access:\n');
  console.log(url);
  console.log('\nWaiting for the Google redirect...\n');

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const code = u.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('No code received. Try again.');
      return;
    }
    try {
      await gcal.exchangeCode(code);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Done! Tokens saved. You can close this tab and stop the script (Ctrl+C).');
      console.log('\nTokens saved to data/gcal-tokens.json. Google Calendar sync is live.');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Token exchange failed: ' + e.message);
      console.error('Exchange failed:', e.message);
    }
    server.close();
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`Listening on http://localhost:${PORT}/callback ...`));
})();
