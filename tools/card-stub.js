'use strict';

// Stub card renderer for the smoke suite.
//
// The real card renderer lives on the clan website, and the smoke
// suite fires dozens of renders in a few seconds. Against production
// that burst trips the renderer's rate limit (HTTP 429) and the suite
// fails on cards that are fine in normal use. CI therefore runs this
// stub and points the bot at it with CARD_API_URL.
//
// It answers every POST with a small valid PNG whose pixels are a
// hash of the request body, so two different card bodies produce two
// different images, which is all the suite's render checks rely on.
//
//   node tools/card-stub.js   (listens on $CARD_STUB_PORT or 8799)

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function pngFor(body) {
  const hash = crypto.createHash('sha256').update(body).digest();
  const width = 4;
  const height = 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      row[1 + i] = hash[i % hash.length];
      row[1 + i + 1] = hash[(i + 7) % hash.length];
      row[1 + i + 2] = hash[(i + 13) % hash.length];
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const port = Number(process.env.CARD_STUB_PORT || 8799);
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const png = pngFor(Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`card stub listening on 127.0.0.1:${port}`);
});
