var sw = document.getElementById('sw');
var dot = document.getElementById('dot');
var stateEl = document.getElementById('state');
var warn = document.getElementById('warn');
var tabId = null;
var enabled = false;

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
    render();
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
