'use strict';
// 原子 JSON/文本读写。data/ 位于静态 Web 根 public/ 之外，永不被 express.static 暴露。
const fs = require('fs');
const path = require('path');

const { resolveDataDirectory } = require('./data-directory');
const DATA_DIR = resolveDataDirectory();
const MAX_DATA_FILE_BYTES = 8 * 1024 * 1024;
let stderrUsable = true;
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', () => { stderrUsable = false; });
}
function warn(message) {
  if (!stderrUsable) return;
  try { process.stderr.write(message); } catch (_) { stderrUsable = false; }
}

function ensureDir() {
  validateDirectory();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  validateDirectory();
}
function validateDirectory() {
  if (resolveDataDirectory(DATA_DIR) !== DATA_DIR) throw new Error('DATA_DIR 路径在运行中发生变化');
}
function dataPath(name) {
  validateDirectory();
  if (typeof name !== 'string' || !name || path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error('非法数据文件名');
  }
  return path.join(DATA_DIR, name);
}

// 读取并区分三态：missing(文件不存在，合法首启) / ok / corrupt(存在但为空/无法解析)。
// 关键：corrupt 绝不能被静默当成"未设置"——否则损坏的 password.json 会重开无认证 setup。
function readState(name) {
  const p = dataPath(name);
  let st;
  try { st = fs.lstatSync(p); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing', value: undefined, error: null };
    return { status: 'corrupt', value: undefined, error: e };
  }
  // 避免读取 FIFO/设备导致主线程永久阻塞，也避免损坏或被替换的超大 JSON 在启动时耗尽内存。
  if (!st.isFile()) return { status: 'corrupt', value: undefined, error: new Error('数据路径不是普通文件') };
  if (st.size > MAX_DATA_FILE_BYTES) {
    return { status: 'corrupt', value: undefined, error: new Error(`数据文件超过 ${MAX_DATA_FILE_BYTES} 字节上限`) };
  }
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); }
  catch (e) { return { status: 'corrupt', value: undefined, error: e }; }
  if (!txt.trim()) return { status: 'corrupt', value: undefined, error: new Error('空文件') };
  try {
    const v = JSON.parse(txt);
    if (v == null) return { status: 'corrupt', value: undefined, error: new Error('JSON 解析为 null') };
    return { status: 'ok', value: v, error: null };
  } catch (e) {
    return { status: 'corrupt', value: undefined, error: e };
  }
}

function readJSON(name, fallback) {
  const r = readState(name);
  if (r.status === 'corrupt') {
    // 不静默吞掉：存在但损坏的数据文件必须留痕（journald 可见），且保留原文件不覆盖
    warn(`[store] ${name} 损坏，已回退默认值（原文件保留）：${r.error && r.error.message}\n`);
  }
  return r.status === 'ok' ? r.value : fallback;
}

function writeJSON(name, data) {
  ensureDir();
  const p = dataPath(name);
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const buf = Buffer.from(JSON.stringify(data, null, 2));
  try {
    // 独占创建，随机名意外碰撞或被预先放置时安全失败，绝不跟随既有临时文件。
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      let offset = 0;
      while (offset < buf.length) {
        const written = fs.writeSync(fd, buf, offset, buf.length - offset, null);
        if (!Number.isInteger(written) || written <= 0) throw new Error('写入数据文件时发生短写');
        offset += written;
      }
      fs.fsyncSync(fd);            // 数据块落盘，防断电/崩溃后留下 0 字节或半写文件
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
    // 目录项 fsync，使 rename 本身持久化（否则崩溃后 rename 可能回退到旧文件）
    try { const dfd = fs.openSync(DATA_DIR, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch (_) {}
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}  // 失败不遗留孤儿 .tmp
    throw e;
  }
}

function removeJSON(name) {
  const p = dataPath(name);
  let st;
  try { st = fs.lstatSync(p); }
  catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw e;
  }
  // 调用方只用它恢复一次尚未完成的原子写事务；拒绝目录、设备或符号链接等异常目标。
  if (!st.isFile()) throw new Error('拒绝删除非普通数据文件');
  fs.unlinkSync(p);
  try { const dfd = fs.openSync(DATA_DIR, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch (_) {}
}

// 启动时清理原子写残留的孤儿 .tmp（正常 rename 后不该存在，崩溃时可能残留）
function sweepTmp() {
  validateDirectory();
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {} }
    }
  } catch (_) {}
}

module.exports = { readState, readJSON, writeJSON, removeJSON, sweepTmp };
