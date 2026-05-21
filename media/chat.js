(function () {
  'use strict';

  const vscApi    = acquireVsCodeApi();
  const ICON_BASE = (document.querySelector('meta[name="icon-base"]') || { getAttribute: function(){ return ''; } }).getAttribute('content') || '';

  // ── State ────────────────────────────────────────────────────────────────
  let streaming          = false;
  let currentEl          = null;
  let currentRaw         = '';
  let attachments        = [];
  let availableModels         = [];   // Claude models
  let availableOpenCodeModels = [];   // OpenCode models
  let currentBackend          = 'claude';
  let atMentionStart     = -1;
  let fpMode             = 'none';
  let fpHighIdx          = -1;
  let cpHighIdx          = -1;
  let fpSearchTimer      = null;
  let currentDisplayMode  = 'auto';
  let currentEffort       = 'high'; // effort level (low/medium/high), separate from on/off
  let progressItems       = [];
  let progressEl          = null;
  let currentFile         = null;   // { name, uri }
  let currentFileIncluded = false;
  let thinkingEnabled     = false;
  let symbolRefs          = [];   // { name, relPath, line, kind }

  // ── DOM ──────────────────────────────────────────────────────────────────
  const messagesEl   = document.getElementById('messages');
  const emptyEl      = document.getElementById('empty-state');
  const inputEl      = document.getElementById('user-input');
  const sendBtn      = document.getElementById('send-btn');
  const statusDot    = document.getElementById('status-dot');
  const modelBtn        = document.getElementById('model-btn');
  const displayModeBtn  = document.getElementById('display-mode-btn');
  const modePicker      = document.getElementById('mode-picker');
  const curFileBtn        = document.getElementById('cur-file-btn');
  const curFileNameEl     = document.getElementById('cur-file-name');
  const toolsBtn          = document.getElementById('tools-btn');
  const toolsPanel        = document.getElementById('tools-panel');
  const thinkingToggleBtn = document.getElementById('thinking-toggle');
  const effortRowEl       = document.getElementById('effort-row');
  const inputTop     = document.getElementById('input-top');
  const ctxLine      = document.getElementById('ctx-line');
  const ctxTextEl    = document.getElementById('ctx-text-inner');
  const dropOverlay  = document.getElementById('drop-overlay');
  const usagePanel   = document.getElementById('usage-panel');
  const filePicker   = document.getElementById('file-picker');
  const fpSearch     = document.getElementById('fp-search');
  const fpResults    = document.getElementById('fp-results');
  const cmdPicker    = document.getElementById('cmd-picker');
  const modelPicker  = document.getElementById('model-picker');
  const mpList       = document.getElementById('mp-list');
  const tbChips      = document.getElementById('tb-chips');
  const sessionsPanel= document.getElementById('sessions-panel');
  const spList       = document.getElementById('sp-list');
  const changeBar    = document.getElementById('change-bar');
  const cbText       = document.getElementById('cb-text');
  const cbFiles      = document.getElementById('cb-files');

  // ── Helpers ──────────────────────────────────────────────────────────────
  function post(type, extra) { vscApi.postMessage(Object.assign({ type }, extra || {})); }
  function hideEmpty() { if (emptyEl && emptyEl.parentNode) { emptyEl.remove(); } }
  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtTok(n) { if (n>=1e6){return (n/1e6).toFixed(1)+'M';} if(n>=1e3){return (n/1e3).toFixed(1)+'k';} return String(n); }
  function refreshInputTop() { inputTop.hidden = ctxLine.hidden && attachments.length === 0 && currentFile === null && symbolRefs.length === 0; }

  function updateCurrentFileBtn() {
    if (!currentFile) { curFileBtn.hidden = true; return; }
    curFileBtn.hidden = false;
    curFileNameEl.textContent = currentFile.name;
    curFileBtn.classList.toggle('included', currentFileIncluded);
    curFileBtn.title = (currentFileIncluded ? 'Exclude ' : 'Include ') + currentFile.name + ' as context';
  }

  curFileBtn.addEventListener('click', function() {
    if (!currentFile) { return; }
    currentFileIncluded = !currentFileIncluded;
    updateCurrentFileBtn();
  });

  // ── Clear all references (Escape) ─────────────────────────────────────────
  function clearAllReferences() {
    if (attachments.length > 0) { post('clearAttachments'); clearAttachments(); }
    if (!ctxLine.hidden) { ctxLine.hidden = true; }
    if (currentFileIncluded) { currentFileIncluded = false; updateCurrentFileBtn(); }
    refreshInputTop();
  }

  // ── Thinking toggle ────────────────────────────────────────────────────────
  function updateThinkingUI() {
    if (thinkingToggleBtn) { thinkingToggleBtn.classList.toggle('on', thinkingEnabled); }
    if (effortRowEl) { effortRowEl.classList.toggle('thinking-off', !thinkingEnabled); }
    var txt = document.getElementById('effort-level-text');
    if (txt) { txt.textContent = thinkingEnabled ? '(' + currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1) + ')' : ''; }
  }
  if (thinkingToggleBtn) {
    thinkingToggleBtn.addEventListener('click', function() {
      thinkingEnabled = !thinkingEnabled;
      post('setEffort', { effort: thinkingEnabled ? currentEffort : null });
      updateThinkingUI();
    });
  }

  // ── Tools / MCP panel ─────────────────────────────────────────────────────
  function openToolsPanel() {
    var rect = toolsBtn.getBoundingClientRect();
    _positionPicker(toolsPanel, rect, 300);
    toolsPanel.hidden = false; toolsBtn.classList.add('open');
    closeModelPicker(); closeModePicker(); closeCmdPicker(); closeFilePicker(false);
    post('getMCPs');
  }
  function closeToolsPanel() { toolsPanel.hidden = true; toolsBtn.classList.remove('open'); }
  function toggleToolsPanel() { toolsPanel.hidden ? openToolsPanel() : closeToolsPanel(); }
  if (toolsBtn)  { toolsBtn.addEventListener('click', toggleToolsPanel); }
  var tpClose  = document.getElementById('tp-close');   if (tpClose)  { tpClose.addEventListener('click', closeToolsPanel); }
  var tpAddBtn = document.getElementById('tp-add-btn'); if (tpAddBtn) { tpAddBtn.addEventListener('click', function(){ post('addMCP'); }); }

  function describeToolUse(name, input) {
    var i = input || {};
    var fp = i.file_path || i.path || '';
    switch (name) {
      case 'Read':      return 'Reading '      + fp;
      case 'Write':     return 'Writing '      + fp;
      case 'Edit':      return 'Editing '      + fp;
      case 'MultiEdit': return 'Editing '      + fp;
      case 'Bash':      return 'Running: '     + String(i.command || '').slice(0, 70);
      case 'Grep':      return 'Searching for ' + (i.pattern || i.regex || i.query || '');
      case 'Glob':      return 'Listing '      + (i.pattern || '');
      case 'LS':        return 'Listing '      + (i.path || '');
      case 'WebFetch':  return 'Fetching '     + (i.url || '');
      case 'WebSearch': return 'Web search: '  + (i.query || '');
      case 'TodoWrite': return 'Updating todos';
      case 'TodoRead':  return 'Reading todos';
      case 'Agent':     return 'Spawning agent' + (i.description ? ': ' + String(i.description).slice(0, 40) : '');
      default:          return name + (fp ? ': ' + fp : '');
    }
  }
  function timeSince(ts) {
    var d = Date.now() - ts, m = Math.floor(d/60000), h = Math.floor(d/3600000), day = Math.floor(d/86400000);
    if (m<1)   { return 'just now'; }
    if (m<60)  { return m+'m ago'; }
    if (h<24)  { return h+'h ago'; }
    if (day<7) { return day+'d ago'; }
    return new Date(ts).toLocaleDateString();
  }
  function refreshSendBtn() { sendBtn.disabled = streaming || inputEl.value.trim() === ''; }

  // ── Icon helper ───────────────────────────────────────────────────────────
  function makeIcon(name, isFolder) {
    var img = document.createElement('img');
    img.width = 16; img.height = 16; img.style.flexShrink = '0';
    if (!ICON_BASE) { img.style.display = 'none'; return img; }

    var base = isFolder ? 'folder' : (name.split('.').pop() || 'file').toLowerCase();
    // Try SVG → PNG for the specific type, then SVG → PNG for the generic fallback
    var queue = [
      ICON_BASE + '/' + base + '.svg',
      ICON_BASE + '/' + base + '.png',
    ];
    if (!isFolder && base !== 'file') {
      queue.push(ICON_BASE + '/file.svg', ICON_BASE + '/file.png');
    }
    var qi = 0;
    function tryNext() {
      if (qi >= queue.length) { img.style.display = 'none'; return; }
      img.src = queue[qi++];
    }
    img.onerror = tryNext;
    tryNext();
    return img;
  }

  // ── Button wiring (CSP-safe: no onclick attrs) ────────────────────────────
  document.getElementById('clear-btn').addEventListener('click',       function(){ clearConversation(); });
  document.getElementById('sessions-btn').addEventListener('click',    function(){ toggleSessionsPanel(); });
  document.getElementById('usage-close').addEventListener('click',     function(){ usagePanel.hidden = true; });
  document.getElementById('fp-close').addEventListener('click',        function(){ closeFilePicker(true); });
  document.getElementById('ctx-dismiss-btn').addEventListener('click', function(){ ctxLine.hidden = true; refreshInputTop(); });
  document.getElementById('add-btn').addEventListener('click',         function(){ openFilePicker_plus(); });
  document.getElementById('cmd-btn').addEventListener('click',         function(){ toggleCmdPicker(); });
  document.getElementById('cb-keep').addEventListener('click',         function(){ post('acceptChanges'); changeBar.hidden = true; });
  document.getElementById('cb-undo').addEventListener('click',         function(){ post('undoAllChanges'); changeBar.hidden = true; });
  document.getElementById('send-btn').addEventListener('click',        function(){ if (streaming) { post('cancel'); } else { handleSend(); } });
  document.getElementById('model-btn').addEventListener('click',       function(){ toggleModelPicker(); });
  document.getElementById('display-mode-btn').addEventListener('click', function(){ toggleModePicker(); });
  document.getElementById('sp-new').addEventListener('click',          function(){ post('createSession'); });
  document.getElementById('sp-close').addEventListener('click',        function(){ sessionsPanel.hidden = true; });

  // ── Input resize ──────────────────────────────────────────────────────────
  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    refreshSendBtn();
    checkAtMention();
    // Keep cmd picker in sync when user types /command
    var val = inputEl.value;
    if (val.startsWith('/')) {
      var query = val.slice(1).toLowerCase().trim();
      if (cmdPicker.hidden) { openCmdPicker(); }
      filterCmdPicker(query);
    } else if (!cmdPicker.hidden) {
      closeCmdPicker();
    }
  });

  // ── Keyboard ─────────────────────────────────────────────────────────────
  inputEl.addEventListener('keydown', function (e) {
    if (!filePicker.hidden && fpMode === 'at') {
      if (e.key === 'ArrowDown')            { e.preventDefault(); moveFpHighlight(1); return; }
      if (e.key === 'ArrowUp')              { e.preventDefault(); moveFpHighlight(-1); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectFpHighlighted(); return; }
      if (e.key === 'Escape')               { closeFilePicker(true); return; }
      return; // other keys pass through (user typing search query)
    }
    if (!cmdPicker.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveCpHighlight(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveCpHighlight(-1); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectCpHighlighted(); return; }
      if (e.key === 'Escape')    { closeCmdPicker(); inputEl.value = ''; inputEl.style.height = 'auto'; refreshSendBtn(); return; }
      // Other keys fall through so the user can type to filter
    }
    if (!modelPicker.hidden && e.key === 'Escape') { closeModelPicker(); return; }
    if (!modePicker.hidden  && e.key === 'Escape') { closeModePicker();  return; }
    if (!sessionsPanel.hidden && e.key === 'Escape') { sessionsPanel.hidden = true; return; }
    if (e.key === 'Escape') { if (streaming) { post('cancel'); return; } clearAllReferences(); return; }
    if (e.key === '/' && inputEl.value.trim() === '') { openCmdPicker(); return; }

    // ── Auto-continue numbered lists and blockquotes on Shift+Enter ─────────
    if (e.key === 'Enter' && e.shiftKey) {
      var val = inputEl.value, pos = inputEl.selectionStart, sel = inputEl.selectionEnd;
      var lineStart = val.lastIndexOf('\n', pos - 1) + 1;
      var currentLine = val.slice(lineStart, pos);
      var numMatch   = currentLine.match(/^(\d+)\. ([\s\S]*)$/);
      var quoteMatch = !numMatch && currentLine.match(/^> ([\s\S]*)$/);
      if (numMatch || quoteMatch) {
        e.preventDefault();
        var content = numMatch ? numMatch[2] : quoteMatch[1];
        if (content === '') {
          // Empty list item — exit the format, remove the prefix
          inputEl.value = val.slice(0, lineStart) + val.slice(sel);
          inputEl.setSelectionRange(lineStart, lineStart);
        } else {
          var prefix = numMatch ? (parseInt(numMatch[1], 10) + 1) + '. ' : '> ';
          var ins = '\n' + prefix;
          inputEl.value = val.slice(0, pos) + ins + val.slice(sel);
          var np = pos + ins.length;
          inputEl.setSelectionRange(np, np);
        }
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
        refreshSendBtn();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  fpSearch.addEventListener('keydown', function (e) {
    if (e.key === 'Escape')    { closeFilePicker(true); }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFpHighlight(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveFpHighlight(-1); }
    if (e.key === 'Enter')     { e.preventDefault(); selectFpHighlighted(); }
  });
  fpSearch.addEventListener('input', function () { triggerSearch(fpSearch.value); });
  inputEl.addEventListener('focus', function () { post('requestContext'); });

  // ── @ mention ─────────────────────────────────────────────────────────────
  function checkAtMention() {
    var val = inputEl.value, pos = inputEl.selectionStart, foundAt = -1;
    for (var i = pos - 1; i >= 0; i--) {
      if (val[i] === '@') { foundAt = i; break; }
      if (val[i] === ' ' || val[i] === '\n') { break; }
    }
    if (foundAt >= 0) {
      atMentionStart = foundAt;
      if (filePicker.hidden || fpMode !== 'at') { openFilePicker_at(); }
      triggerSearch(val.slice(foundAt + 1, pos));
    } else {
      if (!filePicker.hidden && fpMode === 'at') { closeFilePicker(false); }
    }
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  function handleSend() {
    var raw = inputEl.value.trim();
    if (!raw || streaming) { return; }
    var text = raw, command;
    if (raw.startsWith('/')) { var sp = raw.indexOf(' '); command = sp===-1?raw.slice(1):raw.slice(1,sp); text=sp===-1?'':raw.slice(sp+1).trim(); }
    appendUserMsg(raw);
    inputEl.value = ''; inputEl.style.height = 'auto';
    ctxLine.hidden = true; refreshInputTop();
    closeFilePicker(false); closeCmdPicker(); closeModelPicker();
    refreshSendBtn();
    var sendPayload = { text: text, command: command, rawText: raw };
    if (currentFileIncluded && currentFile) { sendPayload.currentFileRef = currentFile.uri; }
    post('send', sendPayload);
  }

  function clearConversation() { closeCmdPicker(); closeModelPicker(); post('send', { text: '', command: 'clear' }); }

  // ── File picker ───────────────────────────────────────────────────────────
  function _positionPicker(el, anchorRect, w) {
    var left = anchorRect.left;
    if (left + w > window.innerWidth - 8) { left = window.innerWidth - w - 8; }
    if (left < 8) { left = 8; }
    el.style.left = left + 'px'; el.style.right = 'auto';
    el.style.bottom = (window.innerHeight - anchorRect.top + 6) + 'px'; el.style.top = 'auto';
  }
  function openFilePicker_at() {
    fpMode = 'at'; fpHighIdx = -1;
    filePicker.classList.add('at-mode');
    var rect = document.getElementById('input-card').getBoundingClientRect();
    _positionPicker(filePicker, rect, 320);
    filePicker.hidden = false;
    closeCmdPicker(); closeModelPicker(); closeModePicker();
  }
  function openFilePicker_plus() {
    fpMode = 'plus'; fpHighIdx = -1; atMentionStart = -1;
    filePicker.classList.remove('at-mode');
    var rect = document.getElementById('add-btn').getBoundingClientRect();
    _positionPicker(filePicker, rect, 320);
    filePicker.hidden = false;
    fpSearch.value = ''; closeCmdPicker(); closeModelPicker(); closeModePicker();
    fpSearch.focus(); triggerSearch('');
  }
  function closeFilePicker(removeAt) {
    filePicker.hidden = true; filePicker.classList.remove('at-mode');
    fpResults.innerHTML = ''; fpHighIdx = -1; fpSearch.value = '';
    if (removeAt && atMentionStart >= 0) {
      var val = inputEl.value, pos = inputEl.selectionStart;
      inputEl.value = val.slice(0, atMentionStart) + val.slice(pos);
      inputEl.setSelectionRange(atMentionStart, atMentionStart);
      inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    }
    atMentionStart = -1; fpMode = 'none'; inputEl.focus();
  }
  function triggerSearch(query) {
    clearTimeout(fpSearchTimer); fpSearchTimer = setTimeout(function(){ post('searchFiles', { query: query }); }, 150);
  }
  function moveFpHighlight(delta) {
    var items = fpResults.querySelectorAll('.fp-item'); if (!items.length) { return; }
    fpHighIdx = fpHighIdx < 0 ? (delta>0?0:items.length-1) : Math.max(0, Math.min(items.length-1, fpHighIdx+delta));
    items.forEach(function(el,i){ el.classList.toggle('fp-hi', i===fpHighIdx); if(i===fpHighIdx){el.scrollIntoView({block:'nearest'});} });
  }
  function selectFpHighlighted() {
    var items = fpResults.querySelectorAll('.fp-item');
    var t = fpHighIdx>=0 && items[fpHighIdx] ? items[fpHighIdx] : items[0];
    if (t) { t.click(); }
  }
  function renderFileResults(files) {
    fpResults.innerHTML = '';
    if (!files || !files.length) { fpHighIdx=-1; var e2=document.createElement('div');e2.className='fp-empty';e2.textContent='No files found';fpResults.appendChild(e2);return; }
    var addedUris = new Set(attachments.map(function(a) { return a.uri || ''; }));
    if (currentFileIncluded && currentFile) { addedUris.add(currentFile.uri || ''); }
    fpHighIdx = -1;
    files.forEach(function(f, idx) {
      var alreadyAdded = addedUris.has(f.uri || '');
      var cls = 'fp-item' + (alreadyAdded ? ' fp-added' : '');
      if (!alreadyAdded && fpHighIdx === -1) { fpHighIdx = idx; cls += ' fp-hi'; }
      var btn = document.createElement('button'); btn.className = cls;

      // Top row: icon + filename
      var topRow = document.createElement('div'); topRow.className = 'fp-item-top';
      topRow.appendChild(makeIcon(f.name, f.isFolder));
      var nameEl = document.createElement('span'); nameEl.className = 'fp-name'; nameEl.textContent = f.name;
      if (alreadyAdded) {
        var tag = document.createElement('span'); tag.className = 'fp-added-tag'; tag.textContent = 'added';
        nameEl.appendChild(tag);
      }
      topRow.appendChild(nameEl);
      btn.appendChild(topRow);

      // Bottom row: path (only when non-empty)
      if (f.relPath) {
        var pathEl = document.createElement('div'); pathEl.className = 'fp-relpath'; pathEl.textContent = f.relPath;
        btn.appendChild(pathEl);
      }

      if (!alreadyAdded) { btn.addEventListener('click', function() { selectFile(f); }); }
      fpResults.appendChild(btn);
    });
  }
  function selectFile(f) {
    if (atMentionStart >= 0) {
      var val=inputEl.value, pos=inputEl.selectionStart;
      inputEl.value=val.slice(0,atMentionStart)+val.slice(pos); inputEl.setSelectionRange(atMentionStart,atMentionStart);
      inputEl.style.height='auto'; inputEl.style.height=Math.min(inputEl.scrollHeight,120)+'px'; atMentionStart=-1;
    }
    filePicker.hidden=true; filePicker.classList.remove('at-mode'); fpSearch.value=''; fpResults.innerHTML=''; fpHighIdx=-1; fpMode='none'; inputEl.focus();
    post('addFile', { uri: f.uri, name: f.name });
  }

  // ── Commands picker ───────────────────────────────────────────────────────
  function openCmdPicker() {
    // Reset filter — show all items
    cmdPicker.querySelectorAll('.cp-item').forEach(function(el){ el.hidden=false; });
    var items=cmdPicker.querySelectorAll('.cp-item');
    cpHighIdx=items.length>0?0:-1;
    items.forEach(function(el,i){el.classList.toggle('cp-hi',i===0);});
    var rect=document.getElementById('cmd-btn').getBoundingClientRect();
    var pickerW=260; var left=rect.left;
    if(left+pickerW>window.innerWidth-8){left=window.innerWidth-pickerW-8;}
    if(left<8){left=8;}
    cmdPicker.style.left=left+'px'; cmdPicker.style.right='auto';
    cmdPicker.style.bottom=(window.innerHeight-rect.top+6)+'px'; cmdPicker.style.top='auto';
    cmdPicker.hidden=false; closeFilePicker(false); closeModelPicker(); closeModePicker();
  }
  function closeCmdPicker() { cmdPicker.hidden=true; cpHighIdx=-1; }
  function toggleCmdPicker(){ cmdPicker.hidden ? openCmdPicker() : closeCmdPicker(); }
  function filterCmdPicker(query) {
    var items=cmdPicker.querySelectorAll('.cp-item');
    items.forEach(function(el){ el.classList.remove('cp-hi'); });
    var visible=[];
    items.forEach(function(el){
      var cmd=(el.dataset.cmd||'').toLowerCase();
      var show=!query||cmd.startsWith(query)||cmd.includes(query);
      el.hidden=!show;
      if(show){visible.push(el);}
    });
    cpHighIdx=visible.length?0:-1;
    if(visible.length){visible[0].classList.add('cp-hi');}
  }
  function moveCpHighlight(delta) {
    var items=Array.from(cmdPicker.querySelectorAll('.cp-item:not([hidden])')); if(!items.length){return;}
    cpHighIdx=cpHighIdx<0?(delta>0?0:items.length-1):Math.max(0,Math.min(items.length-1,cpHighIdx+delta));
    items.forEach(function(el,i){el.classList.toggle('cp-hi',i===cpHighIdx);if(i===cpHighIdx){el.scrollIntoView({block:'nearest'});}});
  }
  function selectCpHighlighted() {
    var items=cmdPicker.querySelectorAll('.cp-item:not([hidden])');
    var t=items[cpHighIdx>=0?cpHighIdx:0]; if(t){t.click();}
  }
  cmdPicker.addEventListener('click', function(e) {
    var item = e.target.closest('.cp-item'); if(!item){return;}
    var cmd=item.dataset.cmd; closeCmdPicker(); inputEl.value=''; inputEl.style.height='auto'; refreshSendBtn();
    appendUserMsg('/'+cmd); post('send',{text:'',command:cmd});
  });

  // ── Model picker ──────────────────────────────────────────────────────────
  function openModelPicker() {
    buildModelList();
    var rect = modelBtn.getBoundingClientRect();
    var pickerW = 260;
    var left = rect.left;
    if (left + pickerW > window.innerWidth - 8) { left = window.innerWidth - pickerW - 8; }
    if (left < 8) { left = 8; }
    modelPicker.style.left   = left + 'px';
    modelPicker.style.right  = 'auto';
    modelPicker.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    modelPicker.style.top    = 'auto';
    modelPicker.hidden = false; modelBtn.classList.add('open');
    closeCmdPicker(); closeFilePicker(false); closeModePicker();
  }
  function closeModelPicker() { modelPicker.hidden=true; modelBtn.classList.remove('open'); }
  function toggleModelPicker(){ modelPicker.hidden ? openModelPicker() : closeModelPicker(); }
  function updateBackendTabs() {
    document.querySelectorAll('.mp-tab').forEach(function(tab) {
      tab.classList.toggle('active', tab.dataset.backend === currentBackend);
    });
    // Hide Extended Thinking rows when on OpenCode (no --effort support)
    var thinkRow = document.querySelector('.mode-thinking-row');
    var effortRow = document.getElementById('effort-row');
    var isOC = currentBackend === 'opencode';
    if (thinkRow)  { thinkRow.style.display  = isOC ? 'none' : ''; }
    if (effortRow) { effortRow.style.display = isOC ? 'none' : ''; }
  }

  var mpFooter = document.getElementById('mp-footer');
  var mpAddBtn = document.getElementById('mp-add-btn');

  function buildModelList() {
    mpList.innerHTML = '';
    var isOC   = currentBackend === 'opencode';
    var cur    = modelBtn.dataset.model || '';
    var models = isOC ? availableOpenCodeModels : availableModels;

    // Show/hide footer add button for OpenCode tab
    if (mpFooter) { mpFooter.hidden = !isOC; }

    if (!models.length) {
      var empty = document.createElement('div'); empty.className = 'mp-empty';
      empty.textContent = isOC ? 'No models added yet. Click "+ Add model" below.' : 'No models configured.';
      mpList.appendChild(empty);
      return;
    }
    models.forEach(function(m) {
      var btn = document.createElement('button'); btn.className = 'mp-item' + (m === cur ? ' current' : '');
      var lbl = document.createElement('span'); lbl.className = 'mp-item-label'; lbl.textContent = m; btn.appendChild(lbl);
      if (m === cur) { var b = document.createElement('span'); b.className = 'mp-badge'; b.textContent = 'current'; btn.appendChild(b); }
      btn.addEventListener('click', function() { post('selectModel', { model: m }); closeModelPicker(); });
      // × remove button for OpenCode models
      if (isOC) {
        var rm = document.createElement('button'); rm.className = 'mp-item-rm'; rm.textContent = '×'; rm.title = 'Remove';
        (function(model) {
          rm.addEventListener('click', function(e) { e.stopPropagation(); post('removeOpenCodeModel', { model: model }); });
        })(m);
        btn.appendChild(rm);
      }
      mpList.appendChild(btn);
    });
  }

  if (mpAddBtn) { mpAddBtn.addEventListener('click', function() { post('addOpenCodeModel'); }); }

  // Backend tab click
  var mpTabsEl = document.getElementById('mp-tabs');
  if (mpTabsEl) {
    mpTabsEl.addEventListener('click', function(e) {
      var tab = e.target.closest('.mp-tab');
      if (!tab || !tab.dataset.backend) { return; }
      var backend = tab.dataset.backend;
      if (backend === currentBackend) { return; }
      currentBackend = backend;
      updateBackendTabs();
      buildModelList();
      post('selectBackend', { backend: backend });
    });
  }
  document.addEventListener('click', function(e) {
    if(!modelPicker.hidden && !modelPicker.contains(e.target) && !modelBtn.contains(e.target)){closeModelPicker();}
    if(!modePicker.hidden  && !modePicker.contains(e.target)  && !displayModeBtn.contains(e.target)){closeModePicker();}
    if(!cmdPicker.hidden   && !cmdPicker.contains(e.target)   && e.target.id!=='cmd-btn'){closeCmdPicker();}
    if(!filePicker.hidden  && !filePicker.contains(e.target)  && e.target.id!=='add-btn' && !inputEl.contains(e.target)){closeFilePicker(fpMode==='at');}
    if(!toolsPanel.hidden  && !toolsPanel.contains(e.target)  && !toolsBtn.contains(e.target)){closeToolsPanel();}
  });

  // ── Sessions panel ────────────────────────────────────────────────────────
  function toggleSessionsPanel() { sessionsPanel.hidden = !sessionsPanel.hidden; }

  function renderSessions(sessions, activeId) {
    spList.innerHTML = '';
    if (!sessions || !sessions.length) {
      var empty = document.createElement('div'); empty.className = 'sp-empty'; empty.textContent = 'No sessions yet.'; spList.appendChild(empty); return;
    }
    sessions.forEach(function(s) {
      var item = document.createElement('div');
      item.className = 'sp-item' + (s.id === activeId ? ' active' : '');
      item.dataset.id = s.id;

      var dot = document.createElement('div'); dot.className = 'sp-dot';
      var info = document.createElement('div'); info.className = 'sp-info';
      var nameEl = document.createElement('div'); nameEl.className = 'sp-name'; nameEl.textContent = s.name;
      var prevEl = document.createElement('div'); prevEl.className = 'sp-preview'; prevEl.textContent = s.preview || 'No messages yet';
      var timeEl = document.createElement('div'); timeEl.className = 'sp-time'; timeEl.textContent = timeSince(s.updatedAt);
      info.appendChild(nameEl); info.appendChild(prevEl); info.appendChild(timeEl);

      var actions = document.createElement('div'); actions.className = 'sp-actions';
      var renameBtn = document.createElement('button'); renameBtn.className = 'sp-action-btn'; renameBtn.title = 'Rename'; renameBtn.textContent = '✏';
      var deleteBtn = document.createElement('button'); deleteBtn.className = 'sp-action-btn delete'; deleteBtn.title = 'Delete'; deleteBtn.textContent = '🗑';

      renameBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        startRename(item, nameEl, s.id, s.name);
      });
      deleteBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        item.style.opacity = '0'; item.style.transform = 'translateX(20px)'; item.style.transition = 'all .2s ease';
        setTimeout(function() { post('deleteSession', { sessionId: s.id }); }, 200);
      });

      actions.appendChild(renameBtn); actions.appendChild(deleteBtn);
      item.appendChild(dot); item.appendChild(info); item.appendChild(actions);

      // Click to switch session
      item.addEventListener('click', function() {
        if (s.id !== activeId) { post('switchSession', { sessionId: s.id }); sessionsPanel.hidden = true; }
      });

      spList.appendChild(item);
    });
  }

  function startRename(item, nameEl, sessionId, currentName) {
    var input = document.createElement('input');
    input.className = 'sp-rename-input'; input.value = currentName;
    nameEl.replaceWith(input); input.focus(); input.select();
    function commit() {
      var newName = input.value.trim() || currentName;
      post('renameSession', { sessionId: sessionId, name: newName });
      var restored = document.createElement('div'); restored.className = 'sp-name'; restored.textContent = newName;
      input.replaceWith(restored);
    }
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { var r=document.createElement('div');r.className='sp-name';r.textContent=currentName;input.replaceWith(r); }
    });
    input.addEventListener('blur', commit);
  }

  // ── Mode picker ───────────────────────────────────────────────────────────
  function openModePicker() {
    var rect = displayModeBtn.getBoundingClientRect();
    var pickerW = 280;
    var left = rect.left;
    if (left + pickerW > window.innerWidth - 8) { left = window.innerWidth - pickerW - 8; }
    if (left < 8) { left = 8; }
    modePicker.style.left   = left + 'px';
    modePicker.style.right  = 'auto';
    modePicker.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    modePicker.style.top    = 'auto';
    modePicker.hidden = false; displayModeBtn.classList.add('open');
    closeModelPicker(); closeCmdPicker(); closeFilePicker(false);
  }
  function closeModePicker() { modePicker.hidden=true; displayModeBtn.classList.remove('open'); }
  function toggleModePicker(){ modePicker.hidden ? openModePicker() : closeModePicker(); }

  function updateDisplayModeUI(dm) {
    currentDisplayMode = dm;
    document.querySelectorAll('.dm-opt').forEach(function(el){ el.classList.toggle('active', el.dataset.dm === dm); });
    document.querySelectorAll('.mode-item').forEach(function(el){ el.classList.toggle('current', el.dataset.displayMode === dm); });
  }

  function updateEffortDots(level) {
    if (level) { currentEffort = level; }
    var order = { low: 1, medium: 2, high: 3 };
    var n = order[currentEffort] || 3;
    document.querySelectorAll('.effort-dot').forEach(function(dot, idx){ dot.classList.toggle('active', idx < n); });
    updateThinkingUI();
  }

  modePicker.addEventListener('click', function(e) {
    var item = e.target.closest('.mode-item');
    if (item && item.dataset.displayMode) {
      post('selectMode', { displayMode: item.dataset.displayMode });
      updateDisplayModeUI(item.dataset.displayMode);
      closeModePicker();
      return;
    }
    var dot = e.target.closest('.effort-dot');
    if (dot && dot.dataset.level) {
      currentEffort = dot.dataset.level;
      if (thinkingEnabled) { post('setEffort', { effort: dot.dataset.level }); }
      updateEffortDots(dot.dataset.level);
    }
  });

  // ── Drag & drop ───────────────────────────────────────────────────────────
  var dragCounter = 0;
  document.addEventListener('dragenter', function(e){e.preventDefault();dragCounter++;if(dragCounter===1){dropOverlay.classList.add('active');}});
  document.addEventListener('dragleave', function(e){e.preventDefault();dragCounter=Math.max(0,dragCounter-1);if(dragCounter===0){dropOverlay.classList.remove('active');}});
  document.addEventListener('dragover',  function(e){e.preventDefault();e.dataTransfer.dropEffect='copy';});
  document.addEventListener('drop', function(e){
    e.preventDefault();dragCounter=0;dropOverlay.classList.remove('active');
    var u=e.dataTransfer.getData('text/uri-list')||e.dataTransfer.getData('text/plain')||'';
    if(u.trim()){post('drop',{uriList:u});}
  });

  // ── Attachment chips (incremental — only animates newly added chips) ────────
  function _buildChip(att) {
    var chip = document.createElement('div');
    chip.dataset.chipUri = att.uri || '';
    if (att.dataUrl) {
      chip.className = 'tb-chip tb-chip-img chip-new';
      var thumb = document.createElement('img'); thumb.className = 'tb-chip-thumb'; thumb.src = att.dataUrl; thumb.alt = att.name;
      var info = document.createElement('div'); info.className = 'tb-chip-info';
      var iname = document.createElement('span'); iname.className = 'tb-chip-iname'; iname.title = att.name; iname.textContent = att.name; info.appendChild(iname);
      if (att.width && att.height) { var dim = document.createElement('span'); dim.className = 'tb-chip-dim'; dim.textContent = att.width + '×' + att.height; info.appendChild(dim); }
      chip.appendChild(thumb); chip.appendChild(info);
    } else {
      chip.className = 'tb-chip chip-new';
      var ns = document.createElement('span'); ns.className = 'tb-chip-name'; ns.title = att.name;
      var iconEl = makeIcon(att.name, att.isFolder); iconEl.style.marginRight = '4px';
      ns.prepend(iconEl); ns.append(att.name);
      chip.appendChild(ns);
    }
    var rm = document.createElement('button'); rm.className = 'tb-chip-rm'; rm.title = 'Remove'; rm.textContent = '×';
    (function(u) { rm.addEventListener('click', function() { removeAttachmentByUri(u); }); })(att.uri || '');
    chip.appendChild(rm);
    return chip;
  }
  function updateChips() {
    // Remove chips whose attachment is gone (skip cur-file-btn which lives here too)
    var uriSet = new Set(attachments.map(function(a) { return a.uri || ''; }));
    Array.from(tbChips.children).forEach(function(el) {
      if (el.id === 'cur-file-btn') { return; }
      if (!uriSet.has(el.dataset.chipUri || '')) { el.remove(); }
    });
    // Add chips only for new attachments
    var rendered = new Set(Array.from(tbChips.children)
      .filter(function(el) { return el.id !== 'cur-file-btn'; })
      .map(function(el) { return el.dataset.chipUri || ''; }));
    attachments.forEach(function(att) { if (!rendered.has(att.uri || '')) { tbChips.appendChild(_buildChip(att)); } });
  }
  function removeAttachmentByUri(uri) {
    var idx = attachments.findIndex(function(a) { return (a.uri || '') === uri; });
    if (idx < 0) { return; }
    attachments.splice(idx, 1); updateChips(); refreshInputTop();
    if (uri) { post('removeAttachment', { uri: uri }); }
  }
  function removeAttachment(idx, uri) { if (uri) { removeAttachmentByUri(uri); } else { attachments.splice(idx, 1); updateChips(); refreshInputTop(); } }
  function clearAttachments() {
    attachments = [];
    symbolRefs  = [];
    Array.from(tbChips.children).forEach(function(el) { if (el.id !== 'cur-file-btn') { el.remove(); } });
    refreshInputTop();
  }

  // ── Activity panel (live tool-use view) ──────────────────────────────────
  function renderActivityPanel() {
    if (!progressEl || !progressItems.length) { return; }
    progressEl.hidden = false;
    progressEl.innerHTML = '';

    // ── Todos: show the latest TodoWrite state ─────────────────────────────
    var lastTodo = null;
    for (var ti = progressItems.length - 1; ti >= 0; ti--) {
      if (progressItems[ti].toolName === 'TodoWrite' || progressItems[ti].toolName === 'TodoRead') {
        if (progressItems[ti].toolInput && Array.isArray(progressItems[ti].toolInput.todos)) {
          lastTodo = progressItems[ti]; break;
        }
      }
    }
    if (lastTodo) { progressEl.appendChild(_apTodoSection(lastTodo.toolInput.todos)); }

    // ── File operations ────────────────────────────────────────────────────
    var FILE_TOOLS = ['Read','Write','Edit','MultiEdit','Glob','LS'];
    var fileOps = progressItems.filter(function(p) { return FILE_TOOLS.indexOf(p.toolName) >= 0; });
    if (fileOps.length) { progressEl.appendChild(_apFileSection(fileOps)); }

    // ── Bash commands ──────────────────────────────────────────────────────
    var cmds = progressItems.filter(function(p) { return p.toolName === 'Bash'; });
    if (cmds.length) { progressEl.appendChild(_apCmdSection(cmds)); }

    // ── Search / web / agent ───────────────────────────────────────────────
    var SEARCH_TOOLS = ['Grep','WebFetch','WebSearch','Agent'];
    var searches = progressItems.filter(function(p) { return SEARCH_TOOLS.indexOf(p.toolName) >= 0; });
    if (searches.length) { progressEl.appendChild(_apSearchSection(searches)); }

    scrollBottom();
  }

  // Helper: create a section container with a header
  function _apSec(icon, title, count) {
    var sec = document.createElement('div'); sec.className = 'ap-section';
    var hdr = document.createElement('div'); hdr.className = 'ap-hdr';
    var ic  = document.createElement('span'); ic.className = 'ap-hdr-ic'; ic.textContent = icon;
    var ttl = document.createElement('span'); ttl.className = 'ap-hdr-title'; ttl.textContent = title;
    hdr.appendChild(ic); hdr.appendChild(ttl);
    if (count != null) {
      var cnt = document.createElement('span'); cnt.className = 'ap-hdr-count'; cnt.textContent = count;
      hdr.appendChild(cnt);
    }
    sec.appendChild(hdr);
    return sec;
  }

  function _apTodoSection(todos) {
    var done  = todos.filter(function(t){ return t.status === 'completed'; }).length;
    var sec   = _apSec('📋', 'Tasks', done + '/' + todos.length);
    todos.forEach(function(t) {
      var row = document.createElement('div');
      row.className = 'ap-todo ap-todo-' + (t.status || 'pending');
      var ic  = document.createElement('span'); ic.className = 'ap-todo-ic';
      ic.textContent = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '⟳' : '○';
      var tx  = document.createElement('span'); tx.className = 'ap-todo-tx';
      tx.textContent = (t.status === 'in_progress' && t.activeForm) ? t.activeForm : t.content;
      row.appendChild(ic); row.appendChild(tx);
      sec.appendChild(row);
    });
    return sec;
  }

  var DIFF_PREVIEW = 8; // lines shown before truncation

  function _renderDiffBlock(oldStr, newStr) {
    var wrap     = document.createElement('div');
    wrap.className = 'ap-diff-wrap';
    var oldLines = oldStr ? oldStr.split('\n') : [];
    var newLines = newStr ? newStr.split('\n') : [];
    // Trim trailing blank line that editors often append
    if (oldLines.length && oldLines[oldLines.length-1] === '') { oldLines.pop(); }
    if (newLines.length && newLines[newLines.length-1] === '') { newLines.pop(); }
    var expanded = false;
    function rebuild() {
      wrap.innerHTML = '';
      var showOld = expanded ? oldLines : oldLines.slice(0, DIFF_PREVIEW);
      var showNew = expanded ? newLines : newLines.slice(0, DIFF_PREVIEW);
      if (showOld.length) {
        var rb = document.createElement('div'); rb.className = 'ap-diff-block ap-diff-removed';
        showOld.forEach(function(ln) {
          var r = document.createElement('div'); r.className = 'ap-diff-line';
          var s = document.createElement('span'); s.className = 'ap-diff-sign'; s.textContent = '−';
          var c = document.createElement('span'); c.className = 'ap-diff-code'; c.textContent = ln;
          r.appendChild(s); r.appendChild(c); rb.appendChild(r);
        });
        if (!expanded && oldLines.length > DIFF_PREVIEW) {
          var mx = document.createElement('div'); mx.className = 'ap-diff-more';
          mx.textContent = '…' + (oldLines.length - DIFF_PREVIEW) + ' more lines';
          rb.appendChild(mx);
        }
        wrap.appendChild(rb);
      }
      if (showNew.length) {
        var ab = document.createElement('div'); ab.className = 'ap-diff-block ap-diff-added';
        showNew.forEach(function(ln) {
          var r = document.createElement('div'); r.className = 'ap-diff-line';
          var s = document.createElement('span'); s.className = 'ap-diff-sign'; s.textContent = '+';
          var c = document.createElement('span'); c.className = 'ap-diff-code'; c.textContent = ln;
          r.appendChild(s); r.appendChild(c); ab.appendChild(r);
        });
        if (!expanded && newLines.length > DIFF_PREVIEW) {
          var mx2 = document.createElement('div'); mx2.className = 'ap-diff-more';
          mx2.textContent = '…' + (newLines.length - DIFF_PREVIEW) + ' more lines';
          ab.appendChild(mx2);
        }
        wrap.appendChild(ab);
      }
      if (oldLines.length > DIFF_PREVIEW || newLines.length > DIFF_PREVIEW) {
        var ex = document.createElement('div'); ex.className = 'ap-diff-expand';
        ex.textContent = expanded ? 'Collapse' : 'Click to expand';
        ex.addEventListener('click', function() { expanded = !expanded; rebuild(); });
        wrap.appendChild(ex);
      }
    }
    rebuild();
    return wrap;
  }

  function _apFileSection(ops) {
    // Deduplicate by tool+path, keep last occurrence
    var map = new Map();
    ops.forEach(function(p) {
      var fp  = String(p.toolInput.file_path || p.toolInput.path || p.toolInput.pattern || '');
      var key = p.toolName + ':' + fp;
      map.set(key, p);
    });
    var deduped = Array.from(map.values());
    var sec     = _apSec('📂', 'Files', deduped.length);
    var visible = deduped.length > 8 ? deduped.slice(-8) : deduped;
    if (deduped.length > 8) {
      var more = document.createElement('div'); more.className = 'ap-more';
      more.textContent = '…' + (deduped.length - 8) + ' older';
      sec.appendChild(more);
    }
    var VERB = { Read:'read', Write:'write', Edit:'edit', MultiEdit:'edit', Glob:'glob', LS:'list' };
    visible.forEach(function(p, pi) {
      var fp      = String(p.toolInput.file_path || p.toolInput.path || p.toolInput.pattern || '');
      var isEdit  = p.toolName === 'Edit' || p.toolName === 'MultiEdit';
      var isWrite = p.toolName === 'Write';
      var oldStr  = isEdit  ? String(p.toolInput.old_string || p.toolInput.old_content || '') : '';
      var newStr  = isEdit  ? String(p.toolInput.new_string || p.toolInput.new_content || '')
                  : isWrite ? String(p.toolInput.content || '') : '';
      var row = document.createElement('div');
      row.className = 'ap-file ap-file-' + (VERB[p.toolName] || 'read') + (pi === visible.length - 1 ? ' ap-active' : '');
      var ic  = document.createElement('span'); ic.className = 'ap-file-ic';
      var lbl = document.createElement('span'); lbl.className = 'ap-file-path'; lbl.textContent = fp || p.toolName;
      row.appendChild(ic); row.appendChild(lbl);
      // Line-count summary badge for edits
      if ((isEdit || isWrite) && (oldStr || newStr)) {
        var badge = document.createElement('span'); badge.className = 'ap-diff-badge';
        var parts = [];
        if (oldStr) { var ol = oldStr.split('\n'); if (ol[ol.length-1]===''){ol.pop();} parts.push('−'+ol.length); }
        if (newStr) { var nl = newStr.split('\n'); if (nl[nl.length-1]===''){nl.pop();} parts.push('+'+nl.length); }
        badge.textContent = parts.join(' ');
        row.appendChild(badge);
      }
      sec.appendChild(row);
      // Inline diff block
      if ((isEdit || isWrite) && (oldStr || newStr)) {
        sec.appendChild(_renderDiffBlock(oldStr, newStr));
      }
    });
    return sec;
  }

  function _apCmdSection(cmds) {
    var sec = _apSec('⚡', 'Commands', cmds.length);
    cmds.forEach(function(p, pi) {
      var row = document.createElement('div');
      row.className = 'ap-cmd' + (pi === cmds.length - 1 ? ' ap-active' : '');
      var pr  = document.createElement('span'); pr.className = 'ap-cmd-pr'; pr.textContent = '$';
      var tx  = document.createElement('span'); tx.className = 'ap-cmd-tx';
      tx.textContent = String(p.toolInput.command || '').slice(0, 100);
      row.appendChild(pr); row.appendChild(tx);
      sec.appendChild(row);
    });
    return sec;
  }

  function _apSearchSection(items) {
    var sec = _apSec('🔍', 'Search', items.length);
    var VERB = { Grep:'grep', WebFetch:'fetch', WebSearch:'web', Agent:'agent' };
    items.forEach(function(p, pi) {
      var row = document.createElement('div');
      row.className = 'ap-search' + (pi === items.length - 1 ? ' ap-active' : '');
      var vb  = document.createElement('span'); vb.className = 'ap-search-verb';
      vb.textContent = VERB[p.toolName] || p.toolName.toLowerCase();
      var tx  = document.createElement('span'); tx.className = 'ap-search-q';
      var q   = p.toolInput.pattern || p.toolInput.query || p.toolInput.url || p.toolInput.description || '';
      tx.textContent = String(q).slice(0, 100);
      row.appendChild(vb); row.appendChild(tx);
      sec.appendChild(row);
    });
    return sec;
  }

  // ── Symbol reference chips ────────────────────────────────────────────────
  function _addSymbolChip(name, relPath, line, kind) {
    if (tbChips.querySelector('[data-chip-uri="symbol:' + name + '"]')) { return; }
    var chip = document.createElement('div');
    chip.className = 'tb-chip tb-chip-symbol chip-new';
    chip.dataset.chipUri = 'symbol:' + name;
    var icon = document.createElement('span');
    icon.className = 'tb-chip-sym-icon';
    icon.textContent = (kind === 'class' || kind === 'interface') ? '◈' : (kind === 'function' || kind === 'method' || kind === 'constructor') ? 'ƒ' : '⬡';
    var nm = document.createElement('span'); nm.className = 'tb-chip-name'; nm.textContent = name; nm.title = name;
    var loc = document.createElement('span'); loc.className = 'tb-chip-sym-loc'; loc.textContent = relPath + ':' + line;
    chip.appendChild(icon); chip.appendChild(nm); chip.appendChild(loc);
    var rm = document.createElement('button'); rm.className = 'tb-chip-rm'; rm.title = 'Remove'; rm.textContent = '×';
    (function(n) { rm.addEventListener('click', function() { _removeSymbolRef(n); }); })(name);
    chip.appendChild(rm);
    tbChips.appendChild(chip);
  }

  function _removeSymbolRef(name) {
    var idx = symbolRefs.findIndex(function(r) { return r.name === name; });
    if (idx >= 0) { symbolRefs.splice(idx, 1); }
    var chip = tbChips.querySelector('[data-chip-uri="symbol:' + name + '"]');
    if (chip) { chip.remove(); }
    refreshInputTop();
    post('removeSymbolRef', { symbolName: name });
  }

  // ── Messages ─────────────────────────────────────────────────────────────
  function appendUserMsg(text) {
    hideEmpty();
    var wrap=document.createElement('div');wrap.className='msg user';
    var bubble=document.createElement('div');bubble.className='msg-bubble';bubble.textContent=text;
    wrap.appendChild(bubble);messagesEl.appendChild(wrap);scrollBottom();
  }

  function _appendHistoryMsg(text, model, tokens) {
    hideEmpty();
    var wrap   = document.createElement('div'); wrap.className = 'msg assistant';
    var sender = document.createElement('div'); sender.className = 'msg-sender'; sender.textContent = 'AVN Chat';
    var body   = document.createElement('div'); body.className = 'msg-body';
    body.innerHTML = renderMarkdown(text || '');
    wrap.appendChild(sender); wrap.appendChild(body);
    if (model || tokens) {
      var meta  = document.createElement('div'); meta.className = 'msg-meta';
      meta.style.opacity = '0.3'; // always visible in history (not hover-only)
      var short = (model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '') || (model || '');
      // For OpenCode models like "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
      if (short.includes('/')) { short = short.split('/').slice(1).join('/'); }
      var parts = [];
      if (short) { parts.push(short); }
      if (tokens) { parts.push(fmtTok(tokens) + ' tok'); }
      meta.textContent = parts.join(' · ');
      wrap.appendChild(meta);
    }
    messagesEl.appendChild(wrap);
  }

  // ── Markdown renderer ─────────────────────────────────────────────────────
  function renderInline(s) {
    return s
      .replace(/`([^`\n]+)`/g,'<code>$1</code>')
      .replace(/\*\*\*([^*\n]+)\*\*\*/g,'<strong><em>$1</em></strong>')
      .replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g,'<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank">$1</a>');
  }
  function renderMarkdown(md) {
    var segs=[],re=/^(`{3,})(\w*)\n([\s\S]*?)\n?\1[ \t]*$/gm,li=0,m;
    while((m=re.exec(md))!==null){if(m.index>li){segs.push({type:'text',content:md.slice(li,m.index)});}segs.push({type:'code',lang:m[2],content:m[3]});li=re.lastIndex;}
    var tail=md.slice(li);
    if(tail){var um=tail.match(/`{3,}(\w*)\n([\s\S]*)$/);if(um){var fi=tail.lastIndexOf(um[0]);if(fi>0){segs.push({type:'text',content:tail.slice(0,fi)});}segs.push({type:'code',lang:um[1],content:um[2],open:true});}else{segs.push({type:'text',content:tail});}}
    return segs.map(function(s){
      if(s.type==='code'){var l=esc(s.lang||''),c=esc(s.content);return '<pre>'+(l?'<span class="code-lang">'+l+'</span>':'')+'<code>'+c+'</code></pre>';}
      return renderBlock(s.content);
    }).join('');
  }
  function renderBlock(text) {
    var lines=text.split('\n'),html='',i=0;
    while(i<lines.length){
      var line=lines[i],hm=line.match(/^(#{1,6}) (.+)$/);
      if(hm){var lvl=hm[1].length;html+='<h'+lvl+'>'+renderInline(esc(hm[2]))+'</h'+lvl+'>';i++;continue;}
      if(/^([-*_]){3,}$/.test(line.trim())){html+='<hr>';i++;continue;}
      if(line.startsWith('> ')){var bq='';while(i<lines.length&&lines[i].startsWith('> ')){bq+=lines[i].slice(2)+'\n';i++;}html+='<blockquote>'+renderBlock(bq)+'</blockquote>';continue;}
      if(/^[-*+] /.test(line)){html+='<ul>';while(i<lines.length&&/^[-*+] /.test(lines[i])){html+='<li>'+renderInline(esc(lines[i].slice(2)))+'</li>';i++;}html+='</ul>';continue;}
      if(/^\d+[.)]\s/.test(line)){html+='<ol>';while(i<lines.length&&/^\d+[.)]\s/.test(lines[i])){html+='<li>'+renderInline(esc(lines[i].replace(/^\d+[.)]\s/,'')))+'</li>';i++;}html+='</ol>';continue;}
      if(line.includes('|')&&i+1<lines.length&&/^[\s|:-]+$/.test(lines[i+1])){
        var hC=line.split('|').filter(function(c){return c.trim()!=='';});
        var tbl='<table><thead><tr>'+hC.map(function(c){return '<th>'+renderInline(esc(c.trim()))+'</th>';}).join('')+'</tr></thead><tbody>';
        i+=2;while(i<lines.length&&lines[i].includes('|')){var cl=lines[i].split('|').filter(function(c){return c.trim()!=='';});tbl+='<tr>'+cl.map(function(c){return '<td>'+renderInline(esc(c.trim()))+'</td>';}).join('')+'</tr>';i++;}
        html+=tbl+'</tbody></table>';continue;
      }
      if(line.trim()===''){i++;continue;}
      var pl=[];while(i<lines.length&&lines[i].trim()!==''&&!/^(#{1,6} |> |[-*+] |\d+[.)]\s|([-*_]){3,})/.test(lines[i])&&!lines[i].includes('|')){pl.push(lines[i]);i++;}
      if(pl.length){html+='<p>'+renderInline(esc(pl.join('\n'))).replace(/\n/g,'<br>')+'</p>';}
    }
    return html;
  }

  // ── Usage panel ───────────────────────────────────────────────────────────
  function showUsage(data) {
    var s=data.session||0,d=data.daily||0,w=data.weekly||0,limit=data.dailyLimit||0,reqs=data.requests||0;
    var fp=function(n){return limit>0?Math.min(100,Math.round(n/limit*100)):0;};
    document.getElementById('session-val').textContent=fmtTok(s)+' tokens';
    document.getElementById('session-fill').style.width=(limit>0?fp(s):45)+'%';
    document.getElementById('daily-val').textContent=limit>0?fmtTok(d)+' / '+fmtTok(limit)+' ('+fp(d)+'%)':fmtTok(d)+' tokens';
    document.getElementById('daily-fill').style.width=fp(d)+'%';
    document.getElementById('weekly-val').textContent=fmtTok(w)+' tokens';
    document.getElementById('weekly-fill').style.width='0%';
    document.getElementById('usage-requests').textContent=reqs+' request'+(reqs!==1?'s':'')+' this session';
    usagePanel.hidden=false;
  }

  // ── Extension → webview ───────────────────────────────────────────────────
  window.addEventListener('message', function(e){
    var msg=e.data;
    switch(msg.type){

      case 'setState':
        if (msg.backend !== undefined) {
          currentBackend = msg.backend;
          updateBackendTabs();
        }
        if (msg.model !== undefined) {
          var short;
          if (currentBackend === 'opencode') {
            // "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
            short = msg.model.includes('/') ? msg.model.split('/').slice(1).join('/') : msg.model;
          } else {
            short = msg.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
          }
          modelBtn.textContent = short;
          modelBtn.title = msg.model + ' — click to switch';
          modelBtn.dataset.model = msg.model;
        }
        if (msg.displayMode !== undefined) { updateDisplayModeUI(msg.displayMode); }
        if ('effort' in msg) {
          thinkingEnabled = !!msg.effort;
          if (msg.effort) { currentEffort = msg.effort; }
          updateEffortDots(null); updateThinkingUI();
        }
        if (msg.availableModels && msg.availableModels.length) { availableModels = msg.availableModels; }
        if (msg.openCodeModels && msg.openCodeModels.length)   { availableOpenCodeModels = msg.openCodeModels; }
        break;

      case 'addUserMessage': appendUserMsg(msg.text); break;

      case 'streamStart':{
        hideEmpty();usagePanel.hidden=true;sessionsPanel.hidden=true;streaming=true;currentRaw='';progressItems=[];
        sendBtn.disabled=false;sendBtn.classList.add('stop-mode');sendBtn.title='Stop (Esc)';
        sendBtn.innerHTML='<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
        var wrap=document.createElement('div');wrap.className='msg assistant';
        var sender=document.createElement('div');sender.className='msg-sender';sender.textContent='AVN Chat';
        var prog=document.createElement('div');prog.className='msg-progress';prog.hidden=true;
        var body=document.createElement('div');body.className='msg-body';
        var thinkEl=document.createElement('div');thinkEl.className='thinking-text';
        thinkEl.appendChild(document.createTextNode('Nutting All Over the Codebase'));
        var ellEl=document.createElement('span');ellEl.className='thinking-ellipsis';thinkEl.appendChild(ellEl);
        body.appendChild(thinkEl);wrap.appendChild(sender);wrap.appendChild(prog);wrap.appendChild(body);
        messagesEl.appendChild(wrap);currentEl=body;progressEl=prog;scrollBottom();break;
      }

      case 'streamChunk':
        if(!streaming||!currentEl){break;}
        var thinkingEl=currentEl.querySelector('.thinking-text,.typing-dots');if(thinkingEl){thinkingEl.remove();}
        currentRaw+=msg.text;currentEl.innerHTML=renderMarkdown(currentRaw);scrollBottom();break;

      case 'progressEvent':{
        if(!progressEl){break;}
        progressItems.push({toolName:msg.toolName,toolInput:msg.toolInput||{}});
        renderActivityPanel();
        break;
      }

      case 'streamEnd':{
        // Collapse progress into collapsible summary
        if(progressEl&&progressItems.length>0){
          var details=document.createElement('details');details.className='msg-progress-summary';
          var sumEl=document.createElement('summary');
          var fCount=0,cCount=0;
          progressItems.forEach(function(p){
            if(['Read','Write','Edit','MultiEdit'].indexOf(p.toolName)>=0){fCount++;}
            else if(p.toolName==='Bash'){cCount++;}
          });
          var sparts=[];
          if(fCount>0){sparts.push(fCount+' file'+(fCount!==1?'s':''));}
          if(cCount>0){sparts.push(cCount+' command'+(cCount!==1?'s':''));}
          if(sparts.length===0){sparts.push(progressItems.length+' step'+(progressItems.length!==1?'s':''));}
          sumEl.textContent='Analyzed '+sparts.join(', ');
          details.appendChild(sumEl);
          progressItems.forEach(function(p){
            var di=document.createElement('div');di.className='progress-detail-item';
            di.textContent=describeToolUse(p.toolName,p.toolInput);details.appendChild(di);
          });
          progressEl.innerHTML='';progressEl.appendChild(details);progressEl.hidden=false;
        } else if(progressEl){progressEl.hidden=true;}
        // Attach hover metadata + checkpoint restore button
        if(currentEl&&currentEl.parentElement){
          var msgWrap=currentEl.parentElement;
          if(msg.model){
            var meta=document.createElement('div');meta.className='msg-meta';
            var mShort=(msg.model||'').replace(/^claude-/,'').replace(/-\d{8}$/,'');
            var eff=msg.effort?' · '+(msg.effort.charAt(0).toUpperCase()+msg.effort.slice(1))+' effort':'';
            var tok=(msg.inputTokens||0)+(msg.outputTokens||0);
            meta.textContent=mShort+eff+(tok?' · '+fmtTok(tok)+' tok':'');
            msgWrap.appendChild(meta);
          }
          if(msg.checkpointHash){
            var cpBtn=document.createElement('button');cpBtn.className='msg-restore-btn';
            cpBtn.title='Restore workspace to before this prompt (git reset --hard)';
            cpBtn.textContent='↩ restore checkpoint';
            (function(h){cpBtn.addEventListener('click',function(){post('restoreCheckpoint',{checkpointHash:h});});})(msg.checkpointHash);
            msgWrap.appendChild(cpBtn);
          }
        }
        streaming=false;currentEl=null;progressEl=null;progressItems=[];currentRaw='';
        sendBtn.classList.remove('stop-mode');sendBtn.title='Send (Enter)';
        sendBtn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
        refreshSendBtn();clearAttachments();break;
      }

      case 'setStatus':
        statusDot.className=msg.status==='thinking'?'thinking':msg.status==='error'?'error':'';break;

      case 'showError':{
        hideEmpty();
        var ew=document.createElement('div');ew.className='msg assistant';
        var es=document.createElement('div');es.className='msg-sender';es.textContent='AVN Chat';
        var eb=document.createElement('div');eb.className='msg-body';eb.style.color='var(--vscode-errorForeground)';eb.textContent=msg.text;
        ew.appendChild(es);ew.appendChild(eb);messagesEl.appendChild(ew);scrollBottom();break;
      }

      case 'clearMessages':
        while(messagesEl.firstChild){messagesEl.removeChild(messagesEl.firstChild);}
        messagesEl.appendChild(emptyEl);
        streaming=false;currentEl=null;progressEl=null;progressItems=[];currentRaw='';
        changeBar.hidden=true;
        refreshSendBtn();clearAttachments();usagePanel.hidden=true;break;

      case 'filesAttached':
        (msg.files||[]).forEach(function(f){
          if(f.dataUrl){
            var img=new Image();var cap=f;
            img.onload=function(){attachments.push({name:cap.name,uri:cap.uri,isImage:true,dataUrl:cap.dataUrl,width:img.naturalWidth,height:img.naturalHeight});updateChips();refreshInputTop();};
            img.src=f.dataUrl;
          } else {attachments.push({name:f.name,uri:f.uri,isFolder:!!f.isFolder});updateChips();refreshInputTop();}
        });break;

      case 'contextInfo':
        if(msg.kind==='selection'){ctxTextEl.textContent='📎 '+msg.lines+' selected lines · '+msg.file;ctxLine.hidden=false;}
        else{ctxLine.hidden=true;}
        refreshInputTop();break;

      case 'currentFile': {
        var newUri = msg.uri || null;
        // If requestContext returns null (no active editor at that moment), don't clear an
        // explicitly-included file — the user just clicked the chat input, not closed their file.
        if (!newUri && msg.from === 'request') { break; }
        // Reset include flag only when switching to a genuinely different file
        if (newUri && (!currentFile || currentFile.uri !== newUri)) { currentFileIncluded = false; }
        currentFile = newUri ? { name: msg.name || 'file', uri: newUri } : null;
        updateCurrentFileBtn();
        refreshInputTop();
        break;
      }

      case 'mcpList': {
        var tpList = document.getElementById('tp-list');
        tpList.innerHTML = '';
        var mcps = msg.mcps || [];
        if (!mcps.length) {
          var emp = document.createElement('div'); emp.className = 'tp-empty';
          emp.textContent = 'No MCP servers configured. Add one with the button below.';
          tpList.appendChild(emp); break;
        }
        mcps.forEach(function(mcp) {
          var row = document.createElement('div'); row.className = 'tp-item';
          var info = document.createElement('div'); info.className = 'tp-item-info';
          var nm = document.createElement('div'); nm.className = 'tp-item-name'; nm.textContent = mcp.name;
          var cd = document.createElement('div'); cd.className = 'tp-item-cmd';  cd.textContent = mcp.command;
          info.appendChild(nm); info.appendChild(cd);
          var tog = document.createElement('button'); tog.className = 'tp-toggle' + (mcp.disabled ? '' : ' on');
          tog.title = mcp.disabled ? 'Enable' : 'Disable';
          tog.innerHTML = '<div class="tp-toggle-knob"></div>';
          (function(n){ tog.addEventListener('click', function(){ post('toggleMCP', { mcpName: n }); }); })(mcp.name);
          var del = document.createElement('button'); del.className = 'tp-del'; del.textContent = '×'; del.title = 'Remove';
          (function(n){ del.addEventListener('click', function(){ post('removeMCP', { mcpName: n }); }); })(mcp.name);
          row.appendChild(info); row.appendChild(tog); row.appendChild(del);
          tpList.appendChild(row);
        });
        break;
      }
      case 'fileSearchResults': renderFileResults(msg.files); break;
      case 'showUsage':         showUsage(msg); break;
      case 'updateSessions':    renderSessions(msg.sessions, msg.activeId); break;

      case 'updateChangeBar': {
        if (!msg.files) { changeBar.hidden = true; cbFiles.innerHTML = ''; cbFiles.hidden = true; break; }
        var cbCount = msg.files;
        var cbParts = [cbCount + ' file' + (cbCount !== 1 ? 's' : '') + ' changed'];
        if (msg.added || msg.removed) {
          var linesParts = [];
          if (msg.added)   { linesParts.push('+' + msg.added); }
          if (msg.removed) { linesParts.push('−' + msg.removed); }
          cbParts.push(linesParts.join('  ') + ' lines');
        }
        cbText.textContent = cbParts.join('  ·  ');
        // Render clickable file chips
        cbFiles.innerHTML = '';
        if (msg.filePaths && msg.filePaths.length) {
          msg.filePaths.forEach(function(fp) {
            var chip = document.createElement('button');
            chip.className = 'cb-file-chip';
            chip.title = fp;
            chip.textContent = fp.split('/').pop() || fp;
            chip.addEventListener('click', function() { post('openDiffFile', { filePath: fp }); });
            cbFiles.appendChild(chip);
          });
          cbFiles.hidden = false;
        } else {
          cbFiles.hidden = true;
        }
        changeBar.hidden = false;
        break;
      }

      case 'loadHistory': {
        var histMsgs = msg.messages || [];
        if (!histMsgs.length) { break; }
        hideEmpty();
        histMsgs.forEach(function(m) {
          if (m.role === 'user') { appendUserMsg(m.text); }
          else { _appendHistoryMsg(m.text, m.model, m.tokens); }
        });
        scrollBottom();
        break;
      }

      case 'symbolResolved':
        symbolRefs.push({ name: msg.name, relPath: msg.relPath, line: msg.line, kind: msg.kind });
        _addSymbolChip(msg.name, msg.relPath, msg.line, msg.kind);
        refreshInputTop();
        break;
    }
  });

  // ── Clipboard paste (images + symbol resolution) ─────────────────────────
  document.addEventListener('paste', function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) { return; }
    var imageItem = null, imageMime = '';
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) { imageItem = items[i]; imageMime = items[i].type; break; }
    }
    if (imageItem) {
      e.preventDefault();
      var blob = imageItem.getAsFile();
      if (!blob) { return; }
      var mime = imageMime;
      var reader = new FileReader();
      reader.onload = function(ev) { post('pasteImage', { dataUrl: ev.target.result, mimeType: mime }); };
      reader.readAsDataURL(blob);
      return;
    }
    // If pasted text is a single identifier, try to resolve it as a code symbol
    var textData = (e.clipboardData.getData('text/plain') || '').trim();
    if (textData.length >= 2 && /^[$_a-zA-Z][\w$]*$/.test(textData)) {
      post('resolveSymbol', { symbolName: textData });
      // Don't preventDefault — let the text paste normally into the textarea too
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  refreshSendBtn();
  post('ready');

})();
