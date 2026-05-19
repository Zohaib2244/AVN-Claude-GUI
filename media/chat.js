(function () {
  'use strict';

  const vscApi = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────
  let streaming        = false;
  let currentEl        = null;
  let currentRaw       = '';
  let attachments      = [];   // [{ name, uri, isImage?, dataUrl?, width?, height?, isFolder? }]
  let availableModels  = [];
  let atMentionStart   = -1;
  let fpSearchTimer    = null;
  let cmdPickerOpen    = false;

  // ── DOM ──────────────────────────────────────────────────────────────────
  const messagesEl  = document.getElementById('messages');
  const emptyEl     = document.getElementById('empty-state');
  const inputEl     = document.getElementById('user-input');
  const sendBtn     = document.getElementById('send-btn');
  const statusDot   = document.getElementById('status-dot');
  const modelBtn    = document.getElementById('model-btn');
  const modeBtns    = document.querySelectorAll('.mode-btn');
  const yoloBtn     = document.getElementById('yolo-btn');
  const ctxLine     = document.getElementById('ctx-line');
  const ctxTextEl   = document.getElementById('ctx-text-inner');
  const dropOverlay = document.getElementById('drop-overlay');
  const usagePanel  = document.getElementById('usage-panel');
  const filePicker  = document.getElementById('file-picker');
  const fpSearch    = document.getElementById('fp-search');
  const fpResults   = document.getElementById('fp-results');
  const cmdPicker   = document.getElementById('cmd-picker');
  const modelPicker = document.getElementById('model-picker');
  const mpList      = document.getElementById('mp-list');
  const tbChips     = document.getElementById('tb-chips');

  // ── Helpers ──────────────────────────────────────────────────────────────
  function post(type, extra) { vscApi.postMessage(Object.assign({ type }, extra || {})); }
  function hideEmpty() { if (emptyEl && emptyEl.parentNode) { emptyEl.remove(); } }
  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtTok(n) {
    if (n >= 1000000) { return (n/1000000).toFixed(1)+'M'; }
    if (n >= 1000)    { return (n/1000).toFixed(1)+'k'; }
    return String(n);
  }

  // ── Send button state ────────────────────────────────────────────────────
  function refreshSendBtn() {
    sendBtn.disabled = streaming || inputEl.value.trim() === '';
  }

  // ── Input resize + @ detection ───────────────────────────────────────────
  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    refreshSendBtn();
    checkAtMention();
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); return; }
    if (e.key === 'Escape') {
      if (!filePicker.hidden)   { closeFilePicker(true); return; }
      if (cmdPickerOpen)        { closeCmdPicker(); return; }
      if (!modelPicker.hidden)  { closeModelPicker(); return; }
    }
    if (e.key === '/') {
      // If the textarea is empty (or cursor at start), open command picker
      if (inputEl.value.trim() === '') {
        e.preventDefault();
        toggleCmdPicker();
      }
    }
  });

  inputEl.addEventListener('focus', function () { post('requestContext'); });

  // ── @ mention ────────────────────────────────────────────────────────────
  function checkAtMention() {
    const val = inputEl.value;
    const pos = inputEl.selectionStart;
    let foundAt = -1;
    for (let i = pos - 1; i >= 0; i--) {
      if (val[i] === '@') { foundAt = i; break; }
      if (val[i] === ' ' || val[i] === '\n') { break; }
    }
    if (foundAt >= 0) {
      atMentionStart = foundAt;
      const query = val.slice(foundAt + 1, pos);
      if (filePicker.hidden) { openFilePicker(); }
      fpSearch.value = query;
      triggerSearch(query);
    } else {
      if (!filePicker.hidden && atMentionStart >= 0) { closeFilePicker(false); }
    }
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  function handleSend() {
    const raw = inputEl.value.trim();
    if (!raw || streaming) { return; }
    let text = raw, command;
    if (raw.startsWith('/')) {
      const sp = raw.indexOf(' ');
      command = sp === -1 ? raw.slice(1) : raw.slice(1, sp);
      text    = sp === -1 ? '' : raw.slice(sp + 1).trim();
    }
    appendUserMsg(raw);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    ctxLine.hidden = true;
    closeFilePicker(false);
    closeCmdPicker();
    closeModelPicker();
    refreshSendBtn();
    post('send', { text, command });
  }

  function clearConversation() { closeCmdPicker(); closeModelPicker(); post('send', { text: '', command: 'clear' }); }

  window.handleSend        = handleSend;
  window.clearConversation = clearConversation;
  window.closeUsage        = function () { usagePanel.hidden = true; };
  window.dismissCtx        = function () { ctxLine.hidden = true; };
  window.openAddFiles      = openAddFiles;
  window.toggleCmdPicker   = toggleCmdPicker;
  window.toggleModelPicker = toggleModelPicker;
  window.closeFilePicker   = function () { closeFilePicker(true); };

  // ── + button ─────────────────────────────────────────────────────────────
  function openAddFiles() {
    closeCmdPicker();
    closeModelPicker();
    atMentionStart = -1;   // not an @ trigger
    openFilePicker();
    fpSearch.focus();
    triggerSearch('');
  }

  // ── / button — commands picker ────────────────────────────────────────────
  function toggleCmdPicker() {
    if (cmdPickerOpen) { closeCmdPicker(); } else { openCmdPicker(); }
  }
  function openCmdPicker() {
    cmdPickerOpen = true;
    cmdPicker.hidden = false;
    closeFilePicker(false);
    closeModelPicker();
  }
  function closeCmdPicker() {
    cmdPickerOpen = false;
    cmdPicker.hidden = true;
  }

  // Wire up command items
  cmdPicker.querySelectorAll('.cp-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const cmd = btn.dataset.cmd;
      closeCmdPicker();
      inputEl.value = '';
      inputEl.style.height = 'auto';
      appendUserMsg('/' + cmd);
      post('send', { text: '', command: cmd });
    });
  });

  // ── File picker ───────────────────────────────────────────────────────────
  function openFilePicker() {
    closeCmdPicker();
    filePicker.hidden = false;
    fpSearch.focus();
    triggerSearch(fpSearch.value || '');
  }

  function closeFilePicker(removeAt) {
    filePicker.hidden = true;
    fpResults.innerHTML = '';
    if (removeAt && atMentionStart >= 0) {
      const val = inputEl.value;
      const pos = inputEl.selectionStart;
      inputEl.value = val.slice(0, atMentionStart) + val.slice(pos);
      inputEl.setSelectionRange(atMentionStart, atMentionStart);
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    }
    fpSearch.value = '';
    atMentionStart = -1;
    inputEl.focus();
  }

  fpSearch.addEventListener('input', function () { triggerSearch(fpSearch.value); });
  fpSearch.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeFilePicker(true); }
    if (e.key === 'Enter') { var first = fpResults.querySelector('.fp-item'); if (first) { first.click(); } e.preventDefault(); }
    if (e.key === 'ArrowDown') {
      var items = fpResults.querySelectorAll('.fp-item');
      if (items.length) { items[0].focus(); } e.preventDefault();
    }
  });
  document.getElementById('fp-close').addEventListener('click', function () { closeFilePicker(true); });

  function triggerSearch(query) {
    clearTimeout(fpSearchTimer);
    fpSearchTimer = setTimeout(function () { post('searchFiles', { query: query }); }, 150);
  }

  function renderFileResults(files) {
    fpResults.innerHTML = '';
    if (!files || files.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'fp-empty';
      empty.textContent = 'No files found';
      fpResults.appendChild(empty);
      return;
    }
    files.forEach(function (f) {
      var btn = document.createElement('button');
      btn.className = 'fp-item';
      // Left side: icon + name
      var left = document.createElement('div');
      left.className = 'fp-item-left';
      var icon = document.createElement('span');
      icon.className = 'fp-icon';
      icon.textContent = f.isFolder ? '□' : '∙';
      var name = document.createElement('span');
      name.className = 'fp-name';
      name.textContent = f.isFolder ? f.name + '' : f.name;
      left.appendChild(icon);
      left.appendChild(name);
      // Right side: parent path
      var rel = document.createElement('span');
      rel.className = 'fp-relpath';
      rel.textContent = f.relPath || '';
      btn.appendChild(left);
      btn.appendChild(rel);
      btn.addEventListener('click', function () {
        // Remove the @query text from textarea if applicable
        if (atMentionStart >= 0) {
          var val = inputEl.value;
          var pos = inputEl.selectionStart;
          inputEl.value = val.slice(0, atMentionStart) + val.slice(pos);
          inputEl.setSelectionRange(atMentionStart, atMentionStart);
          inputEl.style.height = 'auto';
          inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
          atMentionStart = -1;
        }
        filePicker.hidden = true;
        fpSearch.value = '';
        fpResults.innerHTML = '';
        inputEl.focus();
        post('addFile', { uri: f.uri, name: f.isFolder ? f.name : f.name });
      });
      fpResults.appendChild(btn);
    });
  }

  // ── Attachment chips ──────────────────────────────────────────────────────
  function updateChips() {
    tbChips.innerHTML = '';
    attachments.forEach(function (att, idx) {
      var chip = document.createElement('div');

      if (att.dataUrl) {
        // Image chip with thumbnail
        chip.className = 'tb-chip tb-chip-img';
        var thumb = document.createElement('img');
        thumb.className = 'tb-chip-thumb';
        thumb.src = att.dataUrl;
        thumb.alt = att.name;
        var info = document.createElement('div');
        info.className = 'tb-chip-info';
        var iname = document.createElement('span');
        iname.className = 'tb-chip-iname';
        iname.title = att.name;
        iname.textContent = att.name;
        info.appendChild(iname);
        if (att.width && att.height) {
          var dim = document.createElement('span');
          dim.className = 'tb-chip-dim';
          dim.textContent = att.width + '×' + att.height;
          info.appendChild(dim);
        }
        chip.appendChild(thumb);
        chip.appendChild(info);
      } else {
        // Regular file/folder chip
        chip.className = 'tb-chip';
        var nameSpan = document.createElement('span');
        nameSpan.className = 'tb-chip-name';
        nameSpan.title = att.name;
        nameSpan.textContent = (att.isFolder ? '□ ' : '') + att.name;
        chip.appendChild(nameSpan);
      }

      var rm = document.createElement('button');
      rm.className = 'tb-chip-rm';
      rm.title = 'Remove';
      rm.textContent = '×';
      rm.addEventListener('click', function () { removeAttachment(idx, att.uri); });
      chip.appendChild(rm);
      tbChips.appendChild(chip);
    });
  }

  function removeAttachment(idx, uri) {
    attachments.splice(idx, 1);
    updateChips();
    if (uri) { post('removeAttachment', { uri: uri }); }
  }

  function clearAttachments() { attachments = []; updateChips(); }

  // ── Model picker ──────────────────────────────────────────────────────────
  function toggleModelPicker() {
    if (!modelPicker.hidden) { closeModelPicker(); } else { openModelPicker(); }
  }
  function openModelPicker() {
    buildModelList();
    modelPicker.hidden = false;
    modelBtn.classList.add('open');
    closeCmdPicker();
    closeFilePicker(false);
  }
  function closeModelPicker() {
    modelPicker.hidden = true;
    modelBtn.classList.remove('open');
  }
  function buildModelList() {
    mpList.innerHTML = '';
    const cur = modelBtn.dataset.model || '';
    availableModels.forEach(function (m) {
      var btn = document.createElement('button');
      btn.className = 'mp-item' + (m === cur ? ' current' : '');
      var label = document.createElement('span');
      label.textContent = m;
      btn.appendChild(label);
      if (m === cur) {
        var badge = document.createElement('span');
        badge.className = 'mp-badge';
        badge.textContent = 'current';
        btn.appendChild(badge);
      }
      btn.addEventListener('click', function () { post('selectModel', { model: m }); closeModelPicker(); });
      mpList.appendChild(btn);
    });
  }
  document.addEventListener('click', function (e) {
    var bw = document.getElementById('bottom-wrap');
    if (!modelPicker.hidden && bw && !bw.contains(e.target)) { closeModelPicker(); }
  });

  // ── Mode / YOLO ───────────────────────────────────────────────────────────
  modeBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.dataset.mode;
      modeBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
      post('setMode', { mode: mode });
    });
  });
  yoloBtn.addEventListener('click', function () { post('toggleYolo'); });

  // ── Drag & drop ───────────────────────────────────────────────────────────
  var dragCounter = 0;
  document.addEventListener('dragenter', function (e) {
    e.preventDefault(); dragCounter++;
    if (dragCounter === 1) { dropOverlay.classList.add('active'); }
  });
  document.addEventListener('dragleave', function (e) {
    e.preventDefault(); dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) { dropOverlay.classList.remove('active'); }
  });
  document.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', function (e) {
    e.preventDefault(); dragCounter = 0;
    dropOverlay.classList.remove('active');
    var uriList = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    if (uriList.trim()) { post('drop', { uriList: uriList }); }
  });

  // ── Messages ─────────────────────────────────────────────────────────────
  function appendUserMsg(text) {
    hideEmpty();
    var wrap = document.createElement('div');
    wrap.className = 'msg user';
    var bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollBottom();
  }

  // ── Markdown renderer ─────────────────────────────────────────────────────
  function renderInline(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  }

  function renderMarkdown(md) {
    var segments = [], fenceRe = /^(`{3,})(\w*)\n([\s\S]*?)\n?\1[ \t]*$/gm, lastIdx = 0, m;
    while ((m = fenceRe.exec(md)) !== null) {
      if (m.index > lastIdx) { segments.push({ type: 'text', content: md.slice(lastIdx, m.index) }); }
      segments.push({ type: 'code', lang: m[2], content: m[3] });
      lastIdx = fenceRe.lastIndex;
    }
    var tail = md.slice(lastIdx);
    if (tail) {
      var um = tail.match(/`{3,}(\w*)\n([\s\S]*)$/);
      if (um) {
        var fence = tail.lastIndexOf(um[0]);
        if (fence > 0) { segments.push({ type: 'text', content: tail.slice(0, fence) }); }
        segments.push({ type: 'code', lang: um[1], content: um[2], open: true });
      } else { segments.push({ type: 'text', content: tail }); }
    }
    return segments.map(function (seg) {
      if (seg.type === 'code') {
        var lang = esc(seg.lang||''), code = esc(seg.content);
        return '<pre>' + (lang ? '<span class="code-lang">'+lang+'</span>' : '') + '<code>'+code+'</code></pre>';
      }
      return renderBlock(seg.content);
    }).join('');
  }

  function renderBlock(text) {
    var lines = text.split('\n'), html = '', i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var hm = line.match(/^(#{1,6}) (.+)$/);
      if (hm) { var lvl=hm[1].length; html += '<h'+lvl+'>'+renderInline(esc(hm[2]))+'</h'+lvl+'>'; i++; continue; }
      if (/^([-*_]){3,}$/.test(line.trim())) { html += '<hr>'; i++; continue; }
      if (line.startsWith('> ')) {
        var bq = ''; while (i < lines.length && lines[i].startsWith('> ')) { bq += lines[i].slice(2)+'\n'; i++; }
        html += '<blockquote>'+renderBlock(bq)+'</blockquote>'; continue;
      }
      if (/^[-*+] /.test(line)) {
        html += '<ul>';
        while (i < lines.length && /^[-*+] /.test(lines[i])) { html += '<li>'+renderInline(esc(lines[i].slice(2)))+'</li>'; i++; }
        html += '</ul>'; continue;
      }
      if (/^\d+[.)]\s/.test(line)) {
        html += '<ol>';
        while (i < lines.length && /^\d+[.)]\s/.test(lines[i])) { html += '<li>'+renderInline(esc(lines[i].replace(/^\d+[.)]\s/,'')))+'</li>'; i++; }
        html += '</ol>'; continue;
      }
      if (line.includes('|') && i+1 < lines.length && /^[\s|:-]+$/.test(lines[i+1])) {
        var hCells = line.split('|').filter(function(c){return c.trim()!=='';});
        var tbl = '<table><thead><tr>'+hCells.map(function(c){return '<th>'+renderInline(esc(c.trim()))+'</th>';}).join('')+'</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].includes('|')) {
          var cells = lines[i].split('|').filter(function(c){return c.trim()!=='';});
          tbl += '<tr>'+cells.map(function(c){return '<td>'+renderInline(esc(c.trim()))+'</td>';}).join('')+'</tr>'; i++;
        }
        html += tbl+'</tbody></table>'; continue;
      }
      if (line.trim() === '') { i++; continue; }
      var paraLines = [];
      while (i < lines.length && lines[i].trim() !== '' &&
             !/^(#{1,6} |> |[-*+] |\d+[.)]\s|([-*_]){3,})/.test(lines[i]) &&
             !lines[i].includes('|')) { paraLines.push(lines[i]); i++; }
      if (paraLines.length) { html += '<p>'+renderInline(esc(paraLines.join('\n'))).replace(/\n/g,'<br>')+'</p>'; }
    }
    return html;
  }

  // ── Usage panel ───────────────────────────────────────────────────────────
  function showUsage(data) {
    var s=data.session||0, d=data.daily||0, w=data.weekly||0, limit=data.dailyLimit||0, reqs=data.requests||0;
    var fp = function(n){ return limit > 0 ? Math.min(100, Math.round(n/limit*100)) : 0; };
    document.getElementById('session-val').textContent  = fmtTok(s)+' tokens';
    document.getElementById('session-fill').style.width = (limit>0?fp(s):45)+'%';
    document.getElementById('daily-val').textContent    = limit>0 ? fmtTok(d)+' / '+fmtTok(limit)+' ('+fp(d)+'%)' : fmtTok(d)+' tokens';
    document.getElementById('daily-fill').style.width   = fp(d)+'%';
    document.getElementById('weekly-val').textContent   = fmtTok(w)+' tokens';
    document.getElementById('weekly-fill').style.width  = '0%';
    document.getElementById('usage-requests').textContent = reqs+' request'+(reqs!==1?'s':'')+' this session';
    usagePanel.hidden = false;
  }

  // ── Extension → webview ───────────────────────────────────────────────────
  window.addEventListener('message', function (e) {
    var msg = e.data;
    switch (msg.type) {

      case 'setState':
        if (msg.model !== undefined) {
          var short = msg.model.replace(/^claude-/,'').replace(/-\d{8}$/,'');
          modelBtn.textContent   = short;
          modelBtn.title         = msg.model+' — click to switch';
          modelBtn.dataset.model = msg.model;
        }
        if (msg.mode !== undefined) {
          modeBtns.forEach(function(b){ b.classList.toggle('active', b.dataset.mode === msg.mode); });
        }
        if (msg.yoloMode !== undefined) {
          yoloBtn.classList.toggle('on', !!msg.yoloMode);
          yoloBtn.textContent = msg.yoloMode ? '⚡ YOLO' : 'YOLO';
        }
        if (msg.availableModels && msg.availableModels.length) { availableModels = msg.availableModels; }
        break;

      case 'addUserMessage':
        appendUserMsg(msg.text);
        break;

      case 'streamStart': {
        hideEmpty(); usagePanel.hidden = true;
        streaming = true; currentRaw = ''; sendBtn.disabled = true;
        var wrap = document.createElement('div'); wrap.className = 'msg assistant';
        var sender = document.createElement('div'); sender.className = 'msg-sender'; sender.textContent = 'AVN Chat';
        var body = document.createElement('div'); body.className = 'msg-body';
        var dots = document.createElement('div'); dots.className = 'typing-dots';
        for (var d=0; d<3; d++) { var dot=document.createElement('div'); dot.className='dot'; dots.appendChild(dot); }
        body.appendChild(dots);
        wrap.appendChild(sender); wrap.appendChild(body);
        messagesEl.appendChild(wrap); currentEl = body; scrollBottom();
        break;
      }

      case 'streamChunk':
        if (!streaming || !currentEl) { break; }
        currentRaw += msg.text;
        currentEl.innerHTML = renderMarkdown(currentRaw);
        scrollBottom();
        break;

      case 'streamEnd':
        streaming = false; currentEl = null; currentRaw = '';
        refreshSendBtn();
        clearAttachments();
        break;

      case 'setStatus':
        statusDot.className = msg.status==='thinking' ? 'thinking' : msg.status==='error' ? 'error' : '';
        break;

      case 'showError': {
        hideEmpty();
        var ew = document.createElement('div'); ew.className = 'msg assistant';
        var es = document.createElement('div'); es.className = 'msg-sender'; es.textContent = 'AVN Chat';
        var eb = document.createElement('div'); eb.className = 'msg-body';
        eb.style.color = 'var(--vscode-errorForeground)'; eb.textContent = msg.text;
        ew.appendChild(es); ew.appendChild(eb);
        messagesEl.appendChild(ew); scrollBottom();
        break;
      }

      case 'clearMessages':
        while (messagesEl.firstChild) { messagesEl.removeChild(messagesEl.firstChild); }
        messagesEl.appendChild(emptyEl);
        streaming = false; currentEl = null; currentRaw = '';
        refreshSendBtn(); clearAttachments(); usagePanel.hidden = true;
        break;

      case 'filesAttached':
        // msg.files = [{ name, uri, isFolder?, dataUrl? }]
        (msg.files || []).forEach(function (f) {
          if (f.dataUrl) {
            // Resolve image dimensions from dataUrl
            var img = new Image();
            var captured = f;
            img.onload = function () {
              attachments.push({ name: captured.name, uri: captured.uri, isImage: true, dataUrl: captured.dataUrl, width: img.naturalWidth, height: img.naturalHeight });
              updateChips();
            };
            img.src = f.dataUrl;
          } else {
            attachments.push({ name: f.name, uri: f.uri, isFolder: !!f.isFolder });
            updateChips();
          }
        });
        break;

      case 'contextInfo':
        if (msg.kind === 'selection') {
          ctxTextEl.textContent = '📎 '+msg.lines+' selected lines · '+msg.file;
          ctxLine.hidden = false;
        } else {
          ctxLine.hidden = true;
        }
        break;

      case 'fileSearchResults':
        renderFileResults(msg.files);
        break;

      case 'showUsage':
        showUsage(msg);
        break;
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  refreshSendBtn();
  post('ready');

})();
