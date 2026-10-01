/* 독서노트 백그라운드 전송 담당 (서비스워커)
 *  - 안드로이드 Chrome: 창을 닫아도 '백그라운드 동기화'로 대기열을 끝까지 보냄. 인터넷이 끊기면 연결될 때 자동 재시도
 *  - 아이폰 Safari: 백그라운드 동기화가 없어서, 다음에 앱을 열 때 이어서 보냄
 *  - 화면 캐시는 하지 않음 (항상 최신 앱을 불러오도록)
 */
importScripts('outbox.js?v=8');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function tellPages() {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach(c => c.postMessage({ type: 'outbox-updated' }));
}

async function flushAndCheck() {
  await self.RN.flush(() => tellPages());
  await tellPages();
  const items = await self.RN.list();
  // 아직 못 보낸 게 있으면 오류를 던져 브라우저가 나중에 다시 시도하게 함
  if (items.some(it => it.status === 'pending' || it.status === 'sending')) throw new Error('retry later');
}

self.addEventListener('sync', e => {
  if (e.tag === 'rn-outbox') e.waitUntil(flushAndCheck());
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'flush') e.waitUntil(self.RN.flush(() => tellPages()).then(tellPages));
});
