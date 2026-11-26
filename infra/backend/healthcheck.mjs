// Health checks of the Docker backend containers (docker-compose.yml):
//   node infra/backend/healthcheck.mjs payer    the payer answers on its socket and is ready to pay
//   node infra/backend/healthcheck.mjs server   the mailbox API answers, the issuer and the relayer listen
import http from 'node:http';
import net from 'node:net';

const TIMEOUT_MS = 4000;

function get(options) {
  return new Promise((resolve, reject) => {
    const req = http.get({ timeout: TIMEOUT_MS, ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: TIMEOUT_MS }, () => { socket.end(); resolve(); });
    socket.on('timeout', () => socket.destroy(new Error(`port ${port}: timeout`)));
    socket.on('error', reject);
  });
}

const checks = {
  async payer() {
    const res = await get({ socketPath: '/app/.data/operator/undeployed/payer.sock', path: '/health' });
    if (res.status !== 200 || JSON.parse(res.body).ready !== true) throw new Error(`payer not ready: ${res.body}`);
  },
  async server() {
    const res = await get({ host: '127.0.0.1', port: 8787, path: '/v1/time' });
    if (res.status !== 200) throw new Error(`mailbox API: HTTP ${res.status}`);
    await connect(8788);
    await connect(8789);
  },
};

const check = checks[process.argv[2]];
if (!check) {
  console.error('usage: node healthcheck.mjs payer|server');
  process.exit(2);
}
check().then(() => process.exit(0), (err) => {
  console.error(err.message);
  process.exit(1);
});
