'use strict';

// Synthetic HTTP host probe only. Never forward requests to a real service.
const http = require('node:http');
const {randomBytes, randomUUID} = require('node:crypto');

const BODY_LIMIT = 16 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_COOKIE = 'adi_probe_session';
const CSRF_COOKIE = 'adi_probe_csrf';

class ProbeFailure extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined;
  const values = header.split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
}

function readJson(request) {
  const mediaType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return Promise.reject(new ProbeFailure(415, 'json_required'));
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
    return Promise.reject(new ProbeFailure(413, 'body_too_large'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('aborted', aborted);
      request.removeListener('error', aborted);
      chunks.length = 0;
      if (error) reject(error); else resolve(value);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) return finish(new ProbeFailure(413, 'body_too_large'));
      chunks.push(chunk);
    };
    const end = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
        finish(undefined, value);
      } catch {
        finish(new ProbeFailure(400, 'invalid_json'));
      }
    };
    const aborted = () => finish(new ProbeFailure(400, 'request_aborted'));
    const timer = setTimeout(() => finish(new ProbeFailure(408, 'request_timeout')), REQUEST_TIMEOUT_MS);
    timer.unref();
    request.on('data', data);
    request.on('end', end);
    request.on('aborted', aborted);
    request.on('error', aborted);
  });
}

