'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const express = require('express');

// Each deployed release has immutable assets. Snapshot the HTML and derive
// cache keys from those exact bytes when the process loads the release.
function publicAssets(directory) {
  let html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  for (const [file, placeholder] of [
    ['app.js', 'src="app.js?v=__APP_JS_VERSION__"'],
    ['style.css', 'href="style.css?v=__STYLE_CSS_VERSION__"'],
  ]) {
    if (html.split(placeholder).length !== 2) throw new Error('面板资源版本占位符缺失或重复');
    const digest = createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex');
    html = html.replace(placeholder, placeholder.replace(/__\w+__/, digest));
  }
  const router = express.Router();
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname;
    try { pathname = path.posix.normalize(decodeURIComponent(req.path)); }
    catch { return next(); }
    // Also cover encoded aliases that express.static would otherwise resolve
    // to the unrendered index template.
    if (pathname !== '/' && pathname !== '/index.html') return next();
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  });
  router.use(express.static(directory, { index: false, setHeaders(res, file) {
    if (/\.(?:js|css)$/i.test(file)) res.setHeader('Cache-Control', 'no-cache');
  } }));
  return router;
}

module.exports = { publicAssets };
