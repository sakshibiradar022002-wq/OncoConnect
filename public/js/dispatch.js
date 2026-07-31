// Delegated action dispatcher.
//
// Replaces inline `onclick="fn(a,b)"` with `data-click="fn(a,b)"`, resolved by
// a single delegated listener. Two things this buys:
//
//   1. The CSP can drop 'unsafe-inline' from script-src-attr. Inline event
//      attributes are script, so allowing them weakens XSS defence on a system
//      holding PHI — and it was load-bearing, because every button used them.
//   2. A handler naming something that isn't a function fails LOUDLY here,
//      instead of the browser silently doing nothing. That silence is what let
//      seven dead controls ship.
//
// The attribute value is parsed by a small restricted grammar — never eval,
// never new Function. Anything outside the grammar is rejected and reported:
//
//   statements := statement (';' statement)*
//   statement  := identifier '(' args? ')'
//   args       := arg (',' arg)*
//   arg        := 'string' | "string" | number | true | false | null
//                | this | event
//
// Anything needing more than that — DOM traversal, array mutation, property
// assignment — belongs in a named function, not in markup.

(function () {
  'use strict';

  var ATTR = 'data-click';

  // ── Parser ──────────────────────────────────────────────────────
  // Split on `;` but not inside quotes.
  function splitStatements(src) {
    var out = [], buf = '', quote = null;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (quote) {
        if (c === '\\' && i + 1 < src.length) { buf += c + src[++i]; continue; }
        if (c === quote) quote = null;
        buf += c;
      } else if (c === '"' || c === "'") {
        quote = c; buf += c;
      } else if (c === ';') {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
      } else buf += c;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function splitArgs(src) {
    var out = [], buf = '', quote = null, depth = 0;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (quote) {
        if (c === '\\' && i + 1 < src.length) { buf += c + src[++i]; continue; }
        if (c === quote) quote = null;
        buf += c;
      } else if (c === '"' || c === "'") { quote = c; buf += c; }
      else if (c === '(' || c === '[') { depth++; buf += c; }
      else if (c === ')' || c === ']') { depth--; buf += c; }
      else if (c === ',' && depth === 0) { out.push(buf.trim()); buf = ''; }
      else buf += c;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function parseArg(tok, el, ev) {
    if (tok === 'this') return el;
    if (tok === 'event') return ev;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (tok === 'undefined') return undefined;
    var q = tok[0];
    if ((q === '"' || q === "'") && tok[tok.length - 1] === q) {
      // Unescape the quoting the markup needed, nothing more.
      return tok.slice(1, -1).replace(/\\(['"\\])/g, '$1');
    }
    if (/^-?\d+(\.\d+)?$/.test(tok)) return Number(tok);
    // JSON object/array literals — the patient log cards pass a serialised
    // record straight through. JSON.parse only, never eval, so this stays
    // inside the restricted grammar.
    if ((tok[0] === '{' && tok[tok.length - 1] === '}') ||
        (tok[0] === '[' && tok[tok.length - 1] === ']')) {
      try { return JSON.parse(tok); } catch (err) {
        var pe = new Error('argument is not valid JSON: ' + tok.slice(0, 60));
        pe.__unsupported = true;
        throw pe;
      }
    }
    var e = new Error('unsupported argument: ' + tok);
    e.__unsupported = true;
    throw e;
  }

  function report(msg, el) {
    var where = el ? '<' + el.tagName.toLowerCase() + '> "' +
      (el.textContent || '').trim().slice(0, 40) + '"' : '';
    // Loud on purpose. A dead control must never fail silently again.
    console.error('[dispatch] ' + msg + '  ' + where);
    if (window.__ocDispatchErrors) window.__ocDispatchErrors.push({ msg: msg, where: where });
  }

  function run(src, el, ev) {
    var stmts = splitStatements(src);
    for (var s = 0; s < stmts.length; s++) {
      var stmt = stmts[s];
      if (stmt === 'return false') { ev.preventDefault(); continue; }

      var m = stmt.match(/^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/);
      if (!m) { report('cannot parse action: ' + stmt, el); continue; }

      var name = m[1];
      var fn = window[name];
      if (typeof fn !== 'function') {
        report('action "' + name + '" is not a function on window', el);
        continue;
      }

      var args;
      try {
        args = m[2].trim() ? splitArgs(m[2]).map(function (t) { return parseArg(t, el, ev); }) : [];
      } catch (err) {
        report(err.__unsupported ? err.message + ' in: ' + stmt : String(err), el);
        continue;
      }

      try {
        fn.apply(el, args);
      } catch (err) {
        // Let the handler's own error surface — don't swallow application bugs.
        report('action "' + name + '" threw: ' + (err && err.message), el);
        throw err;
      }
    }
  }

  // ── Delegation ──────────────────────────────────────────────────
  // One listener per event type on the document, so markup rendered at any
  // time works with no rebinding. The nearest ancestor carrying the attribute
  // wins, so a click on an inner span or icon still resolves.
  //
  // Events that bubble are delegated normally. focus/blur do not bubble, so
  // they are delegated in the capture phase, which does reach them.
  var BUBBLING = ['click', 'input', 'change', 'keydown', 'mousedown',
                  'dragover', 'dragleave', 'drop', 'submit'];
  var CAPTURED = ['focus', 'blur'];

  function delegate(type, capture) {
    var attr = 'data-' + type;
    document.addEventListener(type, function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[' + attr + ']') : null;
      if (!el) return;
      var src = el.getAttribute(attr);
      if (src) run(src, el, ev);
    }, !!capture);
  }
  BUBBLING.forEach(function (t) { delegate(t, false); });
  CAPTURED.forEach(function (t) { delegate(t, true); });

  // data-enter="fn()" — the "submit this field on Enter" pattern, declared
  // rather than expressed as an `if` inside an attribute.
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-enter]') : null;
    if (!el) return;
    ev.preventDefault();
    run(el.getAttribute('data-enter'), el, ev);
  });

  // Keyboard parity: an element that acts like a button but isn't one must
  // still be operable without a mouse.
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var el = ev.target && ev.target.closest ? ev.target.closest('[' + ATTR + ']') : null;
    if (!el) return;
    var tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    ev.preventDefault();
    run(el.getAttribute(ATTR), el, ev);
  });

  // Exposed for the CI gate and for tests.
  window.__ocDispatch = { run: run, splitStatements: splitStatements, splitArgs: splitArgs, parseArg: parseArg };
})();
