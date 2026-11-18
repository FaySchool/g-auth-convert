/* global jsQR, qrcode, GAuthMigration */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('status');
  var accounts = [];          // converted accounts, in the order they were added
  var seenUris = new Set();   // de-duplicates accounts when the same QR is added twice
  var stream = null;          // active camera MediaStream, if any
  var scanTimer = null;

  // qrcode-generator defaults to Latin-1; make sure anything non-ASCII is encoded as UTF-8.
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  // --- conversion ----------------------------------------------------------

  /** Parse one export URI and add its accounts. Returns a short summary string. */
  function addExport(text) {
    var result = GAuthMigration.parseMigration(text);
    var added = 0;
    result.accounts.forEach(function (a) {
      if (seenUris.has(a.uri)) return;
      seenUris.add(a.uri);
      accounts.push(a);
      added++;
    });
    render();
    var msg = 'Added ' + added + ' account' + (added === 1 ? '' : 's');
    var dupes = result.accounts.length - added;
    if (dupes) msg += ' (' + dupes + ' already listed)';
    if (result.batchSize > 1) {
      msg += ' — QR code ' + (result.batchIndex + 1) + ' of ' + result.batchSize +
             ' in this export, add the others too';
    }
    return msg + '.';
  }

  function convertText(text) {
    try {
      setStatus(addExport(text), 'ok');
      return true;
    } catch (err) {
      setStatus(err.message, 'error');
      return false;
    }
  }

  // --- QR decoding from images --------------------------------------------

  function decodeCanvas(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    return hit ? hit.data : null;
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read ' + (file.name || 'that image') + '.')); };
      img.src = url;
    });
  }

  /** Try a few scales: dense export codes in large photos often decode better downsized. */
  function decodeImage(img) {
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var longest = Math.max(w, h);
    var targets = [longest, 1600, 1000, 600].filter(function (t, i) { return i === 0 || t < longest; });
    var canvas = document.createElement('canvas');
    for (var i = 0; i < targets.length; i++) {
      var scale = Math.min(1, targets[i] / longest);
      if (i === 0 && longest > 3000) scale = 3000 / longest;
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      var text = decodeCanvas(canvas);
      if (text) return text;
    }
    return null;
  }

  async function handleFiles(files) {
    var list = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); });
    if (!list.length) { setStatus('Please choose image files.', 'error'); return; }
    setStatus('Reading ' + list.length + ' image' + (list.length === 1 ? '' : 's') + '…');
    var messages = [];
    var failed = false;
    for (var i = 0; i < list.length; i++) {
      var label = list.length > 1 ? (list[i].name || 'Image ' + (i + 1)) + ': ' : '';
      try {
        var text = decodeImage(await loadImage(list[i]));
        if (!text) throw new Error('No QR code found. Try a sharper, more tightly cropped image.');
        messages.push(label + addExport(text));
      } catch (err) {
        failed = true;
        messages.push(label + err.message);
      }
    }
    setStatus(messages.join(' '), failed ? 'error' : 'ok');
  }

  // --- camera --------------------------------------------------------------

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Camera access is not available here (it needs HTTPS or localhost). Use an image instead.', 'error');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    } catch (err) {
      setStatus('Could not open the camera: ' + err.message, 'error');
      return;
    }
    var video = $('video');
    video.srcObject = stream;
    $('camera').hidden = false;
    $('camera-btn').hidden = true;
    await video.play();
    setStatus('Point the camera at the export QR code…');

    var canvas = document.createElement('canvas');
    var lastText = null;
    scanTimer = setInterval(function () {
      if (!video.videoWidth) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
      var text = decodeCanvas(canvas);
      if (!text || text === lastText) return;
      lastText = text; // keep scanning so multi-part exports can be shown one after another
      convertText(text);
    }, 250);
  }

  function stopCamera() {
    clearInterval(scanTimer);
    scanTimer = null;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    $('video').srcObject = null;
    $('camera').hidden = true;
    $('camera-btn').hidden = false;
  }

  // --- output --------------------------------------------------------------

  function makeQrCanvas(text, pixels) {
    var qr = qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    var count = qr.getModuleCount();
    var quiet = 4;
    var cell = Math.max(1, Math.floor(pixels / (count + quiet * 2)));
    var size = cell * (count + quiet * 2);
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
    return canvas;
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { node[k] = props[k]; });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  async function copyText(text, button) {
    var original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch (err) {
      button.textContent = 'Copy failed';
    }
    setTimeout(function () { button.textContent = original; }, 1500);
  }

  function download(href, filename) {
    var a = el('a', { href: href, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function safeFilename(text) {
    return text.replace(/[^\w.@-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'account';
  }

  function renderAccount(a) {
    var title = a.issuer || a.name || 'Unnamed account';
    var canvas = makeQrCanvas(a.uri, 800);
    canvas.className = 'qr';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'QR code for ' + title);

    var copyBtn = el('button', { type: 'button', textContent: 'Copy URI' });
    copyBtn.addEventListener('click', function () { copyText(a.uri, copyBtn); });

    var pngBtn = el('button', { type: 'button', textContent: 'Download QR' });
    pngBtn.addEventListener('click', function () {
      download(canvas.toDataURL('image/png'), safeFilename(title + (a.issuer && a.name ? '-' + a.name : '')) + '.png');
    });

    var meta = a.type.toUpperCase() + ' · ' + a.algorithm + ' · ' + a.digits + ' digits' +
      (a.type === 'hotp' ? ' · counter ' + a.counter : ' · 30 s');

    var details = el('div', {}, [el('h3', { textContent: title })]);
    if (a.issuer && a.name) details.appendChild(el('p', { className: 'name', textContent: a.name }));
    details.appendChild(el('div', { className: 'meta', textContent: meta }));
    details.appendChild(el('code', { className: 'uri', textContent: a.uri }));
    details.appendChild(el('div', { className: 'row' }, [copyBtn, pngBtn]));

    return el('li', { className: 'account' }, [canvas, details]);
  }

  function render() {
    var list = $('accounts');
    list.textContent = '';
    accounts.forEach(function (a) { list.appendChild(renderAccount(a)); });
    $('results').hidden = accounts.length === 0;
    $('results-heading').textContent = '2. Your accounts (' + accounts.length + ')';
  }

  function allUris() {
    return accounts.map(function (a) { return a.uri; }).join('\n') + '\n';
  }

  // --- wiring --------------------------------------------------------------

  var drop = $('drop');
  var fileInput = $('file');

  drop.addEventListener('click', function () { fileInput.click(); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', function () {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
  // Dropping a file outside the drop zone would otherwise navigate away and lose the results.
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  document.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      e.preventDefault();
      handleFiles(files);
      return;
    }
    if (e.target === $('uri')) return; // normal paste into the text box
    var text = e.clipboardData && e.clipboardData.getData('text');
    if (text && /^\s*otpauth-migration:/i.test(text)) {
      e.preventDefault();
      convertText(text);
    }
  });

  $('convert').addEventListener('click', function () {
    var lines = $('uri').value.split(/\s*\n\s*/).filter(Boolean);
    if (!lines.length) { setStatus('Paste an export URI first.', 'error'); return; }
    var messages = [];
    var failed = false;
    lines.forEach(function (line) {
      try { messages.push(addExport(line)); }
      catch (err) { failed = true; messages.push(err.message); }
    });
    setStatus(messages.join(' '), failed ? 'error' : 'ok');
    if (!failed) $('uri').value = '';
  });

  $('camera-btn').addEventListener('click', startCamera);
  $('camera-stop').addEventListener('click', function () { stopCamera(); setStatus(''); });

  $('copy-all').addEventListener('click', function () {
    // Clipboard history (Windows Win+V, clipboard managers) and cross-device sync can keep a copy.
    var ok = window.confirm('This copies the secret keys of all ' + accounts.length + ' account' +
      (accounts.length === 1 ? '' : 's') + ' to the clipboard. Clipboard history and syncing ' +
      '(such as Windows Win+V or Apple Universal Clipboard) may keep a copy after you paste.\n\nCopy anyway?');
    if (ok) copyText(allUris(), $('copy-all'));
  });
  $('download-all').addEventListener('click', function () {
    var url = URL.createObjectURL(new Blob([allUris()], { type: 'text/plain' }));
    download(url, 'otpauth-uris.txt');
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  $('print').addEventListener('click', function () { window.print(); });
  $('clear').addEventListener('click', function () {
    accounts = [];
    seenUris.clear();
    $('uri').value = '';
    render();
    setStatus('Cleared.');
  });

  window.addEventListener('pagehide', stopCamera);
})();
