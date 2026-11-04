/**
 * 运行在页面主世界（MAIN world）：
 * 负责摄像头取流 + MediaPipe 手部识别 + 手势状态机。
 * 识别到动作后通过 postMessage 通知 content.js 执行，不直接操作页面 DOM。
 */
(function () {
  if (window.__DY_GESTURE__) return;
  window.__DY_GESTURE__ = true;

  var CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240';

  // 与 PRD v0.4.1 §5 参数表一致
  var P = { hold: 300, cool: 1000, curl: 1.15, spread: 0.28, thumb: 0.30, edge: 0.015, minPw: 22 };

  var S = {
    running: false, stream: null, hands: null,
    poseNow: 0, poseSince: 0, locked: false, lastPose: 0, lastFire: 0,
    busy: false, frameSeq: 0, lastSentSeq: -1
  };

  var video = null;
  var lastStatus = '';

  function post(obj) {
    obj.source = 'dy-gesture';
    window.postMessage(obj, '*');
  }
  function status(text) {
    if (text === lastStatus) return;
    lastStatus = text;
    post({ type: 'status', text: text });
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)); }

  // ---------- 判定：与演示页 pose.html 完全一致的算法 ----------
  function evaluate(lm, W, H) {
    var p = lm.map(function (q) { return { x: q.x * W, y: q.y * H, z: (q.z || 0) * W }; });
    var pw = dist(p[5], p[17]) || 0.0001;

    var FING = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]];
    var ratio = FING.map(function (f) {
      return dist(p[0], p[f[2]]) / (dist(p[0], p[f[1]]) || 0.0001);
    });
    var ext = ratio.map(function (r) { return r > P.curl; });

    var thumbExt = dist(p[4], p[5]) / pw > P.thumb;
    var gaps = [dist(p[8], p[12]), dist(p[12], p[16]), dist(p[16], p[20])].map(function (d) { return d / pw; });
    var spread = (gaps[0] + gaps[1] + gaps[2]) / 3;

    // 显式余量：伸直要 > curl+0.06，弯曲要 < curl-0.06。
    // 落在中间的「半伸」不参与任何手势——宁可这一次不响应，
    // 也不要把「比 1」认成「比 2」。方向误判比没反应严重得多。
    var HI = P.curl + 0.06, LO = P.curl - 0.06;
    var up = ratio.map(function (r) { return r > HI; });
    var down = ratio.map(function (r) { return r < LO; });

    var pose = 0;
    if (up[0] && down[1] && down[2] && down[3]) { pose = 1; }
    else if (up[0] && up[1] && down[2] && down[3]) { pose = 2; }
    else if (thumbExt && !up[0] && !up[1] && !(up[2] && up[3])) { pose = 3; }
    else if (up[0] && up[1] && up[2] && up[3] && spread > P.spread) { pose = 4; }

    var minX = 1, maxX = 0, minY = 1, maxY = 0;
    lm.forEach(function (q) {
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    });
    var edge = minX < P.edge || maxX > 1 - P.edge || minY < P.edge || maxY > 1 - P.edge;

    return { pose: pose, edge: edge, pw: pw };
  }

  // ---------- 状态机：armed → holding → firing → locked ----------
  function onResults(res) {
    var lm = res.multiHandLandmarks && res.multiHandLandmarks[0];
    var now = performance.now();

    if (!lm) {
      S.poseNow = 0; S.poseSince = 0; S.locked = false; S.lastPose = 0;
      status('未检测到手');
      return;
    }

    var W = video.videoWidth || 640, H = video.videoHeight || 480;
    var e = evaluate(lm, W, H);

    if (e.edge) { status('手太靠边 · 往中间挪'); return; }
    if (e.pw < P.minPw) { status('离镜头近一点'); return; }

    if (e.pose !== S.poseNow) { S.poseNow = e.pose; S.poseSince = now; }
    var held = S.poseNow ? (now - S.poseSince) : 0;

    if (S.locked) {
      if (S.poseNow === 0) S.locked = false;
      else if (S.poseNow !== S.lastPose && now - S.lastFire > 350) S.locked = false;
    }

    if (!S.poseNow) { status('已检测到手 · 手势不明确'); return; }

    var POSE_NAME = { 1: '比1', 2: '比2', 3: '竖拇指', 4: '五指张开' };
    status(S.locked ? '已触发 · 收手或换手势'
      : ('识别到 ' + (POSE_NAME[S.poseNow] || S.poseNow) + ' · ' + Math.round(held) + 'ms'));

    if (!S.locked && held >= P.hold && now - S.lastFire >= P.cool) {
      S.lastFire = now;
      S.lastPose = S.poseNow;
      S.locked = true;
      S.poseSince = now;
      post({ type: 'gesture', pose: e.pose });
    }
  }

  function pump() {
    if (!S.running) return;
    var fresh = !video.requestVideoFrameCallback || S.frameSeq !== S.lastSentSeq;
    if (video.readyState >= 2 && !S.busy && fresh) {
      S.lastSentSeq = S.frameSeq;
      S.busy = true;
      S.hands.send({ image: video }).catch(function () {}).then(function () { S.busy = false; });
    }
    requestAnimationFrame(pump);
  }

  function loadHands() {
    if (window.Hands) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = CDN + '/hands.js';
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('识别模型加载失败，检查网络')); };
      document.head.appendChild(s);
      setTimeout(function () { window.Hands ? resolve() : reject(new Error('模型加载超时')); }, 15000);
    });
  }

  async function start() {
    if (S.running) return;
    try {
      status('正在请求摄像头…');
      var stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      S.stream = stream;

      if (!video) {
        video = document.createElement('video');
        video.playsInline = true;
        video.muted = true;
        video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;';
        document.documentElement.appendChild(video);
      }
      video.srcObject = stream;
      await video.play();

      await loadHands();
      status('模型加载中…');

      S.hands = new window.Hands({ locateFile: function (f) { return CDN + '/' + f; } });
      S.hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
      S.hands.onResults(onResults);

      S.running = true;
      S.poseNow = 0; S.poseSince = 0; S.locked = false; S.lastPose = 0; S.lastFire = 0;
      S.frameSeq = 0; S.lastSentSeq = -1;

      if (video.requestVideoFrameCallback) {
        (function tick() {
          if (!S.running) return;
          S.frameSeq++;
          video.requestVideoFrameCallback(tick);
        })();
      }
      pump();
      status('待命 · 比 1 或 2');
      post({ type: 'state', on: true });
    } catch (err) {
      stop();
      status('启动失败：' + (err && err.name === 'NotAllowedError' ? '摄像头被拒绝' : (err.message || '未知错误')));
      post({ type: 'state', on: false });
    }
  }

  function stop() {
    S.running = false;
    if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; }
    if (video) video.srcObject = null;
    lastStatus = '';
    post({ type: 'state', on: false });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== 'dy-ctrl') return;
    if (d.cmd === 'start') start();
    if (d.cmd === 'stop') stop();
    if (d.cmd === 'ping') post({ type: 'pong' });
  });

  // 页面加载后主动报到，content.js 会据此决定是否自动开启
  post({ type: 'ready' });
})();
