// Minimal upstream dev-server stand-in: echoes the port it was given.
import http from 'node:http';

const port = Number(process.env.PORT);
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      echo: true, port, url: req.url, host: req.headers.host,
      proto: req.headers['x-forwarded-proto'],
    }));
  })
  .listen(port, () => console.log(`echo listening on ${port}`));
