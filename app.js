'use strict';
// 다른 사이트에 몰래 끼워 넣는 것(클릭재킹) 차단
if (window.top !== window.self) { document.documentElement.innerHTML = ''; throw new Error('framed'); }
window.addEventListener('error', e => {
  const s = document.getElementById('status');
  if (s) { s.textContent = '앱 오류: ' + (e.message || '알 수 없음') + ' — 기본 브라우저(Chrome·Safari) 최신 버전으로 열어 주세요.'; s.className = 'status err'; }
});
if (!window.crypto || !window.crypto.subtle || !window.fetch || !window.Promise) {
  document.addEventListener('DOMContentLoaded', () => {
    const s = document.getElementById('status');
    if (s) { s.textContent = '이 브라우저는 지원하지 않습니다. Chrome이나 Safari 최신 버전으로 열어 주세요.'; s.className = 'status err'; }
  });
}
(function(){
  const $ = s => document.querySelector(s);
  const store = {
    get(k,d){ try{ const v = localStorage.getItem('rn_'+k); return v===null ? d : v; }catch(e){ return d; } },
    set(k,v){ try{ localStorage.setItem('rn_'+k, v); }catch(e){} },
    del(k){ try{ localStorage.removeItem('rn_'+k); }catch(e){} }
  };
  // 이전 버전의 앱 키가 남아 있으면 삭제
  store.del('key');
  const state = { photos:[], books:[], saving:false, filter:'', mode: store.get('mode','all') };

  $('#today').textContent = new Date().toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'short'});

  /* ── 보안: 로그인 · 요청 서명 ── */
  // 서명 키는 IndexedDB에 '추출 불가(non-extractable)' CryptoKey로만 보관 → 페이지 안의 스크립트도 키 값을 꺼낼 수 없음
  const enc = new TextEncoder();
  const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2,'0')).join('');
  const sha256Hex = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const GAS_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

  function idbOpen(){
    return new Promise((res, rej) => {
      const r = indexedDB.open('reading-note-secure', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('keys');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  async function idbDo(mode, fn){
    if(!window.indexedDB) throw new Error('no idb');
    const db = await withTimeout(idbOpen(), 3000);
    return new Promise((res, rej) => {
      const tx = db.transaction('keys', mode); const req = fn(tx.objectStore('keys'));
      tx.oncomplete = () => { db.close(); res(req && req.result); };
      tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); };
    });
  }
  let hmacKey = null, keyLoaded = false;
  async function getKey(){
    if(hmacKey || keyLoaded) return hmacKey;
    keyLoaded = true;
    try{ hmacKey = (await idbDo('readonly', s => s.get('hmac'))) || null; }catch(e){ hmacKey = null; }
    return hmacKey;
  }
  async function saveToken(token){
    hmacKey = await crypto.subtle.importKey('raw', enc.encode(token), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
    keyLoaded = true;
    try{ await idbDo('readwrite', s => s.put(hmacKey, 'hmac')); return true; }
    catch(e){ return false; } // 사생활 보호 모드 등: 이번 세션에만 유지
  }
  async function clearLocalAuth(){
    hmacKey = null; keyLoaded = true;
    store.del('dev'); store.del('devName');
    try{ renderLoginBanner(); }catch(e){}
    try{ await idbDo('readwrite', s => s.delete('hmac')); }catch(e){}
  }
  const loggedIn = () => !!(store.get('url','') && store.get('dev',''));

  async function post(url, body){
    if(!GAS_URL_RE.test(url)) throw new Error('웹앱 URL 형식이 올바르지 않습니다.');
    let res;
    try{
      res = await fetch(url, { method:'POST', body: JSON.stringify(body), credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer', redirect:'follow' });
    }catch(e){ throw new Error('서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.'); }
    if(!res.ok) throw new Error('서버 응답 오류 ('+res.status+')');
    try{ return await res.json(); }catch(e){ throw new Error('서버 응답을 읽지 못했습니다. 웹앱 배포 설정을 확인하세요.'); }
  }

  let clockOffset = Number(store.get('skew','0')) || 0;
  async function call(action, params, retry = true){
    const url = store.get('url',''), dev = store.get('dev','');
    const key = await getKey();
    if(!url || !dev || !key){ needLogin(); throw new Error('로그인이 필요합니다.'); }
    const payload = JSON.stringify(params || {});
    const ts = Math.round(Date.now() + clockOffset);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const msg = [dev, String(ts), nonce, action, await sha256Hex(payload)].join('\n');
    const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
    const j = await post(url, { action, deviceId: dev, ts, nonce, payload, sig });
    if(!j.ok){
      if(j.code === 'clock' && retry && j.serverTime){
        clockOffset = j.serverTime - Date.now(); store.set('skew', String(clockOffset));
        return call(action, params, false);
      }
      if(j.code === 'auth'){ await clearLocalAuth(); needLogin(); }
      throw new Error(j.error || '처리 실패');
    }
    return j;
  }

  /* ── 설정 · 기기 관리 ── */
  function guessDeviceName(){
    const ua = navigator.userAgent;
    if(/iPhone/.test(ua)) return 'iPhone'; if(/iPad/.test(ua)) return 'iPad';
    if(/Android/.test(ua)) return 'Android 폰'; if(/Mac/.test(ua)) return 'Mac'; if(/Windows/.test(ua)) return 'Windows PC';
    return '내 기기';
  }
  // <dialog>를 지원하지 않는 구형 브라우저에서도 로그인 창이 뜨도록
  const dlg = () => $('#settings');
  const dlgOpen = () => dlg().hasAttribute('open');
  function showDlg(){
    const d = dlg();
    if(dlgOpen()) return;
    if(typeof d.showModal === 'function'){ try{ d.showModal(); return; }catch(e){} }
    d.classList.add('fb'); d.setAttribute('open', ''); $('#dlgBackdrop').classList.remove('hidden');
  }
  function hideDlg(){
    const d = dlg();
    if(typeof d.close === 'function' && !d.classList.contains('fb')){ try{ d.close(); }catch(e){ d.removeAttribute('open'); } }
    else d.removeAttribute('open');
    d.classList.remove('fb'); $('#dlgBackdrop').classList.add('hidden');
    renderLoginBanner();
  }
  function renderLoginBanner(){ $('#loginBanner').classList.toggle('hidden', loggedIn()); }
  function needLogin(){ renderLoginBanner(); if(!dlgOpen()) openSettings(); }
  function setCfgStatus(msg, err){ const s = $('#cfgStatus'); s.textContent = msg || ''; s.className = 'status' + (err ? ' err' : ''); }

  async function openSettings(){
    $('#cfgUrl').value = store.get('url','');
    $('#cfgPw').value = '';
    $('#cfgName').value = store.get('devName','') || guessDeviceName();
    setCfgStatus('');
    const inn = loggedIn() && await getKey();
    $('#loginForm').classList.toggle('hidden', !!inn);
    $('#devPanel').classList.toggle('hidden', !inn);
    showDlg();
    if(inn) loadDevices();
  }
  $('#openSettings').onclick = openSettings;
  $('#cfgClose').onclick = hideDlg;
  $('#devClose').onclick = hideDlg;
  $('#dlgBackdrop').onclick = hideDlg;
  $('#btnLoginBanner').onclick = openSettings;

  $('#cfgLogin').onclick = async () => {
    const url = $('#cfgUrl').value.trim(), pw = $('#cfgPw').value, name = $('#cfgName').value.trim() || guessDeviceName();
    if(!GAS_URL_RE.test(url)){ setCfgStatus('웹앱 URL은 https://script.google.com/macros/s/…/exec 형식이어야 합니다.', true); return; }
    if(!pw){ setCfgStatus('비밀번호를 입력하세요.', true); return; }
    const btn = $('#cfgLogin'); btn.disabled = true; setCfgStatus('확인 중…');
    try{
      const r = await post(url, { action:'login', password: pw, deviceName: name });
      $('#cfgPw').value = '';
      if(!r.ok) throw new Error(r.error || '로그인 실패');
      const persisted = await saveToken(r.token);
      store.set('url', url); store.set('dev', r.deviceId); store.set('devName', r.name);
      setCfgStatus(persisted ? '로그인됐습니다.' : '로그인됐습니다. 이 브라우저는 키를 저장할 수 없어 앱을 닫으면 다시 로그인해야 합니다.');
      $('#loginForm').classList.add('hidden'); $('#devPanel').classList.remove('hidden');
      loadDevices(); refreshBooks(); renderLoginBanner();
    }catch(e){ setCfgStatus(e.message, true); }
    finally{ btn.disabled = false; }
  };

  async function loadDevices(){
    const box = $('#devList'); box.innerHTML = '<div class="hint">기기 목록 불러오는 중…</div>';
    try{
      const r = await call('ping', {}).then(p => call('devices', {}).then(d => Object.assign(d, { gemini: p.gemini })));
      $('#devInfo').textContent = (r.gemini ? 'AI 정리 사용 중' : '글자 추출만 사용 중 (Gemini 키 없음)');
      box.innerHTML = r.devices.map(d => `<div class="dev"><div><b>${esc(d.name)}${d.current ? ' <em>이 기기</em>' : ''}</b><span>마지막 사용 ${esc(d.lastUsed)} · 만료 ${esc(d.expires)}</span></div><button type="button" class="btn" data-id="${esc(d.id)}">${d.current ? '로그아웃' : '해제'}</button></div>`).join('');
      box.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
        const self = b.textContent === '로그아웃';
        if(!confirm(self ? '이 기기에서 로그아웃할까요?' : '이 기기의 접속 권한을 해제할까요? 분실한 기기라면 해제하세요.')) return;
        b.disabled = true;
        try{
          await call('revoke', { id: b.dataset.id });
          if(self){ await clearLocalAuth(); openSettings(); } else loadDevices();
        }catch(e){ setCfgStatus(e.message, true); b.disabled = false; }
      });
    }catch(e){ box.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
  }

  /* ── 탭 ── */
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x => x.setAttribute('aria-selected', x===b));
    const t = b.dataset.tab;
    $('#tab-write').classList.toggle('hidden', t!=='write');
    $('#tab-list').classList.toggle('hidden', t!=='list');
    $('#savebar').classList.toggle('hidden', t!=='write');
    if(t==='list'){ stopMic(); loadList(); }
  });

  /* ── 읽기 방식 ── */
  function renderMode(){ document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode===state.mode)); }
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { state.mode = b.dataset.mode; store.set('mode', state.mode); renderMode(); });
  renderMode();

  /* ── 사진 ── */
  $('#btnCamera').onclick = () => $('#fileCamera').click();
  $('#btnAlbum').onclick = () => $('#fileAlbum').click();
  $('#fileCamera').onchange = e => addFiles(e.target.files, e.target, true);
  $('#fileAlbum').onchange = e => addFiles(e.target.files, e.target, false);

  function loadImage(src){
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }
  // 원본을 2400px 이내 JPEG로 보관 (나중에 잘라낼 때 화질 확보)
  async function toBase(file){
    const url = URL.createObjectURL(file);
    try{
      const img = await loadImage(url);
      const s = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth*s); c.height = Math.round(img.naturalHeight*s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.9);
    } finally { URL.revokeObjectURL(url); }
  }
  // 선택 영역 반영 → 최대 2000px JPEG base64
  async function renderOut(p){
    const img = await loadImage(p.orig);
    const W = img.naturalWidth, H = img.naturalHeight;
    const r = p.crop || { x:0, y:0, w:1, h:1 };
    const sx = r.x*W, sy = r.y*H, sw = r.w*W, sh = r.h*H;
    const s = Math.min(1, 2000 / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw*s)); c.height = Math.max(1, Math.round(sh*s));
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  }

  async function addFiles(files, input, fromCamera){
    const added = [];
    for(const f of files){
      try{ const orig = await toBase(f); const p = { orig, crop:null, preview:orig }; state.photos.push(p); added.push(p); }
      catch(err){ setStatus('사진을 읽지 못했습니다: '+f.name, true); }
    }
    input.value = '';
    renderThumbs();
    // 방금 찍은 사진은 바로 영역 선택 화면으로
    if(fromCamera && added.length === 1) openCropper(state.photos.indexOf(added[0]));
  }

  function renderThumbs(){
    const box = $('#thumbs'); box.innerHTML = '';
    state.photos.forEach((p, i) => {
      const el = document.createElement('div'); el.className='thumb'; el.tabIndex = 0;
      el.setAttribute('role','button'); el.setAttribute('aria-label', (i+1)+'번째 사진, 눌러서 영역 선택');
      el.innerHTML = `<img src="${p.preview}" alt=""><span class="n">${i+1}</span>${p.crop?'<span class="cut">부분 선택</span>':''}<button type="button" class="del" aria-label="${i+1}번째 사진 삭제">×</button>`;
      el.onclick = e => { if(e.target.classList.contains('del')) return; openCropper(i); };
      el.onkeydown = e => { if(e.key==='Enter') openCropper(i); };
      el.querySelector('.del').onclick = () => { state.photos.splice(i,1); renderThumbs(); };
      box.appendChild(el);
    });
    $('#photoHint').textContent = state.photos.length
      ? `${state.photos.length}장 준비됨. 사진을 누르면 읽을 부분을 다시 고를 수 있습니다.`
      : '사진을 누르면 필요한 부분만 선택할 수 있습니다.';
  }

  /* ── 영역 선택 ── */
  let cropIdx = -1, drag = null, pending = null;
  const frame = $('#frame'), sel = $('#sel');
  function openCropper(i){
    cropIdx = i; const p = state.photos[i];
    $('#cropImg').src = p.orig;
    pending = p.crop ? Object.assign({}, p.crop) : null;
    $('#cropper').classList.remove('hidden');
    requestAnimationFrame(drawSel);
  }
  function closeCropper(){ $('#cropper').classList.add('hidden'); cropIdx = -1; drag = null; }
  function drawSel(){
    if(!pending){ sel.classList.add('hidden'); return; }
    const w = frame.clientWidth, h = frame.clientHeight;
    Object.assign(sel.style, { left: pending.x*w+'px', top: pending.y*h+'px', width: pending.w*w+'px', height: pending.h*h+'px' });
    sel.classList.remove('hidden');
  }
  const clamp = v => Math.max(0, Math.min(1, v));
  function pos(e){ const r = frame.getBoundingClientRect(); return { x: clamp((e.clientX-r.left)/r.width), y: clamp((e.clientY-r.top)/r.height) }; }
  frame.addEventListener('pointerdown', e => { frame.setPointerCapture(e.pointerId); drag = pos(e); pending = { x:drag.x, y:drag.y, w:0, h:0 }; drawSel(); });
  frame.addEventListener('pointermove', e => {
    if(!drag) return; const p = pos(e);
    pending = { x:Math.min(drag.x,p.x), y:Math.min(drag.y,p.y), w:Math.abs(p.x-drag.x), h:Math.abs(p.y-drag.y) }; drawSel();
  });
  frame.addEventListener('pointerup', () => { drag = null; if(pending && (pending.w < 0.03 || pending.h < 0.02)){ pending = null; drawSel(); } });
  window.addEventListener('resize', () => { if(cropIdx>=0) drawSel(); });
  $('#cropCancel').onclick = closeCropper;
  $('#cropAll').onclick = () => { const p = state.photos[cropIdx]; p.crop = null; p.preview = p.orig; closeCropper(); renderThumbs(); };
  $('#cropOk').onclick = async () => {
    const p = state.photos[cropIdx];
    if(!pending){ p.crop = null; p.preview = p.orig; }
    else{ p.crop = pending; p.preview = await renderOut(p); }
    closeCropper(); renderThumbs();
  };

  /* ── 음성 메모 ── */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false, baseText = '';
  const micBtn = $('#btnMic');
  if(!SR){
    micBtn.classList.add('hidden');
    $('#memo').placeholder = '이 부분을 읽고 든 생각. 키보드의 마이크 버튼으로 말해서 입력할 수도 있습니다.';
  }
  function setMicUI(on){
    micBtn.classList.toggle('on', on); micBtn.setAttribute('aria-pressed', on);
    micBtn.querySelector('.dot').classList.toggle('hidden', !on);
    micBtn.querySelector('.lbl').textContent = on ? '듣는 중 · 멈추기' : '말로 적기';
    if(!on) $('#interim').textContent = '';
  }
  function startMic(){
    rec = new SR(); rec.lang = 'ko-KR'; rec.continuous = true; rec.interimResults = true;
    const memo = $('#memo');
    baseText = memo.value ? memo.value.replace(/\s*$/, '') + (memo.value.trim() ? ' ' : '') : '';
    let finals = '';
    rec.onresult = ev => {
      let interim = '';
      for(let i = ev.resultIndex; i < ev.results.length; i++){
        const t = ev.results[i][0].transcript;
        if(ev.results[i].isFinal) finals += t.trim() + ' ';
        else interim += t;
      }
      memo.value = (baseText + finals).trimEnd();
      $('#interim').textContent = interim;
    };
    rec.onerror = ev => {
      if(ev.error === 'not-allowed' || ev.error === 'service-not-allowed') setStatus('마이크 권한을 허용해 주세요. 브라우저 설정에서 바꿀 수 있습니다.', true);
      else if(ev.error !== 'no-speech' && ev.error !== 'aborted') setStatus('음성 인식 오류: '+ev.error, true);
    };
    rec.onend = () => { listening = false; setMicUI(false); };
    rec.start(); listening = true; setMicUI(true); setStatus('');
  }
  function stopMic(){ if(rec && listening){ rec.stop(); } }
  micBtn.onclick = () => { listening ? stopMic() : startMic(); };

  /* ── 책 제목 / 저자 ── */
  const cleanTitle = s => String(s||'').replace(/[「」『』《》〈〉<>"“”]/g,'').replace(/\s+/g,' ').trim();
  const titleKey = s => cleanTitle(s).replace(/[\s·:：,.\-_()（）\[\]!?~]/g,'').toLowerCase();
  const findBook = t => { const k = titleKey(t); return k ? state.books.find(b => titleKey(b.title) === k) : null; };

  /* ── 저자 찾기 (제목으로 책 검색) ── */
  let lookupTimer = null, lastQuery = '', lookupSeq = 0;
  function scheduleLookup(){
    clearTimeout(lookupTimer);
    const t = cleanTitle($('#book').value);
    // 새 책이고 저자칸이 비었을 때만 찾기
    if(t.length < 2 || findBook(t) || $('#author').value.trim() || !loggedIn()){ hideLookup(); return; }
    if(t === lastQuery) return;
    lookupTimer = setTimeout(() => runLookup(t), 700);
  }
  function hideLookup(){ $('#lookup').classList.add('hidden'); $('#lookup').innerHTML = ''; }
  async function runLookup(t){
    lastQuery = t; const seq = ++lookupSeq;
    const box = $('#lookup');
    box.innerHTML = '<div class="lh"><span>저자 찾는 중…</span></div>'; box.classList.remove('hidden');
    try{
      const r = await call('lookup', { q: t });
      if(seq !== lookupSeq) return;
      if(!r.items.length){
        box.innerHTML = `<div class="lh"><span>${esc(r.error || '검색 결과가 없습니다. 저자를 직접 입력해 주세요.')}</span><button type="button" data-x>닫기</button></div>`;
      }else{
        box.innerHTML = `<div class="lh"><span>이 책인가요? 누르면 제목과 저자가 채워집니다</span><button type="button" data-x>닫기</button></div>` +
          r.items.map((it,i) => `<button type="button" class="cand" data-i="${i}">
            ${safeImg(it.thumbnail) ? `<img src="${esc(safeImg(it.thumbnail))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="noimg"></div>'}
            <div><b>${esc(it.fullTitle || it.title)}</b><span>${esc(it.authors || '저자 정보 없음')}${it.translators ? ' · 옮긴이 '+esc(it.translators) : ''}</span><span>${esc([it.publisher, it.year].filter(Boolean).join(' · '))}</span></div>
          </button>`).join('');
        box.querySelectorAll('.cand').forEach(el => el.onclick = () => {
          const it = r.items[+el.dataset.i];
          $('#book').value = it.title;
          $('#author').value = it.authors;
          lastQuery = it.title;
          hideLookup(); updateTitleHint(); renderChips();
        });
      }
      const x = box.querySelector('[data-x]'); if(x) x.onclick = hideLookup;
    }catch(e){ if(seq === lookupSeq) hideLookup(); }
  }

  function pickBook(b){
    $('#book').value = b.title;
    $('#author').value = b.author || '';
    updateTitleHint(); renderChips();
  }
  function updateTitleHint(){
    const h = $('#titleHint'), t = cleanTitle($('#book').value);
    h.className = 'titlehint';
    if(!t){ h.textContent = ''; return; }
    const b = findBook(t);
    if(b && b.title === t){ h.textContent = `이어서 기록 · 지금까지 ${b.count}개`; h.classList.add('same'); if(b.author && !$('#author').value) $('#author').value = b.author; }
    else if(b){ h.textContent = `「${b.title}」과 같은 책으로 저장됩니다.`; h.classList.add('same'); }
    else if(state.books.length){ h.textContent = '새 책으로 등록됩니다. 표지의 본제목만 적어 주세요.'; }
    else h.textContent = '';
  }
  function renderChips(){
    const cur = findBook($('#book').value);
    $('#chips').innerHTML = state.books.slice(0,6).map((b,i) =>
      `<button type="button" class="chip" data-i="${i}" aria-pressed="${!!cur && cur.title===b.title}">${esc(b.title)}</button>`).join('');
    $('#chips').querySelectorAll('.chip').forEach(el => el.onclick = () => pickBook(state.books[+el.dataset.i]));
  }
  $('#book').value = store.get('lastBook','');
  $('#book').addEventListener('input', () => { updateTitleHint(); renderChips(); scheduleLookup(); });
  $('#author').addEventListener('input', () => { if($('#author').value.trim()) hideLookup(); });
  $('#book').addEventListener('change', () => { updateTitleHint(); renderChips(); });

  /* ── 표지로 제목 인식 ── */
  $('#btnCover').onclick = () => { if(!loggedIn()){ openSettings(); return; } $('#fileCover').click(); };
  $('#fileCover').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if(!f) return;
    const btn = $('#btnCover'); btn.disabled = true;
    const h = $('#titleHint'); h.className = 'titlehint'; h.textContent = '표지 읽는 중…';
    try{
      const img = await loadImage(await toBase(f));
      const s = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth*s); c.height = Math.round(img.naturalHeight*s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const r = await call('cover', { image: { data: c.toDataURL('image/jpeg', .85).split(',')[1], mimeType:'image/jpeg' } });
      $('#book').value = r.title;
      if(r.author) $('#author').value = r.author;
      updateTitleHint(); renderChips(); scheduleLookup();
      if(!findBook(r.title)) h.textContent = `「${r.title}」${r.subtitle ? ' (부제: '+r.subtitle+')' : ''} 새 책으로 등록됩니다. 맞는지 확인해 주세요.`;
    }catch(err){ h.className = 'titlehint'; h.textContent = err.message; }
    finally{ btn.disabled = false; }
  };

  /* ── 저장 ── */
  function setStatus(msg, err){ const s = $('#status'); s.textContent = msg||''; s.className = 'status'+(err?' err':''); }

  $('#btnSave').onclick = async () => {
    if(state.saving) return;
    stopMic();
    const matched = findBook($('#book').value);
    const book = matched ? matched.title : cleanTitle($('#book').value);
    const memo = $('#memo').value.trim();
    if(!book){ setStatus('책 제목을 입력하세요.', true); $('#book').focus(); return; }
    if(!state.photos.length && !memo){ setStatus('사진을 찍거나 생각을 적어야 저장됩니다.', true); return; }
    if(!loggedIn()){ openSettings(); return; }

    state.saving = true; $('#btnSave').disabled = true;
    try{
      setStatus('사진 정리 중…');
      const images = [];
      for(const p of state.photos){
        const out = await renderOut(p);
        images.push({ data: out.split(',')[1], mimeType:'image/jpeg', cropped: !!p.crop });
      }
      setStatus(images.length ? `사진 ${images.length}장 올리고 글자 읽는 중… (10~40초)` : '저장 중…');
      const r = await call('save', { book, author:$('#author').value.trim(), page:$('#page').value.trim(), memo, mode: state.mode, images });
      store.set('lastBook', book);
      $('#result').innerHTML = `<div class="done"><div class="head">No.${esc(r.no)} 저장했습니다</div>${noteHtml(Object.assign({ memo }, r))}</div>`;
      state.photos = []; renderThumbs();
      $('#memo').value = ''; $('#page').value = '';
      setStatus('');
      window.scrollTo({ top:0, behavior:'smooth' });
      refreshBooks();
    }catch(e){
      setStatus(e.message, true);
    }finally{
      state.saving = false; $('#btnSave').disabled = false;
    }
  };

  /* ── 노트 표시 ── */
  const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // 구글 문서·드라이브 링크만 허용 (javascript: 등 차단)
  const safeLink = u => /^https:\/\/(docs|drive)\.google\.com\/[^\s"'<>]*$/.test(String(u||'')) ? String(u) : '';
  const safeImg = u => /^https:\/\/[^\s"'<>]+$/.test(String(u||'')) ? String(u) : '';
  function noteHtml(n){
    const quotes = (n.quotes||[]).filter(Boolean);
    const kws = (n.keywords||[]).filter(k => k && k.word);
    const tags = (n.tags||[]).filter(Boolean);
    const photos = (n.photoUrls||[]).filter(Boolean);
    return `<article class="note">
      <div class="meta"><span>${n.no?`<span class="no">No.${esc(n.no)}</span>&nbsp; `:''}${esc(n.date)}${n.page?' · p.'+esc(n.page):''}</span><span>${esc(n.mode||'')}</span></div>
      <h3>${esc(n.book)}${n.author?`<small>${esc(n.author)}</small>`:''}</h3>
      ${n.text?`<div class="sec">캡처 내용</div><div class="capture">${esc(n.text)}</div>`:''}
      ${n.summary?`<div class="sec">요약</div><p class="summary">${esc(n.summary)}</p>`:''}
      ${quotes.length?`<ul class="quotes">${quotes.map(q=>`<li><span>${esc(q)}</span></li>`).join('')}</ul>`:''}
      ${kws.length?`<div class="sec">주요 단어</div><dl class="kw">${kws.map(k=>`<dt>${esc(k.word)}</dt><dd>${esc(k.meaning)}</dd>`).join('')}</dl>`:''}
      ${n.memo?`<div class="sec">내 생각</div><div class="memo">${esc(n.memo)}</div>`:''}
      ${tags.length?`<div class="tags">${tags.map(t=>`<span>#${esc(t)}</span>`).join('')}</div>`:''}
      <div class="links">
        ${safeLink(n.masterUrl)?`<a href="${esc(safeLink(n.masterUrl))}" target="_blank" rel="noopener noreferrer">전체 기록 문서</a>`:''}
        ${safeLink(n.docUrl)?`<a href="${esc(safeLink(n.docUrl))}" target="_blank" rel="noopener noreferrer">책별 정리 문서</a>`:''}
        ${photos.map(safeLink).filter(Boolean).map((u,i)=>`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">사진 ${i+1}</a>`).join('')}
      </div>
      ${n.notice?`<div class="notice">${esc(n.notice)}</div>`:''}
      ${n.warning?`<div class="warn">${esc(n.warning)}</div>`:''}
    </article>`;
  }

  /* ── 모아보기 ── */
  async function loadList(){
    const box = $('#notes');
    if(!loggedIn()){ box.innerHTML = '<div class="empty">설정에서 로그인하면 기록이 여기에 모입니다.</div>'; return; }
    box.innerHTML = '<div class="empty">불러오는 중…</div>';
    try{
      const r = await call('list', { book: state.filter, limit: 50 });
      setBooks(r.books); renderShelf();
      const ml = $('#masterLink');
      if(safeLink(r.masterUrl)){ ml.href = safeLink(r.masterUrl); ml.classList.remove('hidden'); }
      box.innerHTML = r.notes.length ? r.notes.map(noteHtml).join('')
        : '<div class="empty">아직 기록이 없습니다. 읽던 페이지를 찍어 첫 노트를 남겨 보세요.</div>';
    }catch(e){ box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  function setBooks(books){
    state.books = books || [];
    $('#bookList').innerHTML = state.books.map(b => `<option value="${esc(b.title)}">`).join('');
    renderChips(); updateTitleHint();
  }
  async function refreshBooks(){
    if(!loggedIn()) return;
    try{ const r = await call('list', { limit: 1 }); setBooks(r.books); }catch(e){}
  }
  function renderShelf(){
    const all = [{ title:'', label:'전체', count: state.books.reduce((a,b)=>a+b.count,0) }]
      .concat(state.books.map(b => ({ title:b.title, label:b.title, count:b.count })));
    $('#shelf').innerHTML = all.map(b =>
      `<button class="spine" type="button" aria-pressed="${state.filter===b.title}" data-t="${esc(b.title)}"><b>${esc(b.label)}</b><i>${b.count}개 기록</i></button>`).join('');
    $('#shelf').querySelectorAll('.spine').forEach(el => el.onclick = () => { state.filter = el.dataset.t; loadList(); });
  }

  renderLoginBanner();
  (async () => {
    try{
      if(!loggedIn() || !(await getKey())) setTimeout(openSettings, 300); else refreshBooks();
    }catch(e){ setStatus('시작 오류: ' + e.message, true); }
  })();
})();
