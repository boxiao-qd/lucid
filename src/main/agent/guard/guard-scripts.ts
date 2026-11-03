// Guard scripts for workspace file operation interception.
//
// Three guard scripts are written to ~/.lucid/workspace/.guard/ at startup:
// 1. node-fs-guard.cjs  — monkey-patches fs module read+write methods + proxies child_process via IPC (Node.js)
// 2. python_fs_guard.py — monkey-patches builtins.open + os/shutil read+write + proxies subprocess via IPC (Python)
// 3. shell-guard.sh    — overrides read+write commands: cp/mv/rm/mkdir/ls/cat/grep/find (Bash/sh)
//
// code_execute injects these before executing user code.
// terminal sources shell-guard.sh and pre-scans for > >> redirects.
// The IPC proxy intercepts subprocess/child_process calls in user code,
// requests user confirmation, then executes via bash + shell-guard.sh.

import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { WORKSPACE_DIR } from '../../skills'

export const GUARD_DIR = join(WORKSPACE_DIR, '.guard')
export const NODE_GUARD_PATH = join(GUARD_DIR, 'node-fs-guard.cjs')
export const PYTHON_GUARD_PATH = join(GUARD_DIR, 'python_fs_guard.py')
export const SHELL_GUARD_PATH = join(GUARD_DIR, 'shell-guard.sh')

