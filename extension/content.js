/**
 * 内容脚本：与注入的识别模块通信，把「手势」翻译成页面动作。
 * 关键点是「自适应驱动 + 成功后自校验」——抖音的滚动容器类名是混淆的，
 * 不能写死选择器，只能按结构找，并且每次执行后验证是否真的动了。
 */
(function () {
  if (window.__DY_GESTURE_CTRL__) return;
  window.__DY_GESTURE_CTRL__ = true;

  var LS_KEY = 'dyGestureEnabled';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---------- 状态胶囊 ----------
  var pill, dot, label;
  function buildPill() {
    if (pill) return;
    pill = document.createElement('div');
    pill.id = 'dy-gesture-pill';
    pill.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:88px', 'z-index:2147483000',
      'display:flex', 'align-items:center', 'gap:8px',
      'padding:7px 12px', 'border-radius:99px',
      'background:rgba(12,14,18,.82)', 'color:#c8cfda',
      'border:1px solid rgba(255,255,255,.14)',
      'font:12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'backdrop-filter:blur(10px)', 'pointer-events:none',
      'box-shadow:0 6px 20px rgba(0,0,0,.35)', 'transition:opacity .2s'
    ].join(';');
    dot = document.createElement('span');
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#5b6373;flex:none;';
    label = document.createElement('span');
    label.textContent = '手势 关';
    pill.appendChild(dot);
    pill.appendChild(label);
    document.documentElement.appendChild(pill);
  }

  function setPill(on, text, warn) {
    buildPill();
    dot.style.background = warn ? '#ffb84d' : (on ? '#25f4ee' : '#5b6373');
    dot.style.boxShadow = (on && !warn) ? '0 0 8px rgba(37,244,238,.8)' : 'none';
    label.textContent = text;
    label.style.color = warn ? '#ffb84d' : (on ? '#25f4ee' : '#c8cfda');
  }

  var flashTimer = null;
  function flash(text, warn) {
    setPill(true, text, warn);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { setPill(enabled, enabled ? '手势 开' : '手势 关'); }, 1400);
  }

  // ---------- 找目标元素 ----------
  function pickVideo(preferPlaying) {
    var vids = Array.prototype.slice.call(document.querySelectorAll('video'));
    var best = null, bestScore = -1;
    vids.forEach(function (v) {
      var r = v.getBoundingClientRect();
      var vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
                Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      var score = vis + (preferPlaying && !v.paused ? 1e7 : 0);
      if (score > bestScore) { bestScore = score; best = v; }
    });
    return best;
  }

  // 找真正在滚的容器。抖音的类名是混淆的，不能写死选择器，分三级降级：
  // ① 视频的滚动祖先 ② 全局包含 video 且溢出最多的容器 ③ 文档滚动容器
  function scrollParent(el) {
    var node = el ? el.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      var cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight - node.clientHeight > 60) return node;
      node = node.parentElement;
    }

    var best = null, bestScore = 0;
    var all = document.querySelectorAll('div,main,section');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var over = n.scrollHeight - n.clientHeight;
      if (over < 60 || n.clientHeight < 200) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
      var score = over + (n.querySelector('video') ? 10000 : 0);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best || document.scrollingElement || document.documentElement;
  }

  // ---------- 动作 ----------
  async function step(dir) {
    var v = pickVideo(true);
    var sc = scrollParent(v);
    if (sc.scrollHeight - sc.clientHeight < 8) {
      var alt = document.scrollingElement || document.documentElement;
      if (alt !== sc) sc = alt;
    }
    var before = sc.scrollTop;
    var h = sc.clientHeight || innerHeight;

    sc.scrollBy({ top: dir * h, behavior: 'smooth' });
    await sleep(450);
    if (Math.abs(sc.scrollTop - before) > 8) return 'scroll';

    // 回退：派发方向键（合成事件可能被忽略，所以放在第二顺位）
    var key = dir > 0 ? 'ArrowDown' : 'ArrowUp';
    var code = dir > 0 ? 40 : 38;
    [document.activeElement, v, sc, document].forEach(function (t) {
      if (t && t.dispatchEvent) {
        t.dispatchEvent(new KeyboardEvent('keydown', { key: key, keyCode: code, which: code, bubbles: true, cancelable: true }));
      }
    });
    await sleep(400);
    if (Math.abs(sc.scrollTop - before) > 8) return 'keys';
    return 'failed';
  }

  function cycleSpeed() {
    var v = pickVideo(true) || pickVideo(false);
    if (!v) return '没有视频';
    var cur = v.playbackRate;
    var next = cur < 1.5 ? 2 : (cur < 3 ? 4 : 1);
    v.playbackRate = next;
    return next + ' 倍速';
  }

  function togglePause() {
    var v = pickVideo(true) || pickVideo(false);
    if (!v) return '没有视频';
    if (v.paused) { v.play().catch(function () {}); return '继续播放'; }
    v.pause();
    return '已暂停';
  }

  async function run(act) {
    if (act === 'next' || act === 'prev') {
      var how = await step(act === 'next' ? 1 : -1);
      flash(how === 'scroll' ? (act === 'next' ? '下一个' : '上一个')
            : how === 'keys' ? (act === 'next' ? '下一个（按键）' : '上一个（按键）')
            : '切换失败', how === 'failed');
      return;
    }
    if (act === 'speed') { flash(cycleSpeed()); return; }
    if (act === 'pause') { flash(togglePause()); return; }
  }

  // ---------- 开关 ----------
  var enabled = false;

  function send(cmd) { window.postMessage({ source: 'dy-ctrl', cmd: cmd }, '*'); }

  function setEnabled(v) {
    enabled = v;
    try { chrome.storage.local.set({ dyGestureEnabled: v }); } catch (e) {}
    setPill(v, v ? '手势 开' : '手势 关');
    send(v ? 'start' : 'stop');
  }

  // ---------- 消息 ----------
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== 'dy-gesture') return;

    if (d.type === 'ready') {
      try {
        chrome.storage.local.get([LS_KEY], function (r) {
          enabled = !!r[LS_KEY];
          setPill(enabled, enabled ? '手势 开' : '手势 关');
          if (enabled) send('start');
        });
      } catch (e) {
        setPill(false, '手势 关');
      }
      return;
    }
    if (d.type === 'status') { flash(d.text, !/待命|已检测|识别到/.test(d.text)); return; }
    if (d.type === 'state') {
      enabled = !!d.on;
      if (!enabled) setPill(false, '手势 关');
      return;
    }
    if (d.type === 'gesture') { run(d.act); return; }
  });

  // 页内快捷键：Alt + Shift + G
  document.addEventListener('keydown', function (e) {
    if (e.altKey && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
      e.preventDefault();
      setEnabled(!enabled);
    }
  });

  // 供扩展弹窗控制
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.cmd === 'set') { setEnabled(!!msg.value); sendResponse({ enabled: enabled }); }
      if (msg.cmd === 'get') { sendResponse({ enabled: enabled }); }
      return true;
    });
  } catch (e) {}

  buildPill();
})();
