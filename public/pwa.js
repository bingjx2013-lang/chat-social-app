'use strict';
(() => {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(error => {
      console.warn('MicroChat offline shell registration failed:', error?.message || 'unknown error');
    });
  });
})();
