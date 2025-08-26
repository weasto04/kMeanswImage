// Minimal front-end-only RGB k-means image segmentation.
// No frameworks. Uses canvas 2D for image display and a simple 3D projection for plotting.

const fileInput = document.getElementById('fileInput');
const plotBtn = document.getElementById('plotBtn');
const clusterBtn = document.getElementById('clusterBtn');
const resetBtn = document.getElementById('resetBtn');
const kInput = document.getElementById('kInput');
const logEl = document.getElementById('log');

const origCanvas = document.getElementById('origCanvas');
const segCanvas = document.getElementById('segCanvas');
const plotCanvas = document.getElementById('plotCanvas');
// interactive view state (rotate/pan/zoom)
let rotXVal = 25 * Math.PI/180, rotYVal = -30 * Math.PI/180, zoomVal = 1.2;
let panX = 0, panY = 0;

let imgData = null; // {w,h,pixels: Float32Array of [r,g,b,...] in 0..1}
let points = []; // array of [r,g,b]
let centroids = [];
let clustered = false;

function log(...args){ logEl.textContent = args.join(' '); }

fileInput.addEventListener('change', async (e)=>{
  const f = e.target.files && e.target.files[0];
  if(!f) return;
  const img = await loadImageFromFile(f);
  drawToCanvas(img, origCanvas);
  imgData = getImageDataFromCanvas(origCanvas);
  segCanvas.width = origCanvas.width; segCanvas.height = origCanvas.height;
  // reset clustering state when a new image is loaded
  clustered = false; centroids = []; points = [];
  clusterBtn.disabled = false;
  log('Image loaded', imgData.w + 'x' + imgData.h);
});

plotBtn.addEventListener('click', ()=>{
  if(!imgData) { log('Load an image first'); return; }
  buildPoints();
  drawPlot();
  log('Plotted', points.length, 'points');
});

clusterBtn.addEventListener('click', ()=>{
  if(clustered) { log('K-means already run — reset or load a new image to run again'); return; }
  if(!imgData) { log('Load an image first'); return; }
  clusterBtn.disabled = true; // prevent double-click/re-run
  // ensure points exist (build from image) and show cloud before clustering
  if(!points.length) buildPoints();
  drawPlot();
  const k = Math.max(1, Math.floor(Number(kInput.value) || 3));
  log('Running k-means k=' + k + ' ...');
  // run k-means (blocking but usually fast for resized images)
  centroids = kmeans(points, k, {maxIter:30});
  clustered = true;
  drawPlot();
  applySegmentation();
  log('K-means finished — segmented image displayed');
});

resetBtn.addEventListener('click', ()=>{
  imgData = null; points = []; centroids = []; fileInput.value=''; origCanvas.width=origCanvas.height=0; segCanvas.width=segCanvas.height=0; clearPlot(); log('Reset');
  // clear clustering state and re-enable button
  clustered = false; clusterBtn.disabled = false;
});

// --- Pointer / touch / wheel controls for plotCanvas ---
const pointers = new Map();
let lastPinchDist = null, lastMid = null, lastSingle = null;

