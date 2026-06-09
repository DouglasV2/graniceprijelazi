// Standalone internal ROI polygon editor (served only when YOLO_ROI_EDITOR_ENABLED=true). This is
// deliberately NOT part of the user React bundle — normal users never download a byte of it. It
// talks to /api/internal/traffic-vision/* with an x-debug-token header (or an admin session). It
// draws the exact frame YOLO saw, overlays detection boxes, lets you draw a queue polygon + ignore
// polygons in normalized 0..1 coords, previews how many vehicles the polygon would count, and saves
// a runtime override — then shows a STATIC_ROI_CONFIGS snippet to commit for durable storage.
export const ROI_EDITOR_HTML = `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>ROI editor (interno)</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #0f1115; color: #e6e8eb; }
  header { padding: 10px 16px; background: #161922; border-bottom: 1px solid #232838; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header strong { font-size: 15px; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #232838; color: #9aa4b2; }
  main { display: grid; grid-template-columns: 320px 1fr; gap: 0; height: calc(100vh - 49px); }
  aside { padding: 14px; border-right: 1px solid #232838; overflow: auto; }
  section.canvasWrap { padding: 14px; overflow: auto; }
  label { display: block; font-size: 12px; color: #9aa4b2; margin: 10px 0 4px; }
  input, select, button { font: inherit; }
  input[type=text], input[type=password], select { width: 100%; box-sizing: border-box; padding: 7px 9px; background: #0b0d12; border: 1px solid #2a3142; color: #e6e8eb; border-radius: 8px; }
  button { cursor: pointer; padding: 8px 12px; border-radius: 8px; border: 1px solid #2a3142; background: #1d2230; color: #e6e8eb; margin: 6px 6px 0 0; }
  button.primary { background: #2563eb; border-color: #2563eb; }
  button.danger { background: #3a1d24; border-color: #5b2530; }
  button:disabled { opacity: .5; cursor: default; }
  .mode { display: inline-flex; gap: 0; margin-top: 6px; }
  .mode button { margin: 0; border-radius: 0; }
  .mode button.active { background: #2563eb; border-color: #2563eb; }
  canvas { background: #000; border: 1px solid #232838; max-width: 100%; image-rendering: auto; }
  pre { white-space: pre-wrap; word-break: break-word; background: #0b0d12; border: 1px solid #2a3142; border-radius: 8px; padding: 10px; font-size: 12px; max-height: 220px; overflow: auto; }
  .row { display: flex; gap: 8px; }
  .row > * { flex: 1; }
  .muted { color: #9aa4b2; font-size: 12px; }
  .counts { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
  .counts .c { background: #0b0d12; border: 1px solid #2a3142; border-radius: 8px; padding: 6px 10px; font-size: 13px; }
  .c b { display: block; font-size: 18px; }
  .ok { color: #4ade80; } .warn { color: #fbbf24; } .err { color: #f87171; }
</style>
</head>
<body>
<header>
  <strong>ROI editor</strong>
  <span class="pill">interno · ne za korisnike</span>
  <span class="pill" id="flagPill">…</span>
  <span class="muted" id="status"></span>
</header>
<main>
  <aside>
    <label>Debug token (x-debug-token)</label>
    <input type="password" id="token" placeholder="TRAFFIC_VISION_DEBUG_TOKEN (ili admin sesija)" />
    <div class="row"><button id="saveToken">Spremi token</button><button id="loadAudit">Učitaj kamere</button></div>

    <label>Kamera</label>
    <select id="cameraSel"></select>
    <label>Smjer</label>
    <select id="dirSel"><option value="toBih">toBih</option><option value="toHr">toHr</option></select>
    <div class="row"><button id="loadCam" class="primary">Učitaj sliku + YOLO</button></div>

    <label>Način crtanja</label>
    <div class="mode">
      <button data-mode="queue" class="active" id="modeQueue">Queue polygon</button>
      <button data-mode="ignore" id="modeIgnore">Ignore polygon</button>
    </div>
    <div class="row">
      <button id="finishPoly">Završi poligon</button>
      <button id="undoPt">Undo točka</button>
    </div>
    <button id="clearAll" class="danger">Očisti sve poligone</button>

    <label>Pouzdanost kamere (dan)</label>
    <input type="text" id="camRel" value="0.75" />
    <label>Pouzdanost (noć)</label>
    <input type="text" id="nightRel" value="0.45" />

    <div class="row" style="margin-top:10px;">
      <button id="testBtn">Test (preview)</button>
      <button id="saveBtn" class="primary">Spremi override</button>
    </div>

    <div class="counts" id="counts"></div>

    <label>YOLO / ROI rezultat</label>
    <pre id="features">—</pre>

    <label>STATIC_ROI_CONFIGS snippet (kopiraj &amp; commitaj)</label>
    <pre id="snippet">—</pre>
  </aside>
  <section class="canvasWrap">
    <canvas id="cv" width="960" height="540"></canvas>
    <p class="muted">Klikni na slici za dodavanje točaka. Crveno = queue ROI, žuto = ignore (parking/suprotni smjer). Zelene kutije = YOLO detekcije. Koordinate se spremaju normalizirano (0..1).</p>
  </section>
</main>
<script>
(function(){
  var API = '/api/internal/traffic-vision';
  var img = new Image();
  var imgLoaded = false;
  var detections = [];
  var imageMeta = { width: 0, height: 0, coordSpace: 'percent' };
  var queuePoly = [];        // normalized {x,y}
  var ignorePolys = [];      // array of normalized polygons
  var currentIgnore = [];
  var mode = 'queue';
  var canvas = document.getElementById('cv');
  var ctx = canvas.getContext('2d');

  function token(){ return document.getElementById('token').value.trim(); }
  function headers(){ var h = { 'Content-Type': 'application/json' }; if (token()) h['x-debug-token'] = token(); return h; }
  function setStatus(msg, cls){ var s = document.getElementById('status'); s.textContent = msg || ''; s.className = 'muted ' + (cls||''); }

  // localStorage token
  try { var t = localStorage.getItem('roiToken'); if (t) document.getElementById('token').value = t; } catch(e){}
  document.getElementById('saveToken').onclick = function(){ try { localStorage.setItem('roiToken', token()); } catch(e){} setStatus('Token spremljen.', 'ok'); };

  document.querySelectorAll('.mode button').forEach(function(b){
    b.onclick = function(){
      mode = b.getAttribute('data-mode');
      document.getElementById('modeQueue').classList.toggle('active', mode==='queue');
      document.getElementById('modeIgnore').classList.toggle('active', mode==='ignore');
    };
  });

  function loadAudit(){
    setStatus('Učitavam kamere…');
    fetch(API + '/roi-audit', { headers: headers() }).then(function(r){ return r.json().then(function(j){ return {s:r.status, j:j}; }); }).then(function(res){
      var j = res.j;
      document.getElementById('flagPill').textContent = 'ROIv2:' + (j.roiV2Enabled? 'on':'off') + ' · predV2:' + (j.predictionV2Enabled? 'on':'off');
      if (!j.ok){ setStatus((res.s===404? 'Editor isključen (flag off).' : (res.s===401? 'Neispravan token / nema admin sesije.' : 'Greška.')), 'err'); return; }
      var sel = document.getElementById('cameraSel');
      sel.innerHTML = '';
      (j.cameras||[]).forEach(function(c){
        var o = document.createElement('option');
        o.value = c.cameraId;
        o.textContent = c.cameraId + ' · ' + (c.label||'') + ' [' + (c.roiSource||'bez ROI') + ']';
        sel.appendChild(o);
      });
      setStatus('Učitano ' + (j.cameras||[]).length + ' kamera.', 'ok');
    }).catch(function(e){ setStatus('Mreža: ' + e.message, 'err'); });
  }
  document.getElementById('loadAudit').onclick = loadAudit;

  function applyConfig(cfg){
    queuePoly = []; ignorePolys = []; currentIgnore = [];
    if (cfg && Array.isArray(cfg.queuePolygon)) queuePoly = cfg.queuePolygon.map(function(p){ return { x: p.x, y: p.y }; });
    if (cfg && Array.isArray(cfg.ignorePolygons)) ignorePolys = cfg.ignorePolygons.map(function(poly){ return (poly||[]).map(function(p){ return {x:p.x,y:p.y}; }); });
    if (cfg && cfg.cameraReliability != null) document.getElementById('camRel').value = cfg.cameraReliability;
    if (cfg && cfg.nightReliability != null) document.getElementById('nightRel').value = cfg.nightReliability;
  }

  function loadCam(){
    var id = document.getElementById('cameraSel').value;
    var dir = document.getElementById('dirSel').value;
    if (!id){ setStatus('Odaberi kameru.', 'warn'); return; }
    setStatus('Učitavam ' + id + '…');
    fetch(API + '/roi-debug/' + encodeURIComponent(id) + '?direction=' + dir, { headers: headers() }).then(function(r){ return r.json(); }).then(function(j){
      if (!j.ok){ setStatus(j.error || 'Greška.', 'err'); return; }
      detections = (j.yolo && j.yolo.detections) || [];
      imageMeta = j.imageMeta || imageMeta;
      applyConfig(j.roiConfig);
      document.getElementById('features').textContent = JSON.stringify({ roiConfigSource: j.roiConfigSource, classification: j.classification, roiFeatures: j.roiFeatures, yolo: j.yolo? { count: j.yolo.count, fallbackReason: j.yolo.fallbackReason } : null }, null, 2);
      if (j.imageUnavailable || !j.imageDataUrl){ imgLoaded = false; draw(); setStatus('Slika nedostupna (placeholder/timeout). Možeš i dalje crtati ako znaš kadar.', 'warn'); return; }
      img.onload = function(){ imgLoaded = true; draw(); setStatus('Učitano. Detekcija: ' + detections.length, 'ok'); };
      img.src = j.imageDataUrl;
    }).catch(function(e){ setStatus('Mreža: ' + e.message, 'err'); });
  }
  document.getElementById('loadCam').onclick = loadCam;

  function toCanvas(p){ return { x: p.x * canvas.width, y: p.y * canvas.height }; }
  function detCenterNorm(d){
    // detections are percent coords {x,y} = center already in this app's YOLO normalization
    return { x: (Number(d.x)||0)/100, y: (Number(d.y)||0)/100, w: (Number(d.w)||0)/100, h: (Number(d.h)||0)/100 };
  }

  function drawPoly(poly, color, fill){
    if (!poly.length) return;
    ctx.beginPath();
    poly.forEach(function(p, i){ var c = toCanvas(p); if (i===0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y); });
    if (poly.length > 2) ctx.closePath();
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
    if (fill){ ctx.fillStyle = fill; ctx.fill(); }
    poly.forEach(function(p){ var c = toCanvas(p); ctx.fillStyle = color; ctx.fillRect(c.x-3, c.y-3, 6, 6); });
  }

  function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (imgLoaded){ ctx.drawImage(img, 0, 0, canvas.width, canvas.height); }
    else { ctx.fillStyle = '#111'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.fillStyle='#555'; ctx.fillText('(bez slike)', 12, 20); }
    // YOLO boxes
    detections.forEach(function(d){
      var c = detCenterNorm(d);
      var x = (c.x - c.w/2) * canvas.width, y = (c.y - c.h/2) * canvas.height;
      ctx.strokeStyle = 'rgba(74,222,128,.9)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, c.w*canvas.width, c.h*canvas.height);
    });
    drawPoly(queuePoly, '#ef4444', 'rgba(239,68,68,.15)');
    ignorePolys.forEach(function(p){ drawPoly(p, '#fbbf24', 'rgba(251,191,36,.18)'); });
    drawPoly(currentIgnore, '#fbbf24', 'rgba(251,191,36,.18)');
  }

  canvas.addEventListener('click', function(ev){
    var rect = canvas.getBoundingClientRect();
    var x = (ev.clientX - rect.left) / rect.width;
    var y = (ev.clientY - rect.top) / rect.height;
    x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
    if (mode === 'queue') queuePoly.push({ x: round3(x), y: round3(y) });
    else currentIgnore.push({ x: round3(x), y: round3(y) });
    draw();
  });
  function round3(v){ return Math.round(v*1000)/1000; }

  document.getElementById('finishPoly').onclick = function(){
    if (mode === 'ignore' && currentIgnore.length >= 3){ ignorePolys.push(currentIgnore); currentIgnore = []; }
    draw();
  };
  document.getElementById('undoPt').onclick = function(){
    if (mode === 'queue') queuePoly.pop(); else currentIgnore.pop();
    draw();
  };
  document.getElementById('clearAll').onclick = function(){ queuePoly = []; ignorePolys = []; currentIgnore = []; draw(); };

  function candidateConfig(){
    var ign = ignorePolys.slice();
    if (currentIgnore.length >= 3) ign = ign.concat([currentIgnore]);
    return {
      queuePolygon: queuePoly,
      ignorePolygons: ign,
      cameraReliability: parseFloat(document.getElementById('camRel').value) || 0.7,
      nightReliability: parseFloat(document.getElementById('nightRel').value) || 0.45,
      roiVersion: 'editor-' + new Date().toISOString().slice(0,10),
      isActive: true,
    };
  }

  document.getElementById('testBtn').onclick = function(){
    var id = document.getElementById('cameraSel').value;
    var dir = document.getElementById('dirSel').value;
    if (queuePoly.length < 3){ setStatus('Queue poligon treba ≥3 točke.', 'warn'); return; }
    setStatus('Testiram…');
    fetch(API + '/roi-test/' + encodeURIComponent(id), { method: 'POST', headers: headers(), body: JSON.stringify({ direction: dir, roiConfig: candidateConfig(), detections: detections, imageMeta: imageMeta }) })
      .then(function(r){ return r.json(); }).then(function(j){
        if (!j.ok){ setStatus((j.errors||[j.error]).join(', '), 'err'); return; }
        renderCounts(j.roiFeatures);
        document.getElementById('features').textContent = JSON.stringify(j.roiFeatures, null, 2);
        setStatus('Test gotov.', 'ok');
      }).catch(function(e){ setStatus('Mreža: ' + e.message, 'err'); });
  };

  function renderCounts(f){
    if (!f){ document.getElementById('counts').innerHTML = ''; return; }
    var el = document.getElementById('counts');
    el.innerHTML = '';
    [['Vidljivo', f.visibleVehicleCount],['U koloni', f.vehiclesInQueueRoi],['Ignorirano', f.vehiclesIgnored],['Izvan ROI', f.vehiclesOutsideRoi],['Trusted', f.roiTrusted ? 'DA' : 'NE']].forEach(function(pair){
      var d = document.createElement('div'); d.className = 'c'; d.innerHTML = '<b>' + (pair[1] == null ? '—' : pair[1]) + '</b>' + pair[0]; el.appendChild(d);
    });
  }

  document.getElementById('saveBtn').onclick = function(){
    var id = document.getElementById('cameraSel').value;
    var dir = document.getElementById('dirSel').value;
    if (queuePoly.length < 3){ setStatus('Queue poligon treba ≥3 točke prije spremanja.', 'warn'); return; }
    if (!confirm('Spremiti ROI override za ' + id + '? (Runtime override; za trajno commitaj snippet.)')) return;
    setStatus('Spremam…');
    var cfg = candidateConfig(); cfg.direction = dir;
    fetch(API + '/roi-config/' + encodeURIComponent(id), { method: 'PUT', headers: headers(), body: JSON.stringify(cfg) })
      .then(function(r){ return r.json(); }).then(function(j){
        if (!j.ok){ setStatus((j.errors||[j.error]).join(', '), 'err'); return; }
        document.getElementById('snippet').textContent = JSON.stringify(j.staticSnippet, null, 2);
        var trusted = j.roiTrusted ? '✓ ROI TRUSTED — broj vozila sada vodi procjenu' : '⚠ ROI nije trusted (ostaje vizualna provjera)';
        setStatus('Spremljeno (' + (j.persistence||'?') + '). ' + trusted + (j.warning ? ' — ' + j.warning : ''), j.warning ? 'warn' : (j.roiTrusted ? 'ok' : 'warn'));
      }).catch(function(e){ setStatus('Mreža: ' + e.message, 'err'); });
  };

  // auto-load audit if a token is already stored
  if (token()) loadAudit();
})();
</script>
</body>
</html>`;
