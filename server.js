/*
 * ゲームポケット - 教室で使うミニゲームをまとめて管理・配布するハブ
 *
 * 追加パッケージなしで動きます（Node.js の標準機能のみ使用）。
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'games.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 12 * 1024 * 1024; // 12MB（説明書の画像を含むため余裕を持たせる）
const MAX_IMAGES = 4;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || '';

if(!ADMIN_PASSCODE){
  console.warn('※ ADMIN_PASSCODE が設定されていません。編集（追加・削除）はすべて拒否されます。Renderの Environment タブで設定してください。');
}

function checkPasscode(candidate){
  return !!ADMIN_PASSCODE && typeof candidate === 'string' && candidate === ADMIN_PASSCODE;
}

/*
 * Renderの無料プランには永続ディスクがなく、アクセスがない時間が続くと
 * サーバーが休止→再起動する際にローカルファイルへの変更が失われる。
 * それを防ぐため、GITHUB_TOKEN が設定されている場合は
 * games.json の読み書きをGitHubリポジトリ本体に対して行う。
 */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'study-navi/game-pocket';
const GITHUB_BRANCH = 'main';
const GITHUB_FILE_PATH = 'games.json';
let githubSha = null;

if(!GITHUB_TOKEN){
  console.warn('※ GITHUB_TOKEN が設定されていません。データはこのサーバーのローカルファイルにのみ保存され、再起動で消える可能性があります。');
}

function githubRequest(method, apiPath, body, cb){
  const data = body ? JSON.stringify(body) : null;
  const options = {
    hostname: process.env.GITHUB_API_HOST || 'api.github.com',
    port: process.env.GITHUB_API_PORT || 443,
    path: apiPath,
    method: method,
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'User-Agent': 'game-pocket-app',
      'Accept': 'application/vnd.github+json'
    }
  };
  if(data){
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(data);
  }
  const req = https.request(options, function(res){
    let chunks = '';
    res.on('data', function(c){ chunks += c; });
    res.on('end', function(){
      let json = null;
      try{ json = chunks ? JSON.parse(chunks) : {}; }catch(e){}
      if(res.statusCode >= 200 && res.statusCode < 300){
        cb(null, json);
      } else {
        cb(new Error('GitHub API error ' + res.statusCode + ': ' + ((json && json.message) || chunks)));
      }
    });
  });
  req.on('error', cb);
  if(data) req.write(data);
  req.end();
}

function githubFetchGames(cb){
  githubRequest('GET', '/repos/' + GITHUB_REPO + '/contents/' + GITHUB_FILE_PATH + '?ref=' + GITHUB_BRANCH, null, function(err, json){
    if(err){ cb(err); return; }
    try{
      const content = Buffer.from(json.content, 'base64').toString('utf8');
      githubSha = json.sha;
      cb(null, JSON.parse(content));
    }catch(e){ cb(e); }
  });
}

function githubFetchSha(cb){
  githubRequest('GET', '/repos/' + GITHUB_REPO + '/contents/' + GITHUB_FILE_PATH + '?ref=' + GITHUB_BRANCH, null, function(err, json){
    if(err){ cb(err); return; }
    githubSha = json.sha;
    cb(null);
  });
}

function githubSaveGames(gamesData, cb, isRetry){
  const content = Buffer.from(JSON.stringify(gamesData, null, 2), 'utf8').toString('base64');
  const body = {
    message: 'ゲームポケット: データ更新 ' + new Date().toISOString(),
    content: content,
    branch: GITHUB_BRANCH
  };
  if(githubSha) body.sha = githubSha;
  githubRequest('PUT', '/repos/' + GITHUB_REPO + '/contents/' + GITHUB_FILE_PATH, body, function(err, json){
    if(err){
      if(!isRetry){
        githubFetchSha(function(){
          githubSaveGames(gamesData, cb, true);
        });
        return;
      }
      cb(err);
      return;
    }
    if(json && json.content && json.content.sha) githubSha = json.content.sha;
    cb(null);
  });
}