plotCanvas.addEventListener('pointerdown', (e)=>{
  plotCanvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(pointers.size===1){ lastSingle = {x:e.clientX, y:e.clientY}; }
  else if(pointers.size===2){
    const ps = Array.from(pointers.values());
    lastPinchDist = distance(ps[0], ps[1]);
    lastMid = midpoint(ps[0], ps[1]);
  }
});
plotCanvas.addEventListener('pointermove', (e)=>{
  if(!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(pointers.size===1){
    const p = pointers.values().next().value;
    if(lastSingle){
      const dx = p.x - lastSingle.x, dy = p.y - lastSingle.y;
      // rotate
      rotYVal += dx * 0.01;
      rotXVal += dy * 0.01;
      drawPlot();
    }
    lastSingle = {x:p.x, y:p.y};
  } else if(pointers.size===2){
    const ps = Array.from(pointers.values());
    const dist = distance(ps[0], ps[1]);
    const mid = midpoint(ps[0], ps[1]);
    if(lastPinchDist!=null){
      const factor = dist / lastPinchDist;
      zoomVal *= factor;
    }
    if(lastMid!=null){
      panX += (mid.x - lastMid.x);
      panY += (mid.y - lastMid.y);
    }
    lastPinchDist = dist; lastMid = mid; lastSingle = null;
    drawPlot();
  }
});
plotCanvas.addEventListener('pointerup', (e)=>{ pointers.delete(e.pointerId); lastPinchDist=null; lastMid=null; lastSingle=null; });
plotCanvas.addEventListener('pointercancel', (e)=>{ pointers.delete(e.pointerId); lastPinchDist=null; lastMid=null; lastSingle=null; });
plotCanvas.addEventListener('wheel', (e)=>{ e.preventDefault(); const delta = -e.deltaY; zoomVal *= (1 + delta*0.001); drawPlot(); }, {passive:false});

function distance(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }
function midpoint(a,b){ return {x:(a.x+b.x)/2, y:(a.y+b.y)/2}; }

function loadImageFromFile(file){
  return new Promise((res, rej)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{ URL.revokeObjectURL(url); res(img); };
    img.onerror = rej; img.src = url;
  });
}

function drawToCanvas(img, canvas){
  const maxW = 600; // limit size to keep things snappy
  const scale = Math.min(1, maxW / img.width);
  canvas.width = Math.round(img.width*scale);
  canvas.height = Math.round(img.height*scale);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(img,0,0,canvas.width,canvas.height);
}

function getImageDataFromCanvas(canvas){
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const raw = ctx.getImageData(0,0,w,h).data;
  const pixels = new Float32Array(w*h*3);
  for(let i=0;i<w*h;i++){
    pixels[i*3+0] = raw[i*4+0]/255;
    pixels[i*3+1] = raw[i*4+1]/255;
    pixels[i*3+2] = raw[i*4+2]/255;
  }
  return {w,h,pixels};
}

function buildPoints(){
  points = [];
  const {w,h,pixels} = imgData;
  // sample every pixel (image is resized on load to keep sizes reasonable)
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i = (y*w + x)*3;
      points.push([pixels[i], pixels[i+1], pixels[i+2]]);
    }
  }
}

function clearPlot(){
  const ctx = plotCanvas.getContext('2d'); ctx.clearRect(0,0,plotCanvas.width,plotCanvas.height);
}

function drawPlot(){
  const ctx = plotCanvas.getContext('2d');
  ctx.clearRect(0,0,plotCanvas.width,plotCanvas.height);
  ctx.fillStyle='black'; ctx.fillRect(0,0,plotCanvas.width,plotCanvas.height);
  if(!points.length) return;

  const cx = plotCanvas.width/2 + panX, cy = plotCanvas.height/2 + panY;
  const scale = Math.min(plotCanvas.width, plotCanvas.height)/2 * zoomVal;
  const Rx = rotationMatrixX(rotXVal), Ry = rotationMatrixY(rotYVal);

  // draw points
  for(let i=0;i<points.length;i++){
    const p = points[i];
    const v = mulMat(Rx, p); // Rx * p
    const v2 = mulMat(Ry, v);
    const sx = cx + v2[0]*scale;
    const sy = cy - v2[1]*scale;
    ctx.fillStyle = `rgb(${Math.round(p[0]*255)},${Math.round(p[1]*255)},${Math.round(p[2]*255)})`;
  ctx.fillRect(sx, sy, 2, 2);
  }

  // draw centroids on top if available; make them larger and add contrasting stroke
  if(centroids && centroids.length){
    for(const c of centroids){
      const v = mulMat(Rx, c);
      const v2 = mulMat(Ry, v);
      const sx = cx + v2[0]*scale;
      const sy = cy - v2[1]*scale;
      const rr = 10;
      ctx.beginPath(); ctx.arc(sx,sy,rr,0,Math.PI*2);
      ctx.fillStyle = `rgb(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)})`;
      ctx.fill();
      // choose stroke color for contrast
      const lum = 0.299*c[0] + 0.587*c[1] + 0.114*c[2];
      ctx.lineWidth = 3;
      ctx.strokeStyle = lum > 0.5 ? '#000' : '#fff';
      ctx.stroke();
    }
  }
}

