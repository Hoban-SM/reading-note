/* 독서노트 공용 모듈 — 앱 화면(app.js)과 백그라운드 작업(sw.js)이 함께 씁니다.
 *  - 서명 키: IndexedDB에 '꺼낼 수 없는' CryptoKey로만 보관
 *  - 요청 서명: HMAC-SHA256 + 시각 + 1회용 번호
 *  - 저장 대기열(outbox): 저장할 기록을 먼저 휴대폰에 넣어 두고 보냄
 *    → 보내는 도중 창을 닫거나 인터넷이 끊겨도, 다음 기회(백그라운드 또는 다음 실행)에 이어서 보냄
 *    → 기록마다 고유번호(cid)가 있어 두 번 보내도 서버에 한 번만 저장됨
 */
(function (g) {
  'use strict';
  const DB_NAME = 'reading-note-secure', DB_VER = 2;
  const enc = new TextEncoder();
  const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  const GAS_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const err = (msg, code) => { const e = new Error(msg); e.code = code || ''; return e; };

  /* ── IndexedDB ── */
  function openDb() {
    return new Promise((res, rej) => {
      if (!g.indexedDB) return rej(new Error('no idb'));
      const r = g.indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        ['keys', 'meta', 'outbox'].forEach(n => { if (!db.objectStoreNames.contains(n)) db.createObjectStore(n); });
      };
      r.onsuccess = () => { const db = r.result; db.onversionchange = () => db.close(); res(db); };
      r.onerror = () => rej(r.error);
    });
  }
  async function tx(store, mode, fn) {
    const db = await withTimeout(openDb(), 4000);
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => { db.close(); res(req ? req.result : undefined); };
      t.onerror = t.onabort = () => { db.close(); rej(t.error); };
    });
  }
  const dbGet = (s, k) => tx(s, 'readonly', o => o.get(k));
  const dbPut = (s, k, v) => tx(s, 'readwrite', o => o.put(v, k));
  const dbDel = (s, k) => tx(s, 'readwrite', o => o.delete(k));
  const dbAll = s => tx(s, 'readonly', o => o.getAll());

  /* ── 로그인 정보 ── */
  let keyCache = null, authCache = null;
  async function getKey() {
    if (keyCache) return keyCache;
    try { keyCache = (await dbGet('keys', 'hmac')) || null; } catch (e) { keyCache = null; }
    return keyCache;
  }
  async function getAuth() {
    if (authCache) return authCache;
    try { authCache = (await dbGet('meta', 'auth')) || null; } catch (e) { authCache = null; }
    return authCache;
  }
  async function setMeta(url, dev) {
    authCache = { url, dev };
    try { await dbPut('meta', 'auth', authCache); return true; } catch (e) { return false; }
  }
  /** 로그인 성공 시: 토큰을 꺼낼 수 없는 키로 바꿔 보관. 저장 실패(사생활 모드 등)면 이번 실행 동안만 유지 */
  async function setAuth(token, url, dev) {
    keyCache = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    authCache = { url, dev };
    try { await dbPut('keys', 'hmac', keyCache); await dbPut('meta', 'auth', authCache); return true; }
    catch (e) { return false; }
  }
  async function clearAuth() {
    keyCache = null; authCache = null;
    try { await dbDel('keys', 'hmac'); await dbDel('meta', 'auth'); } catch (e) {}
  }

  /* ── 요청 ── */
  async function post(url, body) {
    if (!GAS_URL_RE.test(url)) throw err('웹앱 URL 형식이 올바르지 않습니다.', 'config');
    let res;
    try {
      res = await fetch(url, { method: 'POST', body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'follow' });
    } catch (e) { throw err('서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.', 'network'); }
    if (!res.ok) throw err('서버 응답 오류 (' + res.status + ')', 'network');
    try { return await res.json(); } catch (e) { throw err('서버 응답을 읽지 못했습니다. 웹앱 배포 설정을 확인하세요.', 'network'); }
  }

  async function call(action, params) {
    const auth = await getAuth(), key = await getKey();
    if (!auth || !auth.url || !auth.dev || !key) throw err('로그인이 필요합니다.', 'auth');
    let skew = 0;
    try { skew = Number(await dbGet('meta', 'skew')) || 0; } catch (e) {}
    const payload = JSON.stringify(params || {});
    const bodyHash = hex(await crypto.subtle.digest('SHA-256', enc.encode(payload)));
    for (let attempt = 0; attempt < 2; attempt++) {
      const ts = Math.round(Date.now() + skew);
      const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
      const msg = [auth.dev, String(ts), nonce, action, bodyHash].join('\n');
      const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
      const j = await post(auth.url, { action, deviceId: auth.dev, ts, nonce, payload, sig });
      if (!j.ok && j.code === 'clock' && j.serverTime && attempt === 0) {
        skew = j.serverTime - Date.now();
        try { await dbPut('meta', 'skew', skew); } catch (e) {}
        continue;
      }
      if (!j.ok) throw err(j.error || '처리 실패', j.code || '');
      return j;
    }
    throw err('기기 시계를 맞춰 주세요.', 'clock');
  }

  /* ── 저장 대기열 ── */
  const RETRYABLE = { network: 1, server: 1, rate: 1, busy: 1, clock: 1, timeout: 1 };
  const STALE_SENDING_MS = 3 * 60 * 1000; // 보내던 중 멈춘 기록은 3분 뒤 다시 보냄
  const KEEP_DONE_MS = 3 * 24 * 3600 * 1000;

  async function enqueue(params) {
    const cid = hex(crypto.getRandomValues(new Uint8Array(16)));
    const item = {
      cid, created: Date.now(), status: 'pending', tries: 0, lastTry: 0, error: '',
      label: { book: params.book || '', page: params.page || '', photos: (params.images || []).length },
      params: Object.assign({}, params, { cid })
    };
    await dbPut('outbox', cid, item);
    return item;
  }

  async function list() {
    let items = [];
    try { items = await dbAll('outbox'); } catch (e) { return []; }
    const now = Date.now();
    for (const it of items) {
      if (it.status === 'done' && it.seen && now - (it.done || 0) > KEEP_DONE_MS) { try { await dbDel('outbox', it.cid); } catch (e) {} }
    }
    return items.filter(it => !(it.status === 'done' && it.seen && now - (it.done || 0) > KEEP_DONE_MS))
      .sort((a, b) => a.created - b.created);
  }
  const getItem = cid => dbGet('outbox', cid);
  const putItem = it => dbPut('outbox', it.cid, it);
  const removeItem = cid => dbDel('outbox', cid);

  async function flushOnce(onUpdate) {
    const items = await list();
    let done = 0;
    for (const it of items) {
      if (it.status === 'done' || it.status === 'failed') continue;
      if (it.status === 'sending' && Date.now() - (it.lastTry || 0) < STALE_SENDING_MS) continue;
      it.status = 'sending'; it.lastTry = Date.now(); it.tries = (it.tries || 0) + 1; it.error = '';
      await putItem(it); if (onUpdate) onUpdate(it);
      try {
        const r = await call('save', it.params);
        it.status = 'done'; it.done = Date.now(); it.result = r; it.seen = false;
        delete it.params; // 사진 데이터는 더 이상 필요 없음
        done++;
      } catch (e) {
        it.error = e.message;
        if (e.code === 'auth') it.status = 'needLogin';
        else if (RETRYABLE[e.code]) it.status = 'pending';
        else it.status = 'failed'; // 사진 형식 오류 등 다시 보내도 안 되는 경우
      }
      await putItem(it); if (onUpdate) onUpdate(it);
      if (it.status === 'needLogin') break;
      if (it.status === 'pending') break; // 인터넷 문제면 나머지도 다음 기회에
    }
    return done;
  }

  /** 동시에 여러 곳(앱 화면·백그라운드)에서 보내지 않도록 잠금 */
  function flush(onUpdate) {
    const nav = g.navigator;
    if (nav && nav.locks && nav.locks.request) {
      return nav.locks.request('rn-outbox', { ifAvailable: true }, lock => lock ? flushOnce(onUpdate) : 0);
    }
    return flushOnce(onUpdate);
  }

  async function hasUnsent() {
    return (await list()).some(it => it.status === 'pending' || it.status === 'sending' || it.status === 'needLogin');
  }

  /** 로그인이 필요해 멈춘 기록을 다시 보낼 수 있게 되돌림 */
  async function resetNeedLogin() {
    for (const it of await list()) if (it.status === 'needLogin') { it.status = 'pending'; await putItem(it); }
  }

  g.RN = { GAS_URL_RE, hex, post, call, getKey, getAuth, setAuth, setMeta, clearAuth,
    enqueue, list, getItem, putItem, removeItem, flush, hasUnsent, resetNeedLogin };
})(typeof self !== 'undefined' ? self : window);
