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
  const state = { photos:[], books:[], saving:false, filter:'', mode: store.get('mode','all'), notes:{} };

  $('#today').textContent = new Date().toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'short'});

  /* ── 보안: 로그인 · 요청 서명 (공용 모듈 outbox.js) ── */
  if(!window.RN){
    // outbox.js가 GitHub에 없거나 이름이 다를 때: 원인을 바로 알려 줌
    const st = document.getElementById('status');
    st.textContent = '필요한 파일 outbox.js를 찾지 못했습니다. GitHub 저장소에 outbox.js와 sw.js가 있는지 확인해 주세요.';
    st.className = 'status err';
    document.getElementById('btnSave').disabled = true;
    return;
  }
  const RN = window.RN;
  const GAS_URL_RE = RN.GAS_URL_RE;
  const getKey = () => RN.getKey();
  const loggedIn = () => !!(store.get('url','') && store.get('dev',''));
  const post = RN.post;
  async function clearLocalAuth(){
    store.del('dev'); store.del('devName');
    await RN.clearAuth();
    try{ renderLoginBanner(); }catch(e){}
  }
  const SERVER_VERSION = '2026-10-03c';   // 이 앱이 기대하는 서버(Code.gs) 버전
  async function call(action, params){
    try{ return await RN.call(action, params); }
    catch(e){
      if(e.code === 'auth'){ await clearLocalAuth(); needLogin(); }
      // 서버(Code.gs)가 옛 버전이라 새 기능을 모를 때: 무엇을 해야 하는지 알려 줌
      if(e.code === 'unknown' || /알 수 없는 요청/.test(e.message)){
        const x = new Error('서버(Apps Script)가 아직 옛 버전입니다. 편집기에서 최신 Code.gs로 바꾼 뒤 [배포 → 배포 관리 → 연필 → 버전: 새 버전 → 배포]를 해 주세요.');
        x.code = 'oldserver'; throw x;
      }
      throw e;
    }
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
      const persisted = await RN.setAuth(r.token, url, r.deviceId);
      store.set('url', url); store.set('dev', r.deviceId); store.set('devName', r.name);
      await RN.resetNeedLogin(); flushQueue();
      setCfgStatus(persisted ? '로그인됐습니다.' : '로그인됐습니다. 이 브라우저는 키를 저장할 수 없어 앱을 닫으면 다시 로그인해야 합니다.');
      $('#loginForm').classList.add('hidden'); $('#devPanel').classList.remove('hidden');
      loadDevices(); refreshBooks(); renderLoginBanner();
    }catch(e){ setCfgStatus(e.message, true); }
    finally{ btn.disabled = false; }
  };

  /* ── 서버 업데이트 (드라이브 폴더의 새 코드 적용) ── */
  function setUpd(msg, err){ const s = $('#updStatus'); s.textContent = msg || ''; s.className = 'status' + (err ? ' err' : ''); }
  async function loadUpdateInfo(){
    const box = $('#updInfo');
    box.textContent = '업데이트 폴더 확인 중…';
    try{
      const r = await call('updinfo', {});
      const lines = [];
      lines.push(r.code ? `새 코드: ${r.code.name} (${r.code.updated} 올림)` : '폴더에 새 Code.gs가 없습니다.');
      if(r.manifest) lines.push(`설정 파일: ${r.manifest.name} (${r.manifest.updated})`);
      if(r.last) lines.push(`마지막 업데이트: ${r.last}${r.current ? ' · 버전 ' + r.current : ''}`);
      box.innerHTML = lines.map(esc).join('<br>');
      $('#updApply').disabled = !r.code;
      $('#updRollback').disabled = !r.canRollback;
    }catch(e){
      box.textContent = e.code === 'server' || /알 수 없는 요청/.test(e.message)
        ? '서버가 아직 이 기능을 모릅니다. 처음 한 번은 PC에서 Code.gs를 바꿔야 합니다.'
        : e.message;
      $('#updApply').disabled = true; $('#updRollback').disabled = true;
    }
  }
  $('#updCheck').onclick = loadUpdateInfo;
  $('#updApply').onclick = async () => {
    const pw = $('#updPw').value;
    if(!pw){ setUpd('비밀번호를 입력하세요.', true); return; }
    if(!confirm('드라이브 업데이트 폴더의 코드로 서버를 바꿀까요? 문제가 생기면 [되돌리기]로 복구할 수 있습니다.')) return;
    const b = $('#updApply'); b.disabled = true; setUpd('적용 중… (20~40초)');
    try{
      const r = await call('selfupdate', { password: pw });
      $('#updPw').value = '';
      setUpd(`업데이트했습니다. 버전 ${r.previous} → ${r.version}${r.notice ? ' · ' + r.notice : ''}`);
      setTimeout(loadUpdateInfo, 1500);
    }catch(e){ setUpd(e.message, true); }
    finally{ b.disabled = false; }
  };
  $('#updRollback').onclick = async () => {
    const pw = $('#updPw').value;
    if(!pw){ setUpd('비밀번호를 입력하세요.', true); return; }
    if(!confirm('서버를 바로 전 버전으로 되돌릴까요?')) return;
    const b = $('#updRollback'); b.disabled = true; setUpd('되돌리는 중…');
    try{
      const r = await call('rollback', { password: pw });
      $('#updPw').value = '';
      setUpd(`되돌렸습니다. 지금 버전 ${r.version}`);
      setTimeout(loadUpdateInfo, 1500);
    }catch(e){ setUpd(e.message, true); b.disabled = false; }
  };

  async function loadDevices(){
    loadUpdateInfo();
    const box = $('#devList'); box.innerHTML = '<div class="hint">기기 목록 불러오는 중…</div>';
    try{
      const r = await call('ping', {}).then(p => call('devices', {}).then(d => Object.assign(d, { gemini: p.gemini, version: p.version })));
      const ver = r.version || '';
      $('#devInfo').innerHTML = esc(r.gemini ? 'AI 정리 사용 중' : '글자 추출만 사용 중 (Gemini 키 없음)') + '<br>' +
        (ver === SERVER_VERSION ? esc('서버 버전 ' + ver + ' · 최신')
          : `<span class="q-err">${esc('서버 버전 ' + (ver || '확인 안 됨') + ' · 업데이트 필요 (앱은 ' + SERVER_VERSION + '용)')}</span>`);
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
    ['write','list','wish'].forEach(x => $('#tab-'+x).classList.toggle('hidden', t!==x));
    $('#savebar').classList.toggle('hidden', t!=='write');
    if(t!=='write') stopMic();
    if(t==='list') loadList();
    if(t==='wish') loadWish();
    window.scrollTo(0, 0);
  });
  const switchTab = name => $(`nav button[data-tab="${name}"]`).click();

  /* ── 읽기 방식 ── */
  function renderMode(){ document.querySelectorAll('#modeSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode===state.mode)); }
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => { state.mode = b.dataset.mode; store.set('mode', state.mode); renderMode(); });
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
  let rec = null, listening = false;
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
  // 안드로이드 Chrome은 연속 듣기 모드에서 같은 말을 누적해서 여러 번 '확정'으로 보내는 문제가 있음
  // → 안드로이드는 한 문장씩 듣고 자동으로 다시 시작, 모든 기기에서 겹치는 결과는 합쳐서 한 번만 적음
  const isAndroid = /Android/i.test(navigator.userAgent);
  let userStop = false, committed = '', silentRounds = 0;
  const joinText = (a, b) => b ? (a ? a + ' ' + b : b) : a;

  // 결과 목록 전체를 매번 새로 계산 (앞 결과를 포함하는 더 긴 결과가 오면 교체)
  function mergeResults(results){
    const finals = []; let interim = '';
    for(let i = 0; i < results.length; i++){
      const t = results[i][0].transcript.replace(/\s+/g, ' ').trim();
      if(!t) continue;
      if(results[i].isFinal){
        const last = finals[finals.length - 1];
        if(last && t.startsWith(last)) finals[finals.length - 1] = t;
        else if(last && last.startsWith(t)) { /* 이미 적은 말의 앞부분 → 무시 */ }
        else finals.push(t);
      } else {
        interim = t;
      }
    }
    const fin = finals.join(' ');
    const lastFin = finals[finals.length - 1] || '';
    if(interim && fin && interim.startsWith(fin)) interim = interim.slice(fin.length).trim();
    else if(interim && lastFin && interim.startsWith(lastFin)) interim = interim.slice(lastFin.length).trim();
    return { fin, interim };
  }

  function startMic(){
    const memo = $('#memo');
    userStop = false; silentRounds = 0;
    committed = memo.value.replace(/\s+$/, '');
    memo.readOnly = true; // 듣는 동안 직접 입력과 섞이지 않게
    listening = true; setMicUI(true); setStatus('');
    startSession();
  }

  function startSession(){
    const memo = $('#memo');
    let sessionText = '';
    rec = new SR();
    rec.lang = 'ko-KR'; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.continuous = !isAndroid;
    rec.onresult = ev => {
      const m = mergeResults(ev.results);
      sessionText = m.fin;
      memo.value = joinText(committed, sessionText);
      $('#interim').textContent = m.interim;
    };
    rec.onerror = ev => {
      if(ev.error === 'not-allowed' || ev.error === 'service-not-allowed'){
        userStop = true;
        setStatus('마이크 권한을 허용해 주세요. 브라우저 설정에서 바꿀 수 있습니다.', true);
      } else if(ev.error !== 'no-speech' && ev.error !== 'aborted'){
        setStatus('음성 인식 오류: ' + ev.error, true);
      }
    };
    rec.onend = () => {
      committed = joinText(committed, sessionText);
      memo.value = committed;
      $('#interim').textContent = '';
      silentRounds = sessionText ? 0 : silentRounds + 1;
      // 안드로이드: 사용자가 멈출 때까지 자동으로 이어 듣기 (조용한 상태가 3번 이어지면 자동 종료)
      if(isAndroid && !userStop && silentRounds < 3){
        try{ startSession(); return; }catch(e){}
      }
      listening = false; memo.readOnly = false; setMicUI(false);
    };
    try{ rec.start(); }
    catch(e){ listening = false; memo.readOnly = false; setMicUI(false); setStatus('마이크를 시작하지 못했습니다. 잠시 후 다시 눌러 주세요.', true); }
  }

  function stopMic(){
    userStop = true;
    if(rec && listening){ try{ rec.stop(); }catch(e){} }
  }
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
  // 책 검색 공용: 결과 상자에 후보를 보여 주고, 고르면 onPick(item)
  const lookupSeqs = {};
  const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  async function bookSearch(box, q, onPick){
    const key = box.id, seq = (lookupSeqs[key] = (lookupSeqs[key] || 0) + 1);
    const close = () => { box.classList.add('hidden'); box.innerHTML = ''; };
    box.innerHTML = '<div class="lh"><span>책 찾는 중…</span></div>'; box.classList.remove('hidden');
    try{
      const r = await call('lookup', { q });
      if(seq !== lookupSeqs[key]) return;
      if(!r.items || !r.items.length){
        box.innerHTML = `<div class="lh"><span>${esc(r.error || '검색 결과가 없습니다. 저자를 직접 입력해 주세요.')}</span><button type="button" data-x>닫기</button></div>`;
      }else{
        box.innerHTML = `<div class="lh"><span>이 책인가요? 누르면 제목과 저자가 채워집니다</span><button type="button" data-x>닫기</button></div>` +
          r.items.map((it,i) => `<button type="button" class="cand" data-i="${i}">
            ${safeImg(it.thumbnail) ? `<img src="${esc(safeImg(it.thumbnail))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="noimg"></div>'}
            <div><b>${esc(it.fullTitle || it.title)}</b><span>${esc(it.authors || '저자 정보 없음')}${it.translators ? ' · 옮긴이 '+esc(it.translators) : ''}</span><span>${esc([it.publisher, it.year].filter(Boolean).join(' · '))}</span></div>
          </button>`).join('');
        box.querySelectorAll('.cand').forEach(el => el.onclick = () => { onPick(r.items[+el.dataset.i]); close(); });
      }
    }catch(e){
      if(seq !== lookupSeqs[key]) return;
      box.innerHTML = `<div class="lh"><span>${esc('검색하지 못했습니다: ' + e.message)}</span><button type="button" data-x>닫기</button></div>`;
    }
    const x = box.querySelector('[data-x]'); if(x) x.onclick = close;
  }

  function runLookup(t){
    lastQuery = t;
    return bookSearch($('#lookup'), t, it => {
      $('#book').value = it.title; $('#author').value = it.authors; lastQuery = it.title;
      updateTitleHint(); renderChips();
    });
  }
  // 🔍 버튼 또는 키보드 '완료/엔터': 저자칸이 차 있어도 바로 검색
  function manualLookup(){
    const t = cleanTitle($('#book').value);
    if(t.length < 2){ setStatus('책 제목을 2글자 이상 적어 주세요.', true); return; }
    if(!loggedIn()){ openSettings(); return; }
    clearTimeout(lookupTimer); runLookup(t);
  }
  $('#btnFind').innerHTML = SEARCH_ICON;
  $('#btnFind').onclick = manualLookup;
  $('#book').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); manualLookup(); } });

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

  const canBgSync = 'serviceWorker' in navigator && 'SyncManager' in window;

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
      setStatus('사진 준비 중… 잠깐만 기다려 주세요');
      const images = [];
      for(const p of state.photos){
        const out = await renderOut(p);
        images.push({ data: out.split(',')[1], mimeType:'image/jpeg', cropped: !!p.crop, dhash: await dHash(out) });
      }
      // 먼저 휴대폰 안 대기열에 넣고 → 화면은 바로 비움 → 보내기는 뒤에서 진행
      await RN.enqueue({ book, author:$('#author').value.trim(), page:$('#page').value.trim(), memo, mode: state.mode, images });
      store.set('lastBook', book);
      state.photos = []; renderThumbs();
      $('#memo').value = ''; $('#page').value = '';
      setStatus(canBgSync
        ? '저장 대기열에 넣었습니다. 이제 창을 닫아도 뒤에서 끝까지 올립니다.'
        : '저장 대기열에 넣었습니다. 올라가는 동안 창을 열어 두면 가장 빠릅니다. 닫아도 다음에 열 때 이어서 올립니다.');
      await renderQueue();
      requestBgSync();
      flushQueue();
    }catch(e){
      setStatus('대기열에 넣지 못했습니다: ' + e.message, true);
    }finally{
      state.saving = false; $('#btnSave').disabled = false;
    }
  };

  /* ── 저장 대기열 화면 ── */
  const STATUS_LABEL = { pending:'대기 중', sending:'올리는 중…', done:'저장 완료', failed:'실패', needLogin:'로그인 필요' };
  let flushing = false, shownDone = new Set();

  async function renderQueue(){
    const items = (await RN.list()).filter(it => !(it.status === 'done' && it.seen));
    const box = $('#queue');
    if(!items.length){ box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const waiting = items.filter(it => it.status !== 'done' && it.status !== 'failed').length;
    box.innerHTML = `<div class="q-head">${waiting ? `보낼 기록 ${waiting}건` : '보내기 완료'}</div>` + items.map(it => `
      <div class="q-row q-${esc(it.status)}" data-cid="${esc(it.cid)}">
        <div class="q-main"><b>${esc(it.label.book || '제목 없음')}</b><span>${it.label.page ? 'p.'+esc(it.label.page)+' · ' : ''}사진 ${esc(it.label.photos)}장 · ${esc(new Date(it.created).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}))}</span>
          ${it.error && it.status !== 'done' ? `<span class="q-err">${esc(it.error)}</span>` : ''}</div>
        <div class="q-side"><em>${esc(it.status === 'done' && it.result ? (it.result.skipped ? '중복이라 건너뜀' : 'No.'+it.result.no+' 저장') : STATUS_LABEL[it.status] || it.status)}</em>
          ${it.status === 'failed' || it.status === 'pending' ? `<button type="button" class="linkbtn q-retry">다시 보내기</button>` : ''}
          ${it.status === 'failed' ? `<button type="button" class="linkbtn q-del">삭제</button>` : ''}
          ${it.status === 'done' ? `<button type="button" class="linkbtn q-ok">확인</button>` : ''}</div>
      </div>`).join('');
    box.querySelectorAll('.q-retry').forEach(b => b.onclick = async () => {
      const it = await RN.getItem(b.closest('.q-row').dataset.cid);
      if(it){ it.status = 'pending'; it.error = ''; await RN.putItem(it); }
      await renderQueue(); flushQueue();
    });
    box.querySelectorAll('.q-del').forEach(b => b.onclick = async () => {
      if(!confirm('이 기록을 대기열에서 지울까요? 아직 구글에 저장되지 않은 기록입니다.')) return;
      await RN.removeItem(b.closest('.q-row').dataset.cid); renderQueue();
    });
    box.querySelectorAll('.q-ok').forEach(b => b.onclick = async () => {
      const it = await RN.getItem(b.closest('.q-row').dataset.cid);
      if(it){ it.seen = true; await RN.putItem(it); }
      renderQueue();
    });
    // 새로 완료된 기록은 결과 카드로 보여 주고, 대기열 목록에서는 정리
    let changed = false;
    for(const it of items){
      if(it.status === 'done' && it.result && !shownDone.has(it.cid)){
        shownDone.add(it.cid);
        it.seen = true; await RN.putItem(it); changed = true;
        const r = it.result;
        if(r.skipped){
          $('#result').innerHTML = skippedHtml(r, it.cid);
        }else{
          const saved = Object.assign({ memo: r.memo }, r);
          if(r.id) state.notes[r.id] = saved;
          $('#result').innerHTML = `<div class="done"><div class="head">No.${esc(r.no)} 저장했습니다</div>${noteHtml(saved)}</div>`;
        }
        refreshBooks();
      }
    }
    if(changed) setTimeout(renderQueue, 1500);
  }

  /* ── 중복으로 건너뛴 기록 ── */
  function skippedHtml(r, cid){
    return `<div class="done skip"><div class="head">중복이라 새로 저장하지 않았습니다</div>
      <article class="note">
        <p class="summary">${esc(r.notice)}</p>
        ${r.text ? `<div class="sec">이번에 읽은 내용</div><div class="capture">${esc(r.text)}</div>` : ''}
        <div class="links">
          ${r.dupNo ? `<button type="button" class="linkbtn show-dup" data-book="${esc(r.book || '')}">No.${esc(r.dupNo)} 보러 가기</button>` : ''}
          <button type="button" class="linkbtn force-save" data-cid="${esc(cid)}">그래도 따로 저장</button>
        </div>
      </article></div>`;
  }
  document.addEventListener('click', async e => {
    const f = e.target.closest && e.target.closest('.force-save');
    if(f){
      const it = await RN.getItem(f.dataset.cid);
      if(!it || !it.params){ alert('원래 사진이 남아 있지 않습니다. 다시 찍어 저장해 주세요.'); return; }
      const p = Object.assign({}, it.params, { force: true }); delete p.cid;
      await RN.enqueue(p); await RN.removeItem(it.cid);
      $('#result').innerHTML = ''; setStatus('중복 확인 없이 따로 저장합니다.');
      await renderQueue(); requestBgSync(); flushQueue();
      return;
    }
    const d = e.target.closest && e.target.closest('.show-dup');
    if(d){ state.filter = d.dataset.book || ''; switchTab('list'); }
  });

  // 사진 지각 해시(16×16 밝기 차이, 256비트): 같은 사진을 다시 저장·압축한 경우를 알아봄
  async function dHash(dataUrl){
    try{
      const img = await loadImage(dataUrl);
      const W = 17, H = 16, c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data, g = [];
      for(let i = 0; i < W * H; i++) g.push(d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114);
      let bits = '', hexs = '';
      for(let y = 0; y < H; y++) for(let x = 0; x < 16; x++) bits += g[y*W + x] > g[y*W + x + 1] ? '1' : '0';
      for(let i = 0; i < 256; i += 4) hexs += parseInt(bits.slice(i, i + 4), 2).toString(16);
      return hexs;
    }catch(e){ return ''; }
  }

  async function flushQueue(){
    if(flushing || !loggedIn()) return;
    flushing = true;
    try{ await RN.flush(() => renderQueue()); }
    catch(e){}
    finally{ flushing = false; renderQueue(); }
  }

  async function requestBgSync(){
    if(!canBgSync) return;
    try{ const reg = await navigator.serviceWorker.ready; await reg.sync.register('rn-outbox'); }catch(e){}
  }

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js?v=14').catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => { if(e.data && e.data.type === 'outbox-updated') renderQueue(); });
  }
  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState !== 'visible') return;
    renderQueue(); flushQueue();
    // 드라이브 앱에서 고치고 돌아온 경우: 보고 있던 모아보기를 새로 불러와 반영
    if(!$('#tab-list').classList.contains('hidden') && !document.querySelector('#notes .editing')) loadList();
  });
  setInterval(async () => { if(document.visibilityState === 'visible' && await RN.hasUnsent()) flushQueue(); }, 30000);
  // 백그라운드 전송이 안 되는 브라우저에서 아직 보낼 게 남았으면 닫기 전에 한 번 묻기
  window.addEventListener('beforeunload', e => {
    if(canBgSync) return;
    const q = document.querySelector('#queue .q-pending, #queue .q-sending');
    if(q){ e.preventDefault(); e.returnValue = ''; }
  });

  /* ── 노트 표시 ── */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // 구글 문서·드라이브 링크만 허용 (javascript:, 피싱 주소 등 차단)
  const safeLink = u => /^https:\/\/(docs|drive)\.google\.com\/[^\s"'<>]*$/.test(String(u || '')) ? String(u) : '';
  const safeImg = u => /^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : '';
  function noteHtml(n){
    const quotes = (n.quotes||[]).filter(Boolean);
    const kws = (n.keywords||[]).filter(k => k && k.word);
    const tags = (n.tags||[]).filter(Boolean);
    const photos = (n.photoUrls||[]).filter(Boolean);
    return `<article class="note"${n.id ? ` data-id="${esc(n.id)}"` : ''}>
      <div class="meta"><span>${n.no?`<span class="no">No.${esc(n.no)}</span>&nbsp; `:''}${esc(n.date)}${n.page?' · p.'+esc(n.page):''}</span><span>${esc(n.mode||'')}</span></div>
      <h3>${esc(n.book)}${n.author?`<small>${esc(n.author)}</small>`:''}</h3>
      ${n.text?`<div class="sec">캡처 내용</div><div class="capture">${esc(n.text)}</div>`:''}
      ${n.summary?`<div class="sec">요약</div><p class="summary">${esc(n.summary)}</p>`:''}
      ${quotes.length?`<ul class="quotes">${quotes.map(q=>`<li><span>${esc(q)}</span></li>`).join('')}</ul>`:''}
      ${kws.length?`<div class="sec">주요 단어</div><dl class="kw">${kws.map(k=>`<dt>${esc(k.word)}</dt><dd>${esc(k.meaning)}</dd>`).join('')}</dl>`:''}
      ${n.memo?`<div class="sec">내 생각</div><div class="memo">${esc(n.memo)}</div>`:''}
      ${tags.length?`<div class="tags">${tags.map(t=>`<span>#${esc(t)}</span>`).join('')}</div>`:''}
      <div class="links">
        ${n.id ? `<button type="button" class="linkbtn edit-note" data-id="${esc(n.id)}">✎ 편집</button>` : ''}
        ${safeLink(n.masterUrl)?`<a href="${esc(safeLink(n.masterUrl))}" target="_blank" rel="noopener noreferrer">전체 기록 문서</a>`:''}
        ${safeLink(n.docUrl)?`<a href="${esc(safeLink(n.docUrl))}" target="_blank" rel="noopener noreferrer">책별 정리 문서</a>`:''}
        ${photos.map(safeLink).filter(Boolean).map((u,i)=>`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">사진 ${i+1}</a>`).join('')}
      </div>
      ${n.notice?`<div class="notice">${esc(n.notice)}</div>`:''}
      ${n.edited?`<div class="edited">${esc(n.edited)} 수정됨</div>`:''}
      ${n.warning?`<div class="warn">${esc(n.warning)}</div>`:''}
    </article>`;
  }

  /* ── 기록 편집 ── */
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.edit-note');
    if(b) openEdit(b.closest('article'), b.dataset.id);
  });

  function openEdit(art, id){
    const n = state.notes[id];
    if(!art || !n) return;
    art.classList.add('editing');
    art.innerHTML = `
      <div class="meta"><span>${n.no?`<span class="no">No.${esc(n.no)}</span>&nbsp; `:''}${esc(n.date)}</span><span>편집 중</span></div>
      <div class="field"><label class="f">책 제목 <small>바꾸면 그 책으로 옮겨집니다</small></label><input type="text" class="e-book book" list="bookList" maxlength="100" autocomplete="off"></div>
      <div class="field"><label class="f">페이지</label><input type="text" class="e-page" inputmode="numeric" maxlength="20"></div>
      <div class="field"><label class="f">캡처 내용 <small>잘못 읽힌 글자를 고치거나 필요 없는 부분을 지우세요</small></label><textarea class="e-text"></textarea></div>
      <div class="field"><label class="f">내 생각</label><textarea class="e-memo" maxlength="5000"></textarea></div>
      <label class="chk"><input type="checkbox" class="e-regen"> 고친 내용으로 요약·주요 단어 다시 만들기</label>
      <div class="status e-status"></div>
      <div class="edit-actions">
        <button type="button" class="btn danger e-del">삭제</button>
        <span class="grow"></span>
        <button type="button" class="btn e-cancel">취소</button>
        <button type="button" class="btn primary e-save">수정 저장</button>
      </div>`;
    // 값은 innerHTML이 아니라 value로 넣어 특수문자·줄바꿈을 그대로 유지
    art.querySelector('.e-page').value = n.page || '';
    art.querySelector('.e-book').value = n.book || '';
    art.querySelector('.e-text').value = n.text || '';
    art.querySelector('.e-memo').value = n.memo || '';
    const ta = art.querySelector('.e-text');
    ta.style.height = Math.min(480, Math.max(180, ta.scrollHeight + 4)) + 'px';
    art.scrollIntoView({ behavior:'smooth', block:'start' });

    const restore = note => {
      const wrap = document.createElement('div');
      wrap.innerHTML = noteHtml(note);
      art.replaceWith(wrap.firstElementChild);
    };
    art.querySelector('.e-cancel').onclick = () => restore(n);
    art.querySelector('.e-del').onclick = async () => {
      const label = n.no ? 'No.' + n.no : '이 기록';
      if(!confirm(`${label}을(를) 삭제할까요?\n\n시트·전체 기록 문서·책별 문서에서 함께 지워지고, 사진은 드라이브 휴지통으로 갑니다(30일 안에 복구 가능). 지운 내용은 시트의 '삭제된 기록'에 보관됩니다.`)) return;
      const st = art.querySelector('.e-status');
      art.querySelectorAll('button').forEach(b => b.disabled = true);
      st.className = 'status e-status'; st.textContent = '삭제 중…';
      try{
        const r = await call('delete', { id });
        delete state.notes[id];
        const msg = document.createElement('div');
        msg.className = 'notice deleted-msg';
        msg.textContent = `${label} 기록을 삭제했습니다.` + (r.trashedPhotos ? ` 사진 ${r.trashedPhotos}장은 휴지통으로 옮겼습니다.` : '') + (r.warning ? ` (${r.warning})` : '');
        art.replaceWith(msg);
        setTimeout(() => msg.remove(), 6000);
        refreshBooks();
      }catch(e){
        st.className = 'status e-status err'; st.textContent = e.message;
        art.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    };
    art.querySelector('.e-save').onclick = async () => {
      const btn = art.querySelector('.e-save'), st = art.querySelector('.e-status');
      const regen = art.querySelector('.e-regen').checked;
      btn.disabled = true; st.className = 'status e-status';
      st.textContent = regen ? '저장하고 요약 다시 만드는 중… (10~20초)' : '저장 중…';
      // 오래 걸리면 지금 무엇을 하는지 알려 줌
      const slow = setTimeout(() => { st.textContent = '시트와 문서 두 곳을 고치는 중… 조금만 기다려 주세요.'; }, 6000);
      const slower = setTimeout(() => { st.textContent = '다른 저장이 끝나길 기다리는 중일 수 있습니다. 창을 닫지 말고 기다려 주세요.'; }, 20000);
      try{
        const title = cleanTitle(art.querySelector('.e-book').value);
        if(!title){ throw new Error('책 제목은 비워 둘 수 없습니다.'); }
        const r = await call('update', {
          id, title, page: art.querySelector('.e-page').value.trim(),
          text: art.querySelector('.e-text').value, memo: art.querySelector('.e-memo').value.trim(), regen
        });
        const updated = Object.assign({}, n, r.note, { warning: r.warning || '',
          notice: r.movedTo ? `「${r.movedTo}」(으)로 옮겼습니다. 시트와 문서에도 반영했습니다.` : '수정 내용을 시트와 문서에 반영했습니다.' });
        if(r.movedTo) refreshBooks().then(() => { if(!$('#tab-list').classList.contains('hidden')) renderShelf(); });
        state.notes[id] = Object.assign({}, updated, { warning:'', notice:'' });
        restore(updated);
      }catch(e){
        st.className = 'status e-status err';
        st.textContent = e.code === 'busy' ? e.message : '수정하지 못했습니다: ' + e.message + ' — 고친 내용은 그대로 있으니 다시 눌러 주세요.';
        btn.disabled = false;
      }finally{
        clearTimeout(slow); clearTimeout(slower);
      }
    };
  }

  /* ── 읽을 책 (추천도서 메모) ── */
  state.wish = { items: [], filter: 'todo', loaded: false };
  const wSet = (msg, err) => { const s = $('#wStatus'); s.textContent = msg || ''; s.className = 'status' + (err ? ' err' : ''); };

  // 기록하기 화면에서 바로 메모: 지금 읽는 책·페이지를 '추천받은 곳'으로 채움
  $('#btnWishHere').onclick = () => {
    const from = cleanTitle($('#book').value), page = $('#page').value.trim();
    switchTab('wish');
    if(from) $('#wFrom').value = from;
    if(page) $('#wFromPage').value = page;
    setTimeout(() => $('#wTitle').focus(), 50);
  };

  async function loadWish(){
    if(!loggedIn()){ $('#wishList').innerHTML = '<div class="empty">설정에서 로그인하면 목록이 보입니다.</div>'; return; }
    if(!state.wish.loaded) $('#wishList').innerHTML = '<div class="empty">불러오는 중…</div>';
    try{
      const r = await call('wishlist', {});
      state.wish.items = r.items; state.wish.loaded = true; renderWish();
    }catch(e){ $('#wishList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  function renderWish(){
    const all = state.wish.items, f = state.wish.filter;
    const todo = all.filter(i => !i.read), done = all.filter(i => i.read);
    $('#wishFilter').querySelector('[data-f="todo"]').textContent = `읽을 책 ${todo.length}`;
    $('#wishFilter').querySelector('[data-f="done"]').textContent = `읽은 책 ${done.length}`;
    $('#wishFilter').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.f === f));
    const list = f === 'done' ? done : todo;
    $('#wishList').innerHTML = list.length ? list.map(i => `
      <div class="wish${i.read ? ' is-read' : ''}" data-id="${esc(i.id)}">
        <label class="wcheck" aria-label="${esc(i.title)} 읽음 표시"><input type="checkbox" ${i.read ? 'checked' : ''}><span></span></label>
        <div class="wbody">
          <b>${esc(i.title)}</b>
          ${i.author ? `<span>${esc(i.author)}</span>` : ''}
          ${i.from ? `<span class="wfrom">「${esc(i.from)}」${i.fromPage ? ' p.' + esc(i.fromPage) : ''}에서 추천</span>` : ''}
          ${i.memo ? `<p>${esc(i.memo)}</p>` : ''}
          <span class="wmeta">${esc(i.added)} 메모${i.read && i.readDate ? ' · ' + esc(i.readDate) + ' 읽음' : ''}${i.records ? ' · 독서노트 기록 ' + esc(i.records) + '개' : ''}</span>
        </div>
        <div class="wact">
          <button type="button" class="linkbtn w-start">${i.records ? '이어서 기록' : '기록 시작'}</button>
          <button type="button" class="linkbtn w-del">삭제</button>
        </div>
      </div>`).join('')
      : `<div class="empty">${f === 'done' ? '읽음으로 체크한 책이 아직 없습니다.' : '책을 읽다 추천받은 책이 있으면 위에 적어 두세요.'}</div>`;

    $('#wishList').querySelectorAll('.wish').forEach(el => {
      const id = el.dataset.id, item = all.find(x => x.id === id);
      el.querySelector('input[type=checkbox]').onchange = async e => {
        const read = e.target.checked;
        item.read = read; el.classList.toggle('is-read', read);
        try{
          const r = await call('wishupdate', { id, read });
          state.wish.items = r.items;
          setTimeout(renderWish, 350); // 체크 표시를 잠깐 보여 준 뒤 목록 이동
        }catch(err){ e.target.checked = !read; item.read = !read; el.classList.toggle('is-read', !read); alert(err.message); }
      };
      el.querySelector('.w-del').onclick = async () => {
        if(!confirm(`「${item.title}」을(를) 목록에서 지울까요?`)) return;
        try{ const r = await call('wishupdate', { id, del: true }); state.wish.items = r.items; renderWish(); }
        catch(err){ alert(err.message); }
      };
      el.querySelector('.w-start').onclick = () => {
        switchTab('write');
        $('#book').value = item.title; $('#author').value = item.author || '';
        updateTitleHint(); renderChips(); hideLookup();
      };
    });
  }

  $('#wishFilter').querySelectorAll('button').forEach(b => b.onclick = () => { state.wish.filter = b.dataset.f; renderWish(); });

  $('#wAdd').onclick = async () => {
    const title = cleanTitle($('#wTitle').value);
    if(!title){ wSet('책 제목을 입력하세요.', true); $('#wTitle').focus(); return; }
    if(!loggedIn()){ openSettings(); return; }
    const b = $('#wAdd'); b.disabled = true; wSet('추가하는 중…');
    try{
      const r = await call('wishadd', { title, author: $('#wAuthor').value.trim(), from: $('#wFrom').value.trim(), fromPage: $('#wFromPage').value.trim(), memo: $('#wMemo').value.trim() });
      if(r.dup){ wSet(r.notice, true); return; }
      state.wish.items = r.items; state.wish.filter = 'todo'; renderWish();
      ['#wTitle','#wAuthor','#wFromPage','#wMemo'].forEach(s => $(s).value = '');
      wHideLookup();
      wSet(`「${title}」을(를) 읽을 책에 추가했습니다.`);
    }catch(e){ wSet(e.message, true); }
    finally{ b.disabled = false; }
  };

  // 제목을 쓰면 저자 후보 찾기 (기록하기 화면과 같은 검색 사용)
  let wTimer = null, wLast = '';
  const wHideLookup = () => { $('#wLookup').classList.add('hidden'); $('#wLookup').innerHTML = ''; };
  const wPick = it => { $('#wTitle').value = it.title; $('#wAuthor').value = it.authors; wLast = it.title; };
  function wSearch(manual){
    clearTimeout(wTimer);
    const t = cleanTitle($('#wTitle').value);
    if(t.length < 2){ if(manual) wSet('책 제목을 2글자 이상 적어 주세요.', true); else wHideLookup(); return; }
    if(!loggedIn()){ if(manual) openSettings(); return; }
    if(!manual && ($('#wAuthor').value.trim() || t === wLast)) return;
    wLast = t; wSet('');
    bookSearch($('#wLookup'), t, wPick);
  }
  $('#wFind').innerHTML = SEARCH_ICON;
  $('#wFind').onclick = () => wSearch(true);
  $('#wTitle').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); wSearch(true); } });
  $('#wTitle').addEventListener('input', () => { clearTimeout(wTimer); wTimer = setTimeout(() => wSearch(false), 700); });
  $('#wAuthor').addEventListener('input', () => { if($('#wAuthor').value.trim()) wHideLookup(); });

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
      r.notes.forEach(n => { if(n.id) state.notes[n.id] = Object.assign({ masterUrl: r.masterUrl }, n); });
      const bookBar = state.filter ? `<div class="bookbar"><span>「${esc(state.filter)}」 ${esc(r.notes.length)}개 기록</span><button type="button" class="linkbtn" id="btnRenameBook">✎ 책 이름 바꾸기</button></div>` : '';
      box.innerHTML = bookBar + (r.synced ? `<div class="notice synced-msg">드라이브에서 고친 기록 ${esc(r.synced)}건을 반영했습니다.</div>` : '') +
        (r.notes.length ? r.notes.map(n => noteHtml(state.notes[n.id] || n)).join('')
        : '<div class="empty">아직 기록이 없습니다. 읽던 페이지를 찍어 첫 노트를 남겨 보세요.</div>');
      const rb = $('#btnRenameBook');
      if(rb) rb.onclick = renameBookFlow;
    }catch(e){ box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  async function renameBookFlow(){
    const from = state.filter;
    const to = cleanTitle(prompt(`「${from}」의 새 책 제목을 입력하세요.\n이미 있는 다른 책 제목을 넣으면 그 책으로 합쳐집니다.`, from) || '');
    if(!to || to === from) return;
    const rb = $('#btnRenameBook'); if(rb){ rb.disabled = true; rb.textContent = '바꾸는 중…'; }
    try{
      const r = await call('renamebook', { from, to });
      state.filter = r.book;
      if(cleanTitle($('#book').value) === from) $('#book').value = r.book;
      if(store.get('lastBook','') === from) store.set('lastBook', r.book);
      await loadList(); refreshBooks();
      const msg = document.createElement('div'); msg.className = 'notice synced-msg';
      msg.textContent = r.merged ? `「${from}」 기록 ${r.moved}개를 「${r.book}」(으)로 합쳤습니다.` : `책 이름을 「${r.book}」(으)로 바꿨습니다. 시트·문서에도 반영했습니다.`;
      $('#notes').prepend(msg);
    }catch(e){ alert(e.message); if(rb){ rb.disabled = false; rb.textContent = '✎ 책 이름 바꾸기'; } }
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
      if(loggedIn() && !(await RN.getAuth()) && await getKey()) await RN.setMeta(store.get('url',''), store.get('dev',''));
      if(!loggedIn() || !(await getKey())) setTimeout(openSettings, 300); else refreshBooks();
      await renderQueue();
      flushQueue();
    }catch(e){ setStatus('시작 오류: ' + e.message, true); }
  })();
})();