// ─────────────────────────────────────────────────────────────
// Node.js fs monkey-patch — loaded via `node --require`
// ─────────────────────────────────────────────────────────────
const NODE_FS_GUARD = `'use strict'
// Lucid workspace guard — monkey-patches fs module read+write methods
// to prevent file operations outside ~/.lucid/workspace/.
// Also proxies child_process calls through IPC for user confirmation.

const fs = require('fs')
const path = require('path')
const os = require('os')

const WORKSPACE = process.env.LUCID_WORKSPACE_DIR || path.join(os.homedir(), '.lucid', 'workspace')

function validatePath(p, op) {
  if (p == null) return
  if (typeof p === 'number') return // fd, not a path
  if (Buffer.isBuffer(p)) p = p.toString()
  if (p && typeof p === 'object') {
    // URL object — convert to path
    try {
      const url = new URL(p.href || p)
      if (url.protocol === 'file:') p = path.fromFileURL(url)
      else return
    } catch {
      return
    }
  }
  if (typeof p !== 'string') return
  if (!p) return
  const resolved = path.resolve(p)
  const rel = path.relative(WORKSPACE, resolved)
  if (rel.startsWith('..')) {
    const err = new Error(
      'GUARD: 拒绝 workspace 外' + op + '操作: ' + p + '\\n' +
      '所有文件操作必须在 ~/.lucid/workspace/ 下。' +
      '请将路径改为 workspace 内的相对路径或绝对路径。'
    )
    err.code = 'EWORKSPACE'
    throw err
  }
}

function checkWrite(p) { validatePath(p, '写') }
function checkRead(p) { validatePath(p, '读') }

const orig = {
  writeFileSync: fs.writeFileSync,
  appendFileSync: fs.appendFileSync,
  mkdirSync: fs.mkdirSync,
  rmSync: fs.rmSync,
  rmdirSync: fs.rmdirSync,
  unlinkSync: fs.unlinkSync,
  renameSync: fs.renameSync,
  copyFileSync: fs.copyFileSync,
  createWriteStream: fs.createWriteStream,
  truncateSync: fs.truncateSync,
  linkSync: fs.linkSync,
  symlinkSync: fs.symlinkSync,
  writeFile: fs.writeFile,
  appendFile: fs.appendFile,
  mkdir: fs.mkdir,
  rm: fs.rm,
  rmdir: fs.rmdir,
  unlink: fs.unlink,
  rename: fs.rename,
  copyFile: fs.copyFile,
  truncate: fs.truncate,
  link: fs.link,
  symlink: fs.symlink
}

// Sync methods — single-path operations
fs.writeFileSync = function(p) { checkWrite(p); return orig.writeFileSync.apply(fs, arguments) }
fs.appendFileSync = function(p) { checkWrite(p); return orig.appendFileSync.apply(fs, arguments) }
fs.mkdirSync = function(p) { checkWrite(p); return orig.mkdirSync.apply(fs, arguments) }
fs.rmSync = function(p) { checkWrite(p); return orig.rmSync.apply(fs, arguments) }
fs.rmdirSync = function(p) { checkWrite(p); return orig.rmdirSync.apply(fs, arguments) }
fs.unlinkSync = function(p) { checkWrite(p); return orig.unlinkSync.apply(fs, arguments) }
fs.createWriteStream = function(p) { checkWrite(p); return orig.createWriteStream.apply(fs, arguments) }
fs.truncateSync = function(p) { checkWrite(p); return orig.truncateSync.apply(fs, arguments) }

// Sync methods — dual-path operations (src + dst)
fs.renameSync = function(a, b) { checkWrite(a); checkWrite(b); return orig.renameSync.apply(fs, arguments) }
fs.copyFileSync = function(a, b) { checkWrite(a); checkWrite(b); return orig.copyFileSync.apply(fs, arguments) }
fs.linkSync = function(a, b) { checkWrite(a); checkWrite(b); return orig.linkSync.apply(fs, arguments) }
fs.symlinkSync = function(a, b) { checkWrite(a); checkWrite(b); return orig.symlinkSync.apply(fs, arguments) }

// Async methods — single-path
fs.writeFile = function(p) { checkWrite(p); return orig.writeFile.apply(fs, arguments) }
fs.appendFile = function(p) { checkWrite(p); return orig.appendFile.apply(fs, arguments) }
fs.mkdir = function(p) { checkWrite(p); return orig.mkdir.apply(fs, arguments) }
fs.rm = function(p) { checkWrite(p); return orig.rm.apply(fs, arguments) }
fs.rmdir = function(p) { checkWrite(p); return orig.rmdir.apply(fs, arguments) }
fs.unlink = function(p) { checkWrite(p); return orig.unlink.apply(fs, arguments) }
fs.truncate = function(p) { checkWrite(p); return orig.truncate.apply(fs, arguments) }

// Async methods — dual-path
fs.rename = function(a, b) { checkWrite(a); checkWrite(b); return orig.rename.apply(fs, arguments) }
fs.copyFile = function(a, b) { checkWrite(a); checkWrite(b); return orig.copyFile.apply(fs, arguments) }
fs.link = function(a, b) { checkWrite(a); checkWrite(b); return orig.link.apply(fs, arguments) }
fs.symlink = function(a, b) { checkWrite(a); checkWrite(b); return orig.symlink.apply(fs, arguments) }

// fs.promises
if (fs.promises) {
  const origP = {
    writeFile: fs.promises.writeFile,
    appendFile: fs.promises.appendFile,
    mkdir: fs.promises.mkdir,
    rm: fs.promises.rm,
    rmdir: fs.promises.rmdir,
    unlink: fs.promises.unlink,
    rename: fs.promises.rename,
    copyFile: fs.promises.copyFile
  }
  fs.promises.writeFile = function(p) { checkWrite(p); return origP.writeFile.apply(fs.promises, arguments) }
  fs.promises.appendFile = function(p) { checkWrite(p); return origP.appendFile.apply(fs.promises, arguments) }
  fs.promises.mkdir = function(p) { checkWrite(p); return origP.mkdir.apply(fs.promises, arguments) }
  fs.promises.rm = function(p) { checkWrite(p); return origP.rm.apply(fs.promises, arguments) }
  fs.promises.rmdir = function(p) { checkWrite(p); return origP.rmdir.apply(fs.promises, arguments) }
  fs.promises.unlink = function(p) { checkWrite(p); return origP.unlink.apply(fs.promises, arguments) }
  fs.promises.rename = function(a, b) { checkWrite(a); checkWrite(b); return origP.rename.apply(fs.promises, arguments) }
  fs.promises.copyFile = function(a, b) { checkWrite(a); checkWrite(b); return origP.copyFile.apply(fs.promises, arguments) }

  var origReadP = {
    readFile: fs.promises.readFile,
    readdir: fs.promises.readdir,
    open: fs.promises.open,
    stat: fs.promises.stat,
    lstat: fs.promises.lstat,
    access: fs.promises.access
  }
  fs.promises.readFile = function(p) { checkRead(p); return origReadP.readFile.apply(fs.promises, arguments) }
  fs.promises.readdir = function(p) { checkRead(p); return origReadP.readdir.apply(fs.promises, arguments) }
  fs.promises.open = function(p, mode) {
    if (typeof mode === 'string' && /[wax+]/.test(mode)) checkWrite(p)
    else checkRead(p)
    return origReadP.open.apply(fs.promises, arguments)
  }
  fs.promises.stat = function(p) { checkRead(p); return origReadP.stat.apply(fs.promises, arguments) }
  fs.promises.lstat = function(p) { checkRead(p); return origReadP.lstat.apply(fs.promises, arguments) }
  fs.promises.access = function(p) { checkRead(p); return origReadP.access.apply(fs.promises, arguments) }
}

// ── Read methods (sync + async) ──
var origRead = {
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  createReadStream: fs.createReadStream,
  readFile: fs.readFile,
  readdir: fs.readdir,
  openSync: fs.openSync,
  open: fs.open,
  statSync: fs.statSync,
  stat: fs.stat,
  lstatSync: fs.lstatSync,
  lstat: fs.lstat,
  accessSync: fs.accessSync,
  access: fs.access,
  existsSync: fs.existsSync
}

fs.readFileSync = function(p) { checkRead(p); return origRead.readFileSync.apply(fs, arguments) }
fs.readdirSync = function(p) { checkRead(p); return origRead.readdirSync.apply(fs, arguments) }
fs.createReadStream = function(p) { checkRead(p); return origRead.createReadStream.apply(fs, arguments) }
fs.readFile = function(p) { checkRead(p); return origRead.readFile.apply(fs, arguments) }
fs.readdir = function(p) { checkRead(p); return origRead.readdir.apply(fs, arguments) }
fs.openSync = function(p, mode) {
  if (typeof mode === 'string' && /[wax+]/.test(mode)) checkWrite(p)
  else checkRead(p)
  return origRead.openSync.apply(fs, arguments)
}
fs.open = function(p, mode) {
  if (typeof mode === 'string' && /[wax+]/.test(mode)) checkWrite(p)
  else checkRead(p)
  return origRead.open.apply(fs, arguments)
}
fs.statSync = function(p) { checkRead(p); return origRead.statSync.apply(fs, arguments) }
fs.stat = function(p) { checkRead(p); return origRead.stat.apply(fs, arguments) }
fs.lstatSync = function(p) { checkRead(p); return origRead.lstatSync.apply(fs, arguments) }
fs.lstat = function(p) { checkRead(p); return origRead.lstat.apply(fs, arguments) }
fs.accessSync = function(p) { checkRead(p); return origRead.accessSync.apply(fs, arguments) }
fs.access = function(p) { checkRead(p); return origRead.access.apply(fs, arguments) }
fs.existsSync = function(p) { checkRead(p); return origRead.existsSync.apply(fs, arguments) }

// ── child_process proxy via IPC ──
// exec/execSync/spawn/spawnSync/execFile/execFileSync are proxied through IPC
// to the main process, which shows a confirmation dialog before execution.
// fork remains blocked (creates Node.js child processes, not shell commands).
try {
  var cp = require('child_process')
  var crypto = require('crypto')
  var EventEmitter = require('events').EventEmitter
  var IPC_DIR = path.join(WORKSPACE, '.code-exec', 'ipc')

  function _ipcExecuteSync(cmd, timeout) {
    var id = crypto.randomUUID()
    var pendingPath = path.join(IPC_DIR, 'pending-' + id + '.json')
    var resultPath = path.join(IPC_DIR, 'result-' + id + '.json')
    fs.mkdirSync(IPC_DIR, { recursive: true })
    fs.writeFileSync(pendingPath, JSON.stringify({ id: id, cmd: cmd }))
    process.stderr.write('__LUCID_CMD__:' + id + '\\n')

    var deadline = Date.now() + (timeout || 30) * 1000
    while (Date.now() < deadline) {
      if (fs.existsSync(resultPath)) {
        var data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
        try { fs.unlinkSync(resultPath) } catch (e) {}
        try { fs.unlinkSync(pendingPath) } catch (e) {}
        return data
      }
      // Sync sleep 100ms
      try {
        var buf = new Int32Array(new SharedArrayBuffer(4))
        Atomics.wait(buf, 0, 0, 100)
      } catch (e) {
        var start = Date.now()
        while (Date.now() - start < 100) {}
      }
    }
    throw new Error('Shell command timeout: ' + cmd)
  }

  function _ipcExecuteAsync(cmd, callback) {
    var id = crypto.randomUUID()
    var pendingPath = path.join(IPC_DIR, 'pending-' + id + '.json')
    var resultPath = path.join(IPC_DIR, 'result-' + id + '.json')
    fs.mkdirSync(IPC_DIR, { recursive: true })
    fs.writeFileSync(pendingPath, JSON.stringify({ id: id, cmd: cmd }))
    process.stderr.write('__LUCID_CMD__:' + id + '\\n')

    var interval = setInterval(function() {
      if (fs.existsSync(resultPath)) {
        clearInterval(interval)
        var data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
        try { fs.unlinkSync(resultPath) } catch (e) {}
        try { fs.unlinkSync(pendingPath) } catch (e) {}
        if (callback) {
          var err = data.exit_code !== 0 ? new Error('Command failed: ' + cmd) : null
          callback(err, data.output || '', '', data.exit_code || 0)
        }
      }
    }, 100)
  }

  // ── Sync methods ──
  cp.execSync = function(cmd, opts) {
    var data = _ipcExecuteSync(cmd, opts && opts.timeout)
    var output = data.output || ''
    if (opts && (opts.encoding === 'utf-8' || opts.encoding === 'utf8')) {
      return output
    }
    return Buffer.from(output)
  }

  cp.execFileSync = function(cmd, args, opts) {
    var fullCmd = args && args.length ? cmd + ' ' + args.join(' ') : cmd
    var data = _ipcExecuteSync(fullCmd, opts && opts.timeout)
    var output = data.output || ''
    if (opts && (opts.encoding === 'utf-8' || opts.encoding === 'utf8')) {
      return output
    }
    return Buffer.from(output)
  }

  cp.spawnSync = function(cmd, args, opts) {
    var fullCmd = args && args.length ? cmd + ' ' + args.join(' ') : cmd
    var data = _ipcExecuteSync(fullCmd, opts && opts.timeout)
    var output = data.output || ''
    var isUtf8 = opts && (opts.encoding === 'utf-8' || opts.encoding === 'utf8')
    var stdout = isUtf8 ? output : Buffer.from(output)
    var stderr = isUtf8 ? '' : Buffer.alloc(0)
    return {
      status: data.exit_code || 0,
      signal: null,
      output: [null, stdout, stderr],
      pid: -1,
      stdout: stdout,
      stderr: stderr
    }
  }

  // ── Async methods ──
  cp.exec = function(cmd, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = null }
    var fakeProc = new EventEmitter()
    fakeProc.stdout = new EventEmitter()
    fakeProc.stderr = new EventEmitter()
    fakeProc.pid = -1
    fakeProc.kill = function() {}
    _ipcExecuteAsync(cmd, function(err, stdout, stderr, code) {
      if (stdout) fakeProc.stdout.emit('data', Buffer.from(stdout))
      if (stderr) fakeProc.stderr.emit('data', Buffer.from(stderr))
      fakeProc.emit('close', code)
      if (callback) callback(err, stdout, stderr)
    })
    return fakeProc
  }

  cp.spawn = function(cmd, args, opts) {
    var fullCmd = args && args.length ? cmd + ' ' + args.join(' ') : cmd
    var fakeProc = new EventEmitter()
    fakeProc.stdout = new EventEmitter()
    fakeProc.stderr = new EventEmitter()
    fakeProc.pid = -1
    fakeProc.kill = function() {}
    _ipcExecuteAsync(fullCmd, function(err, stdout, stderr, code) {
      if (stdout) fakeProc.stdout.emit('data', Buffer.from(stdout))
      if (stderr) fakeProc.stderr.emit('data', Buffer.from(stderr))
      fakeProc.emit('close', code)
    })
    return fakeProc
  }

  cp.execFile = function(cmd, args, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = null }
    if (typeof args === 'function') { callback = args; args = null; opts = null }
    var fullCmd = args && args.length ? cmd + ' ' + args.join(' ') : cmd
    var fakeProc = new EventEmitter()
    fakeProc.stdout = new EventEmitter()
    fakeProc.stderr = new EventEmitter()
    fakeProc.pid = -1
    fakeProc.kill = function() {}
    _ipcExecuteAsync(fullCmd, function(err, stdout, stderr, code) {
      if (stdout) fakeProc.stdout.emit('data', Buffer.from(stdout))
      if (stderr) fakeProc.stderr.emit('data', Buffer.from(stderr))
      fakeProc.emit('close', code)
      if (callback) callback(err, stdout, stderr)
    })
    return fakeProc
  }

  // fork remains blocked — creates Node.js child processes, not shell commands
  cp.fork = function() {
    var err = new Error(
      'GUARD: 禁止使用 child_process.fork() 派生 Node.js 进程。'
    )
    err.code = 'EBLOCKED'
    throw err
  }
} catch (e) {
  // child_process not available — skip
}
`