let games = [];

function loadLocalFallback(){
  try{
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    games = JSON.parse(raw);
    if(!Array.isArray(games)) games = [];
  }catch(e){
    games = [];
  }
}

function loadData(cb){
  if(GITHUB_TOKEN){
    githubFetchGames(function(err, data){
      if(err){
        console.warn('GitHubからの読み込みに失敗したため、ローカルファイルを使用します:', err.message);
        loadLocalFallback();
      } else {
        games = Array.isArray(data) ? data : [];
        console.log('GitHubから games.json を読み込みました（' + games.length + '件）');
      }
      if(cb) cb();
    });
  } else {
    loadLocalFallback();
    if(cb) cb();
  }
}

function saveData(){
  try{
    fs.writeFileSync(DATA_FILE, JSON.stringify(games, null, 2));
  }catch(e){
    console.error('ローカル保存に失敗しました:', e.message);
  }
  if(GITHUB_TOKEN){
    githubSaveGames(games, function(err){
      if(err) console.error('GitHubへの保存に失敗しました:', err.message);
      else console.log('GitHubに保存しました');
    });
  }
}

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

function sanitizeImages(images){
  if(!Array.isArray(images)) return [];
  return images
    .filter(function(s){ return typeof s === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,/.test(s); })
    .slice(0, MAX_IMAGES);
}

function buildFieldsFromBody(body){
  const fields = {};
  if(typeof body.name === 'string' && body.name.trim()) fields.name = body.name.trim();
  if(typeof body.emoji === 'string' && body.emoji.trim()) fields.emoji = body.emoji.trim();
  if(isValidUrl(body.studentUrl)) fields.studentUrl = body.studentUrl.trim();
  if(typeof body.teacherUrl === 'string') fields.teacherUrl = isValidUrl(body.teacherUrl) ? body.teacherUrl.trim() : '';
  if(typeof body.tvUrl === 'string') fields.tvUrl = isValidUrl(body.tvUrl) ? body.tvUrl.trim() : '';
  if(typeof body.note === 'string') fields.note = body.note.trim().slice(0, 200);
  if(typeof body.grade === 'string') fields.grade = body.grade.trim().slice(0, 50);
  if(typeof body.manual === 'string') fields.manual = body.manual.trim().slice(0, 4000);
  if(body.images !== undefined) fields.images = sanitizeImages(body.images);
  return fields;
}

const server = http.createServer(function(req, res){
  const url = (req.url || '/').split('?')[0];

  if(req.method === 'OPTIONS'){
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Passcode' });
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
      const fields = buildFieldsFromBody(body);
      const game = Object.assign({
        id: crypto.randomBytes(4).toString('hex'),
        name: '',
        emoji: '🎮',
        studentUrl: '',
        teacherUrl: '',
        tvUrl: '',
        note: '',
        grade: '',
        manual: '',
        images: [],
        addedAt: Date.now()
      }, fields);
      games.push(game);
      saveData();
      sendJson(res, 200, { game: game });
    });
    return;
  }

  if(req.method === 'PUT' && url.indexOf('/api/games/') === 0){
    const id = url.slice('/api/games/'.length);
    readJsonBody(req, function(body){
      if(!checkPasscode(body && body.passcode)){
        sendJson(res, 401, { error: '編集用パスコードが正しくありません' });
        return;
      }
      const idx = games.findIndex(function(g){ return g.id === id; });
      if(idx === -1){
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const fields = buildFieldsFromBody(body);
      games[idx] = Object.assign({}, games[idx], fields);
      saveData();
      sendJson(res, 200, { game: games[idx] });
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

loadData(function(){
  server.listen(PORT, '0.0.0.0', function(){
    console.log('');
    console.log('ゲームポケットが起動しました（ポート ' + PORT + '）');
    console.log('ブラウザで http://localhost:' + PORT + '/ を開いてください');
    console.log('');
  });
});
