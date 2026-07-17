// Minimal upstream dev-server stand-in: echoes the port it was given, and
// accepts raw upgrades (an HMR-socket stand-in) that greet then echo bytes.
import http from 'node:http';

const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    echo: true, port, url: req.url, host: req.headers.host,
    proto: req.headers['x-forwarded-proto'],
  }));
});
server.on('upgrade', (_req, socket) => {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n' +
    'hello-from-upstream'
  );
  socket.on('data', (d) => socket.write(d));
  socket.on('error', () => socket.destroy());
});
server.listen(port, () => console.log(`echo listening on ${port}`));
