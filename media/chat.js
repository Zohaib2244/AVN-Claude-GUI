(function () {
  'use strict';

  const vscApi    = acquireVsCodeApi();
  const ICON_BASE = (document.querySelector('meta[name="icon-base"]') || { getAttribute: function(){ return ''; } }).getAttribute('content') || '';

  // ── State ────────────────────────────────────────────────────────────────
  let streaming       = false;
  let currentEl       = null;
  let currentRaw      = '';
  let attachments     = [];
  let availableModels = [];
  let atMentionStart  = -1;
  let fpMode          = 'none';
  let fpHighIdx       = -1;
  let cpHighIdx       = -1;
  let fpSearchTimer   = null;

  // ── DOM ──────────────────────────────────────────────────────────────────
  const messagesEl   = document.getElementById('messages');
  const emptyEl      = document.getElementById('empty-state');
  const inputEl      = document.getElementById('user-input');
  const sendBtn      = document.getElementById('send-btn');
  const statusDot    = document.getElementById('status-dot');
  const modelBtn     = document.getElementById('model-btn');
  const modeBtns     = document.querySelectorAll('.mode-btn');
  const yoloBtn      = document.getElementById('yolo-btn');
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

  // ── Helpers ──────────────────────────────────────────────────────────────
  function post(type, extra) { vscApi.postMessage(Object.assign({ type }, extra || {})); }
  function hideEmpty() { if (emptyEl && emptyEl.parentNode) { emptyEl.remove(); } }
  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtTok(n) { if (n>=1e6){return (n/1e6).toFixed(1)+'M';} if(n>=1e3){return (n/1e3).toFixed(1)+'k';} return String(n); }
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
  document.getElementById('ctx-dismiss-btn').addEventListener('click', function(){ ctxLine.hidden = true; });
  document.getElementById('add-btn').addEventListener('click',         function(){ openFilePicker_plus(); });
  document.getElementById('cmd-btn').addEventListener('click',         function(){ toggleCmdPicker(); });
  document.getElementById('send-btn').addEventListener('click',        function(){ handleSend(); });
  document.getElementById('model-btn').addEventListener('click',       function(){ toggleModelPicker(); });
  document.getElementById('sp-new').addEventListener('click',          function(){ post('createSession'); });
  document.getElementById('sp-close').addEventListener('click',        function(){ sessionsPanel.hidden = true; });

  // ── Input resize ──────────────────────────────────────────────────────────
  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    refreshSendBtn();
    checkAtMention();
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
      if (e.key === 'Enter')     { e.preventDefault(); selectCpHighlighted(); return; }
      if (e.key === 'Escape')    { closeCmdPicker(); return; }
      return;
    }
    if (!modelPicker.hidden && e.key === 'Escape') { closeModelPicker(); return; }
    if (!sessionsPanel.hidden && e.key === 'Escape') { sessionsPanel.hidden = true; return; }
    if (e.key === '/' && inputEl.value.trim() === '') { e.preventDefault(); openCmdPicker(); return; }
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
    ctxLine.hidden = true;
    closeFilePicker(false); closeCmdPicker(); closeModelPicker();
    refreshSendBtn();
    post('send', { text: text, command: command });
  }

  function clearConversation() { closeCmdPicker(); closeModelPicker(); post('send', { text: '', command: 'clear' }); }

  // ── File picker ───────────────────────────────────────────────────────────
  function openFilePicker_at() {
    fpMode = 'at'; fpHighIdx = -1;
    filePicker.classList.add('at-mode'); filePicker.hidden = false;
    closeCmdPicker(); closeModelPicker();
  }
  function openFilePicker_plus() {
    fpMode = 'plus'; fpHighIdx = -1; atMentionStart = -1;
    filePicker.classList.remove('at-mode'); filePicker.hidden = false;
    fpSearch.value = ''; closeCmdPicker(); closeModelPicker();
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
    fpHighIdx = -1; fpResults.innerHTML = '';
    if (!files || !files.length) { var e2=document.createElement('div');e2.className='fp-empty';e2.textContent='No files found';fpResults.appendChild(e2);return; }
    files.forEach(function(f) {
      var btn = document.createElement('button'); btn.className = 'fp-item';
      var left = document.createElement('div'); left.className = 'fp-item-left';
      left.appendChild(makeIcon(f.name, f.isFolder));
      var name = document.createElement('span'); name.className = 'fp-name'; name.textContent = f.name; left.appendChild(name);
      var rel  = document.createElement('span'); rel.className = 'fp-relpath'; rel.textContent = f.relPath || '';
      btn.appendChild(left); btn.appendChild(rel);
      btn.addEventListener('click', function() { selectFile(f); });
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
  function openCmdPicker()  { cpHighIdx=-1; cmdPicker.querySelectorAll('.cp-item').forEach(function(el){el.classList.remove('cp-hi');}); cmdPicker.hidden=false; closeFilePicker(false); closeModelPicker(); }
  function closeCmdPicker() { cmdPicker.hidden=true; cpHighIdx=-1; }
  function toggleCmdPicker(){ cmdPicker.hidden ? openCmdPicker() : closeCmdPicker(); }
  function moveCpHighlight(delta) {
    var items=cmdPicker.querySelectorAll('.cp-item'); if(!items.length){return;}
    cpHighIdx=cpHighIdx<0?(delta>0?0:items.length-1):Math.max(0,Math.min(items.length-1,cpHighIdx+delta));
    items.forEach(function(el,i){el.classList.toggle('cp-hi',i===cpHighIdx);if(i===cpHighIdx){el.scrollIntoView({block:'nearest'});}});
  }
  function selectCpHighlighted() { var t=cpHighIdx>=0?cmdPicker.querySelectorAll('.cp-item')[cpHighIdx]:null; if(t){t.click();} }
  cmdPicker.addEventListener('click', function(e) {
    var item = e.target.closest('.cp-item'); if(!item){return;}
    var cmd=item.dataset.cmd; closeCmdPicker(); inputEl.value=''; inputEl.style.height='auto'; refreshSendBtn();
    appendUserMsg('/'+cmd); post('send',{text:'',command:cmd});
  });

  // ── Model picker ──────────────────────────────────────────────────────────
  function openModelPicker()  { buildModelList(); modelPicker.hidden=false; modelBtn.classList.add('open'); closeCmdPicker(); closeFilePicker(false); }
  function closeModelPicker() { modelPicker.hidden=true; modelBtn.classList.remove('open'); }
  function toggleModelPicker(){ modelPicker.hidden ? openModelPicker() : closeModelPicker(); }
  function buildModelList() {
    mpList.innerHTML=''; var cur=modelBtn.dataset.model||'';
    availableModels.forEach(function(m) {
      var btn=document.createElement('button'); btn.className='mp-item'+(m===cur?' current':'');
      var lbl=document.createElement('span'); lbl.textContent=m; btn.appendChild(lbl);
      if(m===cur){var b=document.createElement('span');b.className='mp-badge';b.textContent='current';btn.appendChild(b);}
      btn.addEventListener('click',function(){post('selectModel',{model:m});closeModelPicker();});
      mpList.appendChild(btn);
    });
  }
  document.addEventListener('click', function(e) {
    var bw=document.getElementById('bottom-wrap');
    if(!modelPicker.hidden && bw && !bw.contains(e.target)){closeModelPicker();}
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

  // ── Mode / YOLO ───────────────────────────────────────────────────────────
  modeBtns.forEach(function(btn) {
    btn.addEventListener('click', function(){ var mode=btn.dataset.mode; modeBtns.forEach(function(b){b.classList.toggle('active',b.dataset.mode===mode);}); post('setMode',{mode:mode}); });
  });
  yoloBtn.addEventListener('click', function(){ post('toggleYolo'); });

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

  // ── Attachment chips ──────────────────────────────────────────────────────
  function updateChips() {
    tbChips.innerHTML='';
    attachments.forEach(function(att,idx){
      var chip=document.createElement('div');
      if(att.dataUrl){
        chip.className='tb-chip tb-chip-img';
        var thumb=document.createElement('img');thumb.className='tb-chip-thumb';thumb.src=att.dataUrl;thumb.alt=att.name;
        var info=document.createElement('div');info.className='tb-chip-info';
        var iname=document.createElement('span');iname.className='tb-chip-iname';iname.title=att.name;iname.textContent=att.name;info.appendChild(iname);
        if(att.width&&att.height){var dim=document.createElement('span');dim.className='tb-chip-dim';dim.textContent=att.width+'×'+att.height;info.appendChild(dim);}
        chip.appendChild(thumb);chip.appendChild(info);
      } else {
        chip.className='tb-chip';
        var ns=document.createElement('span');ns.className='tb-chip-name';ns.title=att.name;
        var iconEl=makeIcon(att.name, att.isFolder);iconEl.style.marginRight='4px';
        ns.prepend(iconEl); ns.append(att.name);
        chip.appendChild(ns);
      }
      var rm=document.createElement('button');rm.className='tb-chip-rm';rm.title='Remove';rm.textContent='×';
      (function(i,uri){rm.addEventListener('click',function(){removeAttachment(i,uri);});})(idx,att.uri);
      chip.appendChild(rm);tbChips.appendChild(chip);
    });
  }
  function removeAttachment(idx,uri){attachments.splice(idx,1);updateChips();if(uri){post('removeAttachment',{uri:uri});}}
  function clearAttachments(){attachments=[];updateChips();}

  // ── Messages ─────────────────────────────────────────────────────────────
  function appendUserMsg(text) {
    hideEmpty();
    var wrap=document.createElement('div');wrap.className='msg user';
    var bubble=document.createElement('div');bubble.className='msg-bubble';bubble.textContent=text;
    wrap.appendChild(bubble);messagesEl.appendChild(wrap);scrollBottom();
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
        if(msg.model!==undefined){var short=msg.model.replace(/^claude-/,'').replace(/-\d{8}$/,'');modelBtn.textContent=short;modelBtn.title=msg.model+' — click to switch';modelBtn.dataset.model=msg.model;}
        if(msg.mode!==undefined){modeBtns.forEach(function(b){b.classList.toggle('active',b.dataset.mode===msg.mode);});}
        if(msg.yoloMode!==undefined){yoloBtn.classList.toggle('on',!!msg.yoloMode);yoloBtn.textContent=msg.yoloMode?'⚡ YOLO':'YOLO';}
        if(msg.availableModels&&msg.availableModels.length){availableModels=msg.availableModels;}
        break;

      case 'addUserMessage': appendUserMsg(msg.text); break;

      case 'streamStart':{
        hideEmpty();usagePanel.hidden=true;sessionsPanel.hidden=true;streaming=true;currentRaw='';sendBtn.disabled=true;
        var wrap=document.createElement('div');wrap.className='msg assistant';
        var sender=document.createElement('div');sender.className='msg-sender';sender.textContent='AVN Chat';
        var body=document.createElement('div');body.className='msg-body';
        var dots=document.createElement('div');dots.className='typing-dots';
        for(var d=0;d<3;d++){var dot=document.createElement('div');dot.className='dot';dots.appendChild(dot);}
        body.appendChild(dots);wrap.appendChild(sender);wrap.appendChild(body);
        messagesEl.appendChild(wrap);currentEl=body;scrollBottom();break;
      }

      case 'streamChunk':
        if(!streaming||!currentEl){break;}
        currentRaw+=msg.text;currentEl.innerHTML=renderMarkdown(currentRaw);scrollBottom();break;

      case 'streamEnd':
        streaming=false;currentEl=null;currentRaw='';refreshSendBtn();clearAttachments();break;

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
        streaming=false;currentEl=null;currentRaw='';refreshSendBtn();clearAttachments();usagePanel.hidden=true;break;

      case 'filesAttached':
        (msg.files||[]).forEach(function(f){
          if(f.dataUrl){
            var img=new Image();var cap=f;
            img.onload=function(){attachments.push({name:cap.name,uri:cap.uri,isImage:true,dataUrl:cap.dataUrl,width:img.naturalWidth,height:img.naturalHeight});updateChips();};
            img.src=f.dataUrl;
          } else {attachments.push({name:f.name,uri:f.uri,isFolder:!!f.isFolder});updateChips();}
        });break;

      case 'contextInfo':
        if(msg.kind==='selection'){ctxTextEl.textContent='📎 '+msg.lines+' selected lines · '+msg.file;ctxLine.hidden=false;}
        else{ctxLine.hidden=true;}break;

      case 'fileSearchResults': renderFileResults(msg.files); break;
      case 'showUsage':         showUsage(msg); break;
      case 'updateSessions':    renderSessions(msg.sessions, msg.activeId); break;
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  refreshSendBtn();
  post('ready');

})();