function rotationMatrixX(a){
  const ca=Math.cos(a), sa=Math.sin(a);
  return [[1,0,0],[0,ca,-sa],[0,sa,ca]];
}
function rotationMatrixY(a){
  const ca=Math.cos(a), sa=Math.sin(a);
  return [[ca,0,sa],[0,1,0],[-sa,0,ca]];
}
function mulMat(M, v){
  return [ M[0][0]*v[0]+M[0][1]*v[1]+M[0][2]*v[2], M[1][0]*v[0]+M[1][1]*v[1]+M[1][2]*v[2], M[2][0]*v[0]+M[2][1]*v[1]+M[2][2]*v[2] ];
}

// Simple k-means implementation on array of [r,g,b] in 0..1
function kmeans(X, k, opts={maxIter:50}){
  const n = X.length;
  // init: pick k random points
  const rng = ()=>Math.floor(Math.random()*n);
  let C = [];
  const used = new Set();
  while(C.length<k){ const i=rng(); if(used.has(i)) continue; used.add(i); C.push(X[i].slice()); }

  const labels = new Array(n).fill(0);
  for(let iter=0; iter<opts.maxIter; iter++){
    let changed = false;
    // assign
    for(let i=0;i<n;i++){
      const x = X[i];
      let best=0, bestd=dist2(x, C[0]);
      for(let j=1;j<k;j++){ const d=dist2(x,C[j]); if(d<bestd){ bestd=d; best=j; } }
      if(labels[i]!==best){ labels[i]=best; changed=true; }
    }

    // update
    const sums = Array.from({length:k}, ()=>[0,0,0]);
    const counts = new Array(k).fill(0);
    for(let i=0;i<n;i++){ const l=labels[i]; const x=X[i]; sums[l][0]+=x[0]; sums[l][1]+=x[1]; sums[l][2]+=x[2]; counts[l]++; }
    for(let j=0;j<k;j++){
      if(counts[j]===0) continue; C[j][0]=sums[j][0]/counts[j]; C[j][1]=sums[j][1]/counts[j]; C[j][2]=sums[j][2]/counts[j];
    }
    if(!changed) break;
  }
  return C;
}

function dist2(a,b){
  const dx=a[0]-b[0], dy=a[1]-b[1], dz=a[2]-b[2]; return dx*dx+dy*dy+dz*dz;
}

function applySegmentation(){
  if(!imgData) return;
  const {w,h,pixels} = imgData;
  const ctx = segCanvas.getContext('2d');
  const out = ctx.createImageData(w,h);
  // for each pixel, find nearest centroid
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i = (y*w + x)*3;
      const px = [pixels[i], pixels[i+1], pixels[i+2]];
      let best=0, bestd=dist2(px, centroids[0]);
      for(let j=1;j<centroids.length;j++){ const d=dist2(px, centroids[j]); if(d<bestd){ best=j; bestd=d; } }
      const c = centroids[best];
      const oi = (y*w + x)*4;
      out.data[oi+0] = Math.round(c[0]*255);
      out.data[oi+1] = Math.round(c[1]*255);
      out.data[oi+2] = Math.round(c[2]*255);
      out.data[oi+3] = 255;
    }
  }
  ctx.putImageData(out,0,0);
  log('Segmentation applied');
}

// Expose a small helper for debugging in console
window._kmeans_app = { imgData, points, centroids };
