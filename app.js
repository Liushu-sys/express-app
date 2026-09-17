/* 取件助手 —— 前端逻辑（本机 localStorage + 服务端 JSON 双写，按 id 合并） */
(function () {
  'use strict';

  var STORE_KEY = 'pickup-state-v1';
  var GUIDE_KEY = 'pickup-guide-dismissed';

  var state = { version: 1, packages: [], updatedAt: 0 };
  var view = 'pending';
  var doneOpen = false;
  var pushTimer = null;
  var lastDeleted = null;
  var editingId = null;

  /* ---------------- 工具 ---------------- */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------------- 存储与同步 ---------------- */
  function loadLocal() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY));
      return s && Array.isArray(s.packages) ? s : null;
    } catch (e) { return null; }
  }
  function saveLocal() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }

  /** 按 id 合并：同一 id 取 updatedAt 更大的一方 */
  function mergeStates(a, b) {
    var map = {};
    (a.packages || []).forEach(function (p) { map[p.id] = p; });
    (b.packages || []).forEach(function (p) {
      if (!map[p.id] || (p.updatedAt || 0) > (map[p.id].updatedAt || 0)) map[p.id] = p;
    });
    var packages = Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (x, y) { return (x.createdAt || 0) - (y.createdAt || 0); });
    return { version: 1, packages: packages, updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0) };
  }

  function setSync(text, cls) {
    var el = $('syncText');
    if (!el) return;
    el.textContent = text;
    el.className = 'sync' + (cls ? ' ' + cls : '');
  }

  /** 防抖推送：本机先落盘，700ms 后合并到服务端 */
  function push() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      setSync('同步中…', 'syncing');
      fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: state }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok && data.state) {
            state = mergeStates(state, data.state);
            state.updatedAt = Date.now();
            saveLocal();
            setSync('已同步 · ' + new Date().toTimeString().slice(0, 5));
          } else {
            setSync('本地已保存', 'offline');
          }
        })
        .catch(function () { setSync('离线 · 本机已保存', 'offline'); });
    }, 700);
  }

  function commit() {
    state.updatedAt = Date.now();
    saveLocal();
    render();
    push();
  }

  /* ---------------- 数据操作 ---------------- */
  function addPackage(name, location, code) {
    name = String(name || '').trim();
    if (!name) return false;
    location = String(location || '').trim() || '未分类';
    code = String(code || '').trim();
    var now = Date.now();
    state.packages.push({
      id: uid(),
      name: name,
      location: location,
      code: code,
      done: false,
      createdAt: now,
      doneAt: 0,
      updatedAt: now,
    });
    commit();
    return true;
  }

  function updatePackage(id, name, location, code) {
    name = String(name || '').trim();
    if (!name) return false;
    location = String(location || '').trim() || '未分类';
    code = String(code || '').trim();
    state.packages.forEach(function (p) {
      if (p.id === id) {
        p.name = name;
        p.location = location;
        p.code = code;
        p.updatedAt = Date.now();
      }
    });
    commit();
    return true;
  }

  function toggleDone(id) {
    state.packages.forEach(function (p) {
      if (p.id === id) {
        p.done = !p.done;
        p.doneAt = p.done ? Date.now() : 0;
        p.updatedAt = Date.now();
      }
    });
    commit();
  }

  /** 取件动效：圆点立即变绿 → 卡片放大轻晃掉落 → 动画结束后更新状态沉入已取区 */
  var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function playDropThenDone(card, id) {
    var dot = card.querySelector('.dot');
    if (dot) dot.classList.add('on');
    if (REDUCED_MOTION) { toggleDone(id); return; }
    card.classList.add('dropping');
    setTimeout(function () { toggleDone(id); }, 540);
  }

  function removePackage(id) {
    var idx = -1;
    state.packages.forEach(function (p, i) { if (p.id === id) idx = i; });
    if (idx < 0) return;
    lastDeleted = { item: state.packages[idx], index: idx };
    state.packages.splice(idx, 1);
    commit();
    showToast('已删除', '撤销', function () {
      if (!lastDeleted) return;
      state.packages.splice(lastDeleted.index, 0, lastDeleted.item);
      lastDeleted = null;
      commit();
    });
  }

  /* ---------------- 地点分组树 ---------------- */
  /** 把 location 按 / 拆分级，构建树 */
  function buildTree(items) {
    var root = { name: '', children: {}, items: [] };
    items.forEach(function (it) {
      var parts = String(it.location || '未分类').split('/').map(function (s) { return s.trim(); }).filter(Boolean);
      if (parts.length === 0) parts = ['未分类'];
      var node = root;
      parts.forEach(function (part) {
        if (!node.children[part]) node.children[part] = { name: part, children: {}, items: [] };
        node = node.children[part];
      });
      node.items.push(it);
    });
    return root;
  }

  function countItems(node) {
    var n = node.items.length;
    Object.keys(node.children).forEach(function (k) { n += countItems(node.children[k]); });
    return n;
  }

  function renderItem(it) {
    var codeHtml = it.code ? '<span class="pkg-code" aria-label="取货码">' + escapeHtml(it.code) + '</span>' : '';
    return '<li class="pkg-item" data-id="' + it.id + '">' +
      '<button class="dot' + (it.done ? ' on' : '') + '" data-act="toggle" aria-label="标记已取"></button>' +
      '<div class="pkg-body">' +
        '<div class="pkg-name">' + escapeHtml(it.name) + '</div>' +
        '<div class="pkg-sub">' + escapeHtml(it.location) + '</div>' +
      '</div>' +
      codeHtml +
      '<button class="del-btn" data-act="del" aria-label="删除">×</button>' +
      '</li>';
  }

  function renderDoneItem(it) {
    var codeHtml = it.code ? '<span class="pkg-code pkg-code-sm">' + escapeHtml(it.code) + '</span>' : '';
    return '<li class="pkg-item" data-id="' + it.id + '">' +
      '<button class="dot on" data-act="toggle" aria-label="恢复"></button>' +
      '<div class="pkg-body">' +
        '<div class="pkg-name">' + escapeHtml(it.name) + '</div>' +
        '<div class="pkg-sub">' + escapeHtml(it.location) + ' · ' + fmtTime(it.doneAt) + ' 已取</div>' +
      '</div>' +
      codeHtml +
      '<button class="restore-btn" data-act="toggle">恢复</button>' +
      '</li>';
  }

  /** 递归渲染地点分组 */
  function renderGroup(node, depth) {
    var html = '';
    if (depth > 0) {
      var total = countItems(node);
      // 一级地点：线性小房子；二级及更深：同色系小圆点
      var ico = depth === 1
        ? '<svg class="loc-house" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
          '<path d="M3.8 11.3 12 4.4l8.2 6.9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
          '<path d="M6.2 9.9V19a1 1 0 0 0 1 1h9.6a1 1 0 0 0 1-1V9.9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
          '</svg>'
        : '<span class="loc-dot" aria-hidden="true"></span>';
      html += '<div class="loc-group">';
      html += '<div class="loc-header">' + ico + '<span class="loc-name">' + escapeHtml(node.name) + '</span>' +
        '<span class="loc-count">' + total + '</span></div>';
    }
    if (node.items.length) {
      html += '<ul class="pkg-list">';
      node.items.forEach(function (it) { html += renderItem(it); });
      html += '</ul>';
    }
    Object.keys(node.children).sort().forEach(function (k) {
      html += renderGroup(node.children[k], depth + 1);
    });
    if (depth > 0) html += '</div>';
    return html;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var pending = state.packages.filter(function (p) { return !p.done; });
    var done = state.packages.filter(function (p) { return p.done; })
      .sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });

    // 顶部统计
    $('pendingCount').textContent = pending.length;
    $('pendingSub').textContent = pending.length ? '还有 ' + pending.length + ' 件待取' : '全部取完啦 🎉';

    // 待取列表（按地点分级）
    var tree = buildTree(pending);
    $('pendingList').innerHTML = renderGroup(tree, 0);
    $('emptyState').hidden = pending.length > 0;

    // 已取区
    $('doneSection').hidden = done.length === 0;
    $('doneCount').textContent = done.length;
    $('doneList').innerHTML = done.map(renderDoneItem).join('');
    $('doneList').hidden = !doneOpen;
    $('doneToggle').classList.toggle('open', doneOpen);

    // 我的
    var locSet = {};
    state.packages.forEach(function (p) { (p.location || '').split('/').forEach(function (s, i, arr) {
      locSet[arr.slice(0, i + 1).join('/')] = 1;
    }); });
    $('statPending').textContent = pending.length;
    $('statDone').textContent = done.length;
    $('statTotal').textContent = state.packages.length;
    $('statLoc').textContent = Object.keys(locSet).length;
  }

  function switchView(v) {
    view = v;
    ['pending', 'me'].forEach(function (name) { $('view-' + name).hidden = name !== v; });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.dataset.view === v);
    });
    window.scrollTo(0, 0);
  }

  /* ---------------- 提示条 ---------------- */
  var toastTimer = null;
  function showToast(msg, actionLabel, onAction) {
    var el = $('toast');
    el.innerHTML = '<span>' + escapeHtml(msg) + '</span>' +
      (actionLabel ? '<button id="toastAction">' + escapeHtml(actionLabel) + '</button>' : '');
    el.classList.add('show');
    if (actionLabel) {
      $('toastAction').addEventListener('click', function () { onAction(); hideToast(); });
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actionLabel ? 4000 : 2000);
  }
  function hideToast() { $('toast').classList.remove('show'); }

  /* ---------------- 添加/编辑表单 ---------------- */
  function openSheet(item) {
    editingId = item ? item.id : null;
    $('sheetTitle').textContent = item ? '编辑取件' : '添加取件';
    $('confirmAdd').textContent = item ? '保存' : '添加';
    if (item) {
      $('fName').value = item.name || '';
      $('fLoc').value = item.location === '未分类' ? '' : (item.location || '');
      $('fCode').value = item.code || '';
    }
    $('sheetMask').hidden = false;
    setTimeout(function () { $('fName').focus(); }, 100);
  }
  function closeSheet() {
    $('sheetMask').hidden = true;
    editingId = null;
    $('fName').value = '';
    $('fLoc').value = '';
    $('fCode').value = '';
  }
  function confirmForm() {
    var name = $('fName').value;
    if (!String(name).trim()) { $('fName').focus(); showToast('请填写快递名称'); return; }
    if (editingId) {
      updatePackage(editingId, name, $('fLoc').value, $('fCode').value);
      showToast('已保存');
    } else {
      addPackage(name, $('fLoc').value, $('fCode').value);
      showToast('已添加');
    }
    closeSheet();
  }

  /* ---------------- 事件绑定 ---------------- */
  $('fab').addEventListener('click', function () { openSheet(); });
  $('cancelAdd').addEventListener('click', closeSheet);
  $('sheetMask').addEventListener('click', function (e) { if (e.target === this) closeSheet(); });
  $('confirmAdd').addEventListener('click', confirmForm);
  ['fName', 'fLoc', 'fCode'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmForm(); }
    });
  });

  // 双击卡片文字区 → 打开编辑表单
  function bindEdit(listId) {
    $(listId).addEventListener('dblclick', function (e) {
      if (!e.target.closest('.pkg-body')) return;
      var li = e.target.closest('.pkg-item');
      if (!li || li.classList.contains('dropping')) return;
      var found = null;
      state.packages.forEach(function (p) { if (p.id === li.dataset.id) found = p; });
      if (found) openSheet(found);
    });
  }
  bindEdit('pendingList');
  bindEdit('doneList');

  // 列表事件委托
  $('pendingList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var li = e.target.closest('.pkg-item');
    if (!li) return;
    var id = li.dataset.id;
    if (btn.dataset.act === 'toggle') {
      if (li.classList.contains('dropping')) return; // 动画进行中，防连点
      playDropThenDone(li, id);
    }
    else if (btn.dataset.act === 'del') removePackage(id);
  });
  $('doneList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var li = e.target.closest('.pkg-item');
    if (!li) return;
    toggleDone(li.dataset.id);
  });

  $('doneToggle').addEventListener('click', function () {
    doneOpen = !doneOpen;
    $('doneList').hidden = !doneOpen;
    $('doneToggle').classList.toggle('open', doneOpen);
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () { switchView(t.dataset.view); });
  });

  $('exportBtn').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pickup-' + todayKey() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  /* ---------------- 启动 ---------------- */
  function boot() {
    var local = loadLocal();
    if (local) state = local;
    render();
    setSync(local ? '本地已保存' : '本机存储', 'offline');

    fetch('/api/state', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && data.state) {
          state = mergeStates(state, data.state);
          state.updatedAt = Date.now();
          saveLocal();
          render();
          setSync('已同步 · ' + new Date().toTimeString().slice(0, 5));
          push();
        }
      })
      .catch(function () { setSync('离线 · 本机已保存', 'offline'); });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () {}); });
  }

  /* ---------------- 装到桌面 ---------------- */
  var deferredPrompt = null;
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isStandalone() {
    return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  }
  function inAppBrowser() { return /micromessenger|weibo|qq\//.test(navigator.userAgent.toLowerCase()); }
  function canAutoInstall() { return !!deferredPrompt && !isIOS(); }

  function guideHtml() {
    if (inAppBrowser()) {
      return '<p>现在是微信 / QQ 内置浏览器，它不允许装到桌面。</p>' +
        '<ol><li>点右上角 <b>···</b> 菜单</li><li>选择 <b>在 Safari 中打开</b></li>' +
        '<li>再按下面的步骤操作一次</li></ol>';
    }
    if (isIOS()) {
      return '<p>用 Safari 打开本页，两步就能变成一个独立 App：</p>' +
        '<ol><li>点 <b>分享按钮</b>（方框 + 向上箭头，通常在底部工具栏中间或顶部地址栏右侧）</li>' +
        '<li>向下找到 <b>添加到主屏幕</b>，点右上角「添加」</li></ol>' +
        '<p class="g-tip">之后从桌面图标打开就是全屏的，没有地址栏，断网也能看记录。</p>';
    }
    if (deferredPrompt) return '<p>点下面的按钮即可安装，桌面会出现「取件助手」图标。</p>';
    return '<p>在浏览器菜单里选 <b>添加到主屏幕</b> 或 <b>安装应用</b> 即可。</p>' +
      '<p class="g-tip">Chrome、Edge 等支持一键安装；iPhone 请用 Safari。</p>';
  }

  function showGuide() {
    $('guideBody').innerHTML = guideHtml();
    $('guideClose').textContent = canAutoInstall() ? '立即安装' : '知道了';
    $('guideMask').hidden = false;
  }
  function hideGuide() {
    $('guideMask').hidden = true;
    try { localStorage.setItem(GUIDE_KEY, '1'); } catch (e) {}
  }

  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; });
  $('guideClose').addEventListener('click', function () {
    if (canAutoInstall()) { var p = deferredPrompt; deferredPrompt = null; p.prompt(); p.userChoice.catch(function () {}); }
    hideGuide();
  });
  $('guideLater').addEventListener('click', hideGuide);
  $('guideMask').addEventListener('click', function (e) { if (e.target === this) hideGuide(); });
  $('installBtn').addEventListener('click', function () {
    if (isStandalone()) { showToast('已经装在桌面啦'); return; }
    showGuide();
  });

  boot();

  (function () {
    if (!isStandalone()) {
      var dismissed = false;
      try { dismissed = localStorage.getItem(GUIDE_KEY) === '1'; } catch (e) {}
      if (!dismissed) setTimeout(showGuide, 1500);
    }
  })();
})();