async function startMockServer() {
  const accounts = new Map();
  const sessions = new Map();
  const sockets = new Set();
  const counts = {
    requests: 0, setup_requests: 0, login_requests: 0, synthetic_logins: 0,
    rejected_logins: 0, non_synthetic_rejections: 0, two_cookie_responses: 0,
    me_requests: 0, cookie_checks_passed: 0, cookie_rejections: 0,
    exchange_requests: 0, csrf_checks_passed: 0, csrf_rejections: 0,
    api_token_creations: 0, api_token_reuses: 0,
    today_requests: 0, bearer_checks_passed: 0, bearer_rejections: 0,
    invalid_json_rejections: 0, oversized_body_rejections: 0,
    request_timeouts: 0, client_errors: 0, server_errors: 0,
    origin_checks_passed: 0, origin_rejections: 0,
  };
  let closed = false;
  let closing;
  let origin;
  const secret = () => randomBytes(32).toString('base64url');
  const user = account => ({user_id: account.id, email: account.email, display_name: '合成员工'});
  function send(response, status, payload, headers = {}) {
    if (response.destroyed || response.writableEnded) return;
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close',
      ...headers,
    });
    response.end(body);
  }
  function session(request) {
    const current = sessions.get(cookieValue(request.headers.cookie, SESSION_COOKIE));
    if (!current || current.expiresAt <= Date.now()) {
      counts.cookie_rejections++;
      throw new ProbeFailure(401, 'invalid_session');
    }
    counts.cookie_checks_passed++;
    return current;
  }
  async function handle(request, response) {
    counts.requests++;
    // A disconnected body must not cause an unhandled IncomingMessage error.
    request.on('error', () => {});
    const path = String(request.url || '').split('?')[0];
    try {
      if (closed) throw new ProbeFailure(503, 'probe_closed');
      if (request.method === 'POST') {
        if (!origin || request.headers.origin !== origin) {
          counts.origin_rejections++;
          throw new ProbeFailure(403, 'invalid_origin');
        }
        counts.origin_checks_passed++;
      }
      if (request.method === 'GET' && path === '/api/setup') {
        counts.setup_requests++;
        return send(response, 200, {data: {departments: [{id: '00000000-0000-4000-8000-000000000001', name: '合成部门'}]}});
      }
      if (request.method === 'POST' && path === '/api/login') {
        counts.login_requests++;
        const input = await readJson(request);
        if (closed) throw new ProbeFailure(503, 'probe_closed');
        const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
        if (!/^[a-z0-9._+-]{1,64}@example\.invalid$/.test(email)) {
          counts.non_synthetic_rejections++;
          counts.rejected_logins++;
          throw new ProbeFailure(422, 'synthetic_identity_required');
        }
        if (typeof input.password !== 'string' || !input.password.length || input.password.length > 128 || Object.keys(input).some(key => !['email', 'password'].includes(key))) {
          counts.rejected_logins++;
          throw new ProbeFailure(400, 'invalid_login');
        }
        // The password is only an input-shape check; this is not real authentication.
        let account = accounts.get(email);
        if (!account) {
          if (accounts.size >= 64) throw new ProbeFailure(503, 'probe_capacity');
          account = {id: randomUUID(), email, apiToken: undefined};
          accounts.set(email, account);
        }
        if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
        const token = secret();
        const csrf = secret();
        sessions.set(token, {account, csrf, expiresAt: Date.now() + SESSION_TTL_MS});
        counts.synthetic_logins++;
        counts.two_cookie_responses++;
        return send(response, 200, {data: {user: user(account), csrf_token: csrf}}, {
          'Set-Cookie': [
            `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
            `${CSRF_COOKIE}=${csrf}; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
          ],
        });
      }
      if (request.method === 'GET' && path === '/api/me') {
        counts.me_requests++;
        return send(response, 200, {data: {user: user(session(request).account)}});
      }
      if (request.method === 'POST' && path === '/api/exchange') {
        counts.exchange_requests++;
        const current = session(request);
        await readJson(request);
        if (closed) throw new ProbeFailure(503, 'probe_closed');
        if (request.headers['x-csrf-token'] !== current.csrf) {
          counts.csrf_rejections++;
          throw new ProbeFailure(403, 'invalid_csrf');
        }
        counts.csrf_checks_passed++;
        if (!current.account.apiToken) {
          current.account.apiToken = 'probe_api_' + secret();
          counts.api_token_creations++;
        } else {
          counts.api_token_reuses++;
        }
        return send(response, 200, {data: {api_token: current.account.apiToken, user_id: current.account.id}});
      }
      if (request.method === 'GET' && path === '/api/today') {
        counts.today_requests++;
        const authorization = request.headers.authorization;
        const account = typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? [...accounts.values()].find(value => value.apiToken && authorization === 'Bearer ' + value.apiToken)
          : undefined;
        if (!account) {
          counts.bearer_rejections++;
          throw new ProbeFailure(401, 'invalid_api_token');
        }
        counts.bearer_checks_passed++;
        const now = new Date();
        return send(response, 200, {data: {
          synthetic: true, business_date: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10),
          timezone: 'Asia/Shanghai', official_chat_tokens: '12345', official_cue_tokens: '234',
          hook_sessions: 2, prompt_turns: 6, content_estimate_tokens: '3456',
          as_of: now.toISOString(), coverage: 'synthetic',
        }});
      }
      throw new ProbeFailure(404, 'not_found');
    } catch (error) {
      const failure = error instanceof ProbeFailure ? error : new ProbeFailure(500, 'probe_failed');
      if (failure.code === 'invalid_json') counts.invalid_json_rejections++;
      if (failure.code === 'body_too_large') counts.oversized_body_rejections++;
      if (failure.code === 'request_timeout') counts.request_timeouts++;
      send(response, failure.status, {error: {code: failure.code}});
      if (!request.destroyed) request.resume();
    }
  }
  const server = http.createServer({requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: REQUEST_TIMEOUT_MS}, (request, response) => {
    void handle(request, response);
  });
  server.keepAliveTimeout = 1000;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => { counts.client_errors++; socket.destroy(); });
  server.on('error', () => { counts.server_errors++; });
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => {server.removeListener('error', failed); resolve();});
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close() {
      if (closing) return closing;
      closed = true;
      closing = new Promise((resolve, reject) => {
        server.close(error => {
          accounts.clear();
          sessions.clear();
          if (error) reject(error); else resolve();
        });
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
    safeChecks() {
      return {
        ...counts, loopback_only: true, http_core_only: true, https_tested: false, https_not_run: true,
        body_limit_bytes: BODY_LIMIT, request_timeout_ms: REQUEST_TIMEOUT_MS,
        accounts: accounts.size, sessions: sessions.size, open_connections: sockets.size, closed,
      };
    },
  };
}

module.exports = {startMockServer};
