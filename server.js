/*
 * ゲームポケット - 教室で使うミニゲームをまとめて管理・配布するハブ
 *
 * 追加パッケージなしで動きます（Node.js の標準機能のみ使用）。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'games.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 256 * 1024; // 256KB で十分
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || '';

if(!ADMIN_PASSCODE){
  console.warn('※ ADMIN_PASSCODE が設定されていません。編集（追加・削除）はすべて拒否されます。Renderの Environment タブで設定してください。');
}

function checkPasscode(candidate){
  return !!ADMIN_PASSCODE && typeof candidate === 'string' && candidate === ADMIN_PASSCODE;
}

let games = [];

function loadData(){
  try{
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    games = JSON.parse(raw);
    if(!Array.isArray(games)) games = [];
  }catch(e){
    games = [];
  }
}
function saveData(){
  try{
    fs.writeFileSync(DATA_FILE, JSON.stringify(games, null, 2));
  }catch(e){
    console.error('保存に失敗しました:', e.message);
  }
}
loadData();

function sendJson(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveFile(res, filePath, contentType){
  fs.readFile(filePath, function(err, data){
    if(err){
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function readJsonBody(req, cb){
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on('data', function(chunk){
    size += chunk.length;
    if(size > MAX_BODY_BYTES){
      tooLarge = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function(){
    if(tooLarge){ cb(null); return; }
    const raw = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try{ json = raw ? JSON.parse(raw) : {}; }catch(e){ json = null; }
    cb(json);
  });
  req.on('error', function(){ cb(null); });
}

function isValidUrl(v){
  if(typeof v !== 'string' || !v) return false;
  try{
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  }catch(e){
    return false;
  }
}

const server = http.createServer(function(req, res){
  const url = (req.url || '/').split('?')[0];

  if(req.method === 'OPTIONS'){
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if(req.method === 'GET' && url === '/'){
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  if(req.method === 'GET' && url === '/api/games'){
    sendJson(res, 200, { games: games });
    return;
  }

  if(req.method === 'POST' && url === '/api/unlock'){
    readJsonBody(req, function(body){
      sendJson(res, 200, { ok: checkPasscode(body && body.passcode) });
    });
    return;
  }

  if(req.method === 'POST' && url === '/api/games'){
    readJsonBody(req, function(body){
      if(!checkPasscode(body && body.passcode)){
        sendJson(res, 401, { error: '編集用パスコードが正しくありません' });
        return;
      }
      if(!body || typeof body.name !== 'string' || !body.name.trim()){
        sendJson(res, 400, { error: 'ゲーム名を入力してください' });
        return;
      }
      if(!isValidUrl(body.studentUrl)){
        sendJson(res, 400, { error: '生徒用URLが正しくありません' });
        return;
      }
      const game = {
        id: crypto.randomBytes(4).toString('hex'),
        name: body.name.trim(),
        emoji: (typeof body.emoji === 'string' && body.emoji.trim()) ? body.emoji.trim() : '🎮',
        studentUrl: body.studentUrl.trim(),
        teacherUrl: isValidUrl(body.teacherUrl) ? body.teacherUrl.trim() : '',
        tvUrl: isValidUrl(body.tvUrl) ? body.tvUrl.trim() : '',
        note: (typeof body.note === 'string') ? body.note.trim().slice(0, 200) : '',
        addedAt: Date.now()
      };
      games.push(game);
      saveData();
      sendJson(res, 200, { game: game });
    });
    return;
  }

  if(req.method === 'DELETE' && url.indexOf('/api/games/') === 0){
    if(!checkPasscode(req.headers['x-passcode'])){
      sendJson(res, 401, { error: '編集用パスコードが正しくありません' });
      return;
    }
    const id = url.slice('/api/games/'.length);
    const before = games.length;
    games = games.filter(function(g){ return g.id !== id; });
    if(games.length === before){
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    saveData();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', function(){
  console.log('');
  console.log('ゲームポケットが起動しました（ポート ' + PORT + '）');
  console.log('ブラウザで http://localhost:' + PORT + '/ を開いてください');
  console.log('');
});
