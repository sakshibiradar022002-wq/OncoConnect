// Shared clinical logic — the single definition used by BOTH the doctor and
// patient apps.
//
// These were previously copy-pasted into each app's inline script. The copies
// happened to be identical, but nothing enforced that: change the CTCAE
// thresholds in one app and the doctor and patient would silently disagree
// about how severe a patient's symptoms are, with no test or import to catch
// it. On software where that disagreement reaches a clinician, one definition
// with unit tests is the only defensible arrangement.
//
// Loaded as a classic script so it is available before the apps' inline code
// runs. test/unit.test.js evaluates this exact file, so the tests cover what
// the browser actually receives.

(function (root) {
  'use strict';

  // CTCAE v5 symptom severity, mapped from the 0–10 sliders the patient app
  // presents. Grade 0 none, 1 mild, 2 moderate, 3 severe, 4 very severe.
  function ctcaeGrade(v) {
    v = parseInt(v, 10) || 0;
    return v <= 0 ? 0 : v <= 3 ? 1 : v <= 6 ? 2 : v <= 8 ? 3 : 4;
  }

  var CTCAE_SHORT = ['G0', 'G1', 'G2', 'G3', 'G4'];
  var CTCAE_LABELS = ['G0 · None', 'G1 · Mild', 'G2 · Moderate', 'G3 · Severe', 'G4 · Very severe'];
  // Grade 0 is the muted grey; 1–4 escalate green → amber → red → dark red.
  var CTCAE_COLS = ['#64748b', '#059669', '#d97706', '#dc2626', '#7f1d1d'];

  // Indian rupee formatting, used by billing in the doctor app and invoices in
  // the patient app.
  function money(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN');
  }

  var api = {
    ctcaeGrade: ctcaeGrade,
    CTCAE_SHORT: CTCAE_SHORT,
    CTCAE_LABELS: CTCAE_LABELS,
    CTCAE_COLS: CTCAE_COLS,
    money: money,
  };

  // Browser: expose as globals, matching how the apps already call them.
  for (var k in api) root[k] = api[k];
  // Node (unit tests evaluate this file in a sandbox): hand the API back.
  root.__clinical = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