// ─────────────────────────────────────────────────────────────
// Python builtins monkey-patch — prepended to user code
// ─────────────────────────────────────────────────────────────
const PYTHON_FS_GUARD = `"""Lucid workspace guard — monkey-patches Python file operations.
Also proxies subprocess calls through IPC for user confirmation."""
import builtins
import os
import os.path
import shutil

WORKSPACE = os.environ.get('LUCID_WORKSPACE_DIR',
                           os.path.join(os.path.expanduser('~'), '.lucid', 'workspace'))

def _resolve(p):
    if isinstance(p, int):
        return None  # fd, not a path
    p = str(p)
    if not p:
        return None
    return os.path.realpath(os.path.abspath(p))

def _check_write(p):
    resolved = _resolve(p)
    if resolved is None:
        return
    rel = os.path.relpath(resolved, WORKSPACE)
    if rel.startswith('..'):
        raise PermissionError(
            'GUARD: 拒绝 workspace 外写操作: ' + str(p) + '\\n'
            '所有文件操作必须在 ~/.lucid/workspace/ 下。'
        )

def _check_read(p):
    resolved = _resolve(p)
    if resolved is None:
        return
    rel = os.path.relpath(resolved, WORKSPACE)
    if rel.startswith('..'):
        raise PermissionError(
            'GUARD: 拒绝 workspace 外读操作: ' + str(p) + '\\n'
            '所有文件操作必须在 ~/.lucid/workspace/ 下。'
        )

_orig_open = builtins.open
def _guarded_open(file, mode='r', *args, **kwargs):
    if isinstance(mode, str) and any(c in mode for c in 'wax+'):
        _check_write(file)
    else:
        _check_read(file)
    return _orig_open(file, mode, *args, **kwargs)
builtins.open = _guarded_open

_orig_makedirs = os.makedirs
def _guarded_makedirs(name, *args, **kwargs):
    _check_write(name)
    return _orig_makedirs(name, *args, **kwargs)
os.makedirs = _guarded_makedirs

_orig_mkdir = os.mkdir
def _guarded_mkdir(path, *args, **kwargs):
    _check_write(path)
    return _orig_mkdir(path, *args, **kwargs)
os.mkdir = _guarded_mkdir

_orig_remove = os.remove
def _guarded_remove(path, *args, **kwargs):
    _check_write(path)
    return _orig_remove(path, *args, **kwargs)
os.remove = _guarded_remove

_orig_rmdir = os.rmdir
def _guarded_rmdir(path, *args, **kwargs):
    _check_write(path)
    return _orig_rmdir(path, *args, **kwargs)
os.rmdir = _guarded_rmdir

_orig_rename = os.rename
def _guarded_rename(src, dst, *args, **kwargs):
    _check_write(src)
    _check_write(dst)
    return _orig_rename(src, dst, *args, **kwargs)
os.rename = _guarded_rename

_orig_replace = os.replace
def _guarded_replace(src, dst, *args, **kwargs):
    _check_write(src)
    _check_write(dst)
    return _orig_replace(src, dst, *args, **kwargs)
os.replace = _guarded_replace

_orig_unlink = os.unlink
def _guarded_unlink(path, *args, **kwargs):
    _check_write(path)
    return _orig_unlink(path, *args, **kwargs)
os.unlink = _guarded_unlink

_orig_copy = shutil.copy
def _guarded_copy(src, dst, *args, **kwargs):
    _check_write(src)
    _check_write(dst)
    return _orig_copy(src, dst, *args, **kwargs)
shutil.copy = _guarded_copy

_orig_copy2 = shutil.copy2
def _guarded_copy2(src, dst, *args, **kwargs):
    _check_write(src)
    _check_write(dst)
    return _orig_copy2(src, dst, *args, **kwargs)
shutil.copy2 = _guarded_copy2

_orig_copyfile = shutil.copyfile
def _guarded_copyfile(src, dst, *args, **kwargs):
    _check_write(src)
    _check_write(dst)
    return _orig_copyfile(src, dst, *args, **kwargs)
shutil.copyfile = _guarded_copyfile

_orig_move = shutil.move
def _guarded_move(src, dst, *args, **kwargs):
    _check_write(src)
    _check_write(dst)
    return _orig_move(src, dst, *args, **kwargs)
shutil.move = _guarded_move

_orig_rmtree = shutil.rmtree
def _guarded_rmtree(path, *args, **kwargs):
    _check_write(path)
    return _orig_rmtree(path, *args, **kwargs)
shutil.rmtree = _guarded_rmtree

# ── Read operations ──
_orig_listdir = os.listdir
def _guarded_listdir(path='.', *args, **kwargs):
    _check_read(path)
    return _orig_listdir(path, *args, **kwargs)
os.listdir = _guarded_listdir

_orig_scandir = os.scandir
def _guarded_scandir(path='.', *args, **kwargs):
    _check_read(path)
    return _orig_scandir(path, *args, **kwargs)
os.scandir = _guarded_scandir

# ── Process spawning ──
# os.system/os.popen/os.exec*/os.spawn* remain blocked (no pipe interface).
# subprocess.Popen is replaced with an IPC proxy that requests user confirmation
# before executing. subprocess.run/call/check_call/check_output use Popen
# internally and are restored to their originals so they work with the proxy.

def _blocked_process(*args, **kwargs):
    raise PermissionError(
        'GUARD: 禁止使用 os 进程操作派生进程。\\n'
        '执行 shell 命令请使用 subprocess 模块。'
    )

os.system = _blocked_process
os.popen = _blocked_process
for _name in ('execl', 'execle', 'execlp', 'execv', 'execve', 'execvp', 'execvpe',
              'spawnl', 'spawnle', 'spawnlp', 'spawnlpe', 'spawnv', 'spawnve',
              'spawnvp', 'spawnvpe'):
    if hasattr(os, _name):
        setattr(os, _name, _blocked_process)

import json as _json
import time as _time
import uuid as _uuid

_IPC_DIR = os.path.join(WORKSPACE, '.code-exec', 'ipc')

def _ipc_execute(cmd, timeout=30):
    cmd_id = str(_uuid.uuid4())
    pending = os.path.join(_IPC_DIR, 'pending-' + cmd_id + '.json')
    result = os.path.join(_IPC_DIR, 'result-' + cmd_id + '.json')
    _orig_makedirs(_IPC_DIR, exist_ok=True)
    with _orig_open(pending, 'w') as f:
        _json.dump({'id': cmd_id, 'cmd': cmd}, f)
    import sys as _sys
    print('__LUCID_CMD__:' + cmd_id, file=_sys.stderr, flush=True)
    deadline = _time.time() + timeout
    while _time.time() < deadline:
        if os.path.exists(result):
            with _orig_open(result) as f:
                data = _json.load(f)
            try: os.unlink(result)
            except: pass
            try: os.unlink(pending)
            except: pass
            return data
        _time.sleep(0.1)
    raise TimeoutError('Shell command timeout: ' + cmd)

class _GuardedPopen:
    '''Proxy Popen — executes shell commands via IPC with user confirmation.'''
    def __init__(self, args, **kwargs):
        if isinstance(args, str):
            cmd = args
        elif isinstance(args, (list, tuple)):
            cmd = ' '.join(str(a) for a in args)
        else:
            cmd = str(args)
        self.args = args
        self._result = _ipc_execute(cmd)
        self.returncode = self._result.get('exit_code', -1)
    def communicate(self, input=None, timeout=None):
        return (self._result.get('output', ''), '')
    def wait(self, timeout=None):
        return self.returncode
    def poll(self):
        return self.returncode
    def kill(self):
        pass
    def terminate(self):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    @property
    def stdout(self):
        return None
    @property
    def stderr(self):
        return None

import subprocess
subprocess.Popen = _GuardedPopen
`

