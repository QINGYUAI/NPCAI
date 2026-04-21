// 仅用于 M4.2.0 验收：把小美的 simulation_meta 写到 70KB，触发前端 soft 警告
const http = require('http');
const id = process.argv[2] || '2';
const size = parseInt(process.argv[3] || '70000', 10);
const payload = { pad: 'x'.repeat(size), note: 'soft-threshold-acceptance' };
const body = JSON.stringify({ simulation_meta: payload });
const req = http.request(
  {
    host: 'localhost',
    port: 3000,
    method: 'PUT',
    path: `/api/npc/${id}`,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  },
  (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => console.log(res.statusCode, d));
  }
);
req.on('error', (e) => console.error(e.message));
req.write(body);
req.end();
