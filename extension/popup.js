var sw = document.getElementById('sw');
var dot = document.getElementById('dot');
var stateEl = document.getElementById('state');
var warn = document.getElementById('warn');
var tabId = null;
var enabled = false;
var swap = false;

function render() {
  sw.classList.toggle('on', enabled);
  dot.classList.toggle('on', enabled);
  stateEl.textContent = enabled ? '开' : '关';
}

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  var tab = tabs && tabs[0];
  if (!tab || !/^https:\/\/www\.douyin\.com\//.test(tab.url || '')) {
    warn.classList.add('show');
    return;
  }
  tabId = tab.id;
  chrome.tabs.sendMessage(tabId, { cmd: 'get' }, function (res) {
    if (chrome.runtime.lastError || !res) { warn.classList.add('show'); return; }
    enabled = !!res.enabled;
    swap = !!res.swap12;
    render();
    renderSeg();
  });
});

sw.addEventListener('click', function () {
  if (tabId == null) return;
  enabled = !enabled;
  render();
  chrome.tabs.sendMessage(tabId, { cmd: 'set', value: enabled }, function () {
    if (chrome.runtime.lastError) { /* 页面可能刚刷新 */ }
  });
});

render();

// ---------- 比 1 方向 ----------
var seg = document.getElementById('seg');
function renderSeg() {
  Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
    b.classList.toggle('on', (b.getAttribute('data-v') === '1') === swap);
  });
}
seg.addEventListener('click', function (e) {
  var btn = e.target.closest('button');
  if (!btn) return;
  swap = btn.getAttribute('data-v') === '1';
  renderSeg();
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { cmd: 'setSwap', value: swap }, function () {
    if (chrome.runtime.lastError) { /* ignore */ }
    chrome.storage.local.set({ dyGestureSwap12: swap });
  });
});
renderSeg();