// ─────────────────────────────────────────────────────────────
// Shell function overrides — sourced before user command
// NOTE: avoids ${} syntax to prevent conflict with JS template strings
// ─────────────────────────────────────────────────────────────
const SHELL_GUARD = `#!/bin/bash
# Lucid workspace guard — shell function overrides
# Prevents file operations outside ~/.lucid/workspace/

_ws_check() {
  local target="$1"
  local op="$2"
  local ws
  if [ -n "$LUCID_WORKSPACE_DIR" ]; then
    ws="$LUCID_WORKSPACE_DIR"
  else
    ws="$HOME/.lucid/workspace"
  fi
  local abs

  # Expand ~ prefix (avoid bash var slicing syntax that conflicts with JS templates)
  case "$target" in
    "~")
      abs="$HOME"
      ;;
    "~"/*)
      abs="$HOME/$(printf '%s' "$target" | cut -c3-)"
      ;;
    /*)
      abs="$target"
      ;;
    *)
      abs="$ws/$target"
      ;;
  esac

  # Normalize path (dirname/basename — doesn't require existence)
  local dir base
  dir=$(cd -P "$(dirname "$abs")" 2>/dev/null && pwd) || dir="$(dirname "$abs")"
  base="$(basename "$abs")"
  abs="$dir/$base"

  case "$abs" in
    "$ws"|"$ws"/*)
      return 0
      ;;
    *)
      echo "GUARD: 拒绝 workspace 外$op操作: $target (解析为 $abs)" >&2
      echo "所有文件操作必须在 ~/.lucid/workspace/ 下。" >&2
      return 1
      ;;
  esac
}

_ws_guard_check() {
  _ws_check "$1" "写"
}

_ws_read_check() {
  _ws_check "$1" "读"
}

# Get last positional argument (avoid bash array slicing that conflicts with JS templates)
_ws_last_arg() {
  local last=""
  while [ $# -gt 0 ]; do
    last="$1"
    shift
  done
  printf '%s' "$last"
}

# Check all non-option args (for commands that take multiple paths)
_ws_check_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      -*|"="*) ;;
      *)
        _ws_guard_check "$arg" || return 1
        ;;
    esac
  done
}

# Override write commands
cp() {
  _ws_guard_check "$(_ws_last_arg "$@")" || return 1
  command cp "$@"
}

mv() {
  _ws_guard_check "$(_ws_last_arg "$@")" || return 1
  command mv "$@"
}

mkdir() {
  _ws_check_args "$@" || return 1
  command mkdir "$@"
}

rm() {
  _ws_check_args "$@" || return 1
  command rm "$@"
}

rmdir() {
  _ws_guard_check "$1" || return 1
  command rmdir "$@"
}

tee() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      -*|"-"|"="*) ;;
      *) _ws_guard_check "$arg" || return 1 ;;
    esac
  done
  command tee "$@"
}

dd() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      of=*)
        # Strip "of=" prefix (avoid bash param expansion that conflicts with JS templates)
        _ws_guard_check "$(printf '%s' "$arg" | sed 's/^of=//')" || return 1
        ;;
    esac
  done
  command dd "$@"
}

install() {
  _ws_guard_check "$(_ws_last_arg "$@")" || return 1
  command install "$@"
}

ln() {
  _ws_guard_check "$(_ws_last_arg "$@")" || return 1
  command ln "$@"
}

# ── Read command overrides ──
_ws_read_check_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      -*|"="*) ;;
      *) _ws_read_check "$arg" || return 1 ;;
    esac
  done
}

# grep: skip first non-option arg (the pattern), check the rest as paths
_ws_read_check_skip1() {
  local first=1
  local arg
  for arg in "$@"; do
    case "$arg" in
      -*|"="*) ;;
      *)
        if [ "$first" = "1" ]; then
          first=0
          continue
        fi
        _ws_read_check "$arg" || return 1
        ;;
    esac
  done
}

# find: check only the first non-option arg (the search path)
_ws_read_check_first() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      -*|"="*) ;;
      *)
        _ws_read_check "$arg" || return 1
        break
        ;;
    esac
  done
}

ls() {
  _ws_read_check_args "$@" || return 1
  command ls "$@"
}

cat() {
  _ws_read_check_args "$@" || return 1
  command cat "$@"
}

grep() {
  _ws_read_check_skip1 "$@" || return 1
  command grep "$@"
}

find() {
  _ws_read_check_first "$@" || return 1
  command find "$@"
}

head() {
  _ws_read_check_args "$@" || return 1
  command head "$@"
}

tail() {
  _ws_read_check_args "$@" || return 1
  command tail "$@"
}
`

// ─────────────────────────────────────────────────────────────
// Write guard files to ~/.lucid/workspace/.guard/
// ─────────────────────────────────────────────────────────────
const GUARD_FILES = [
  { path: NODE_GUARD_PATH, content: NODE_FS_GUARD },
  { path: PYTHON_GUARD_PATH, content: PYTHON_FS_GUARD },
  { path: SHELL_GUARD_PATH, content: SHELL_GUARD }
] as const

export function writeGuardFiles(): void {
  mkdirSync(GUARD_DIR, { recursive: true })
  for (const { path: filePath, content } of GUARD_FILES) {
    // Skip if content unchanged — avoids unnecessary writes on every startup
    if (existsSync(filePath)) {
      try {
        if (readFileSync(filePath, 'utf-8') === content) continue
      } catch {
        // fall through to rewrite
      }
    }
    writeFileSync(filePath, content, 'utf-8')
  }
}
