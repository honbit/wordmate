'use strict';

// PWA 离线缓存注册
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.error('SW 注册失败:', e));
  });
}
