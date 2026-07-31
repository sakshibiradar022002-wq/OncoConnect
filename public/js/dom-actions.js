// Named actions for what used to be inline DOM expressions in markup.
//
// The delegated dispatcher accepts a deliberately small grammar — a function
// call with literal arguments. Anything that walked the DOM, mutated an array,
// or assigned a property directly from an attribute now lives here as a named
// function instead. That is the point rather than a workaround: behaviour in
// markup is untestable, unsearchable, and invisible to the handler gate.
//
// These reference app globals (renderAllergyTags, invTotal, …) at call time,
// never at load time, so load order does not matter.

(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // ── Generic element helpers ─────────────────────────────────────
  window.clickEl = function (id) { var el = $(id); if (el) el.click(); };
  window.removeEl = function (id) { var el = $(id); if (el) el.remove(); };
  window.hideEl = function (id) { var el = $(id); if (el) el.style.display = 'none'; };
  window.showEl = function (id) { var el = $(id); if (el) el.style.display = 'block'; };
  window.clearHTML = function (id) { var el = $(id); if (el) el.innerHTML = ''; };

  window.printPage = function () { window.print(); };
  window.closeWindow = function () { window.close(); };

  // ── Navigation drawer ───────────────────────────────────────────
  window.closeNav = function () { document.body.classList.remove('nav-open'); };
  window.toggleNav = function () { document.body.classList.toggle('nav-open'); };

  // ── Panels / tabs that needed a DOM query to find their button ──
  window.goToPatientsPanel = function () {
    showPanel('patients', document.querySelector('.nav-item:nth-child(2)'));
  };
  window.goToLoginTab = function () {
    switchATab('login', document.querySelector('.ts-btn'));
    return false;
  };
  window.goToClinicPanel = function (btn) {
    showPanel('clinic', btn);
    renderClinic();
  };

  // ── Element-relative actions (receive the clicked element) ──────
  window.removeInvoiceRow = function (el) {
    if (el && el.parentElement) el.parentElement.remove();
    invTotal();
  };
  window.toggleComorbidity = function (el) {
    var input = el && el.querySelector ? el.querySelector('input') : null;
    if (input) input.click();
    updateComorBadge();
  };
  window.expandCollapsed = function (el) {
    if (el && el.parentElement) el.parentElement.classList.remove('collapsed');
    if (el) el.remove();
  };
  window.viewImagingPhotoFrom = function (el) {
    if (el && el.src) viewImagingPhoto(el.src);
  };

  // ── List mutations that were splicing straight from the attribute ──
  window.removeAllergy = function (i) {
    rAllergies.splice(i, 1);
    renderAllergyTags();
  };
  window.removeExtraMed = function (i) {
    extraMeds.splice(i, 1);
    renderExtraMeds();
  };
  // Mirrors the original inline expression exactly: drop the row from the
  // model, remove its <tr> (offset by one for the header), and restate the
  // count. The count is derived here rather than baked into the markup, so it
  // can no longer go stale against the array.
  window.removeParsedReportRow = function (i) {
    parsedReportRows.splice(i, 1);
    parseReport.previewOnly = true;
    var host = $('r-report-preview-rows');
    if (host) {
      var row = host.querySelectorAll('tr')[i + 1];
      if (row) row.remove();
    }
    var count = $('r-report-count');
    if (count) count.textContent = parsedReportRows.length + ' results';
  };

  // ── Record sub-forms ────────────────────────────────────────────
  window.showMDTForm = function () {
    showEl('r-mdt-form');
    var d = $('mdt-date');
    if (d) d.value = new Date().toISOString().slice(0, 10);
  };
  window.hideMDTForm = function () { hideEl('r-mdt-form'); };

  window.showImagingForm = function () {
    showEl('r-imaging-form');
    var d = $('img-date');
    if (d) d.value = new Date().toISOString().slice(0, 10);
  };
  window.hideImagingForm = function () { hideEl('r-imaging-form'); };

  window.closeAddPatientAndOpen = function (mrn) {
    var m = $('add-pat-modal');
    if (m) m.classList.remove('open');
    openRecord(mrn);
  };

  // ── Export panel ────────────────────────────────────────────────
  window.selectAllExports = function () {
    ['exp-demo', 'exp-metrics', 'exp-diag', 'exp-mol', 'exp-labs',
     'exp-meds', 'exp-tx', 'exp-appts', 'exp-imaging', 'exp-logs']
      .forEach(function (id) { var el = $(id); if (el) el.checked = true; });
  };

  // ── Field input behaviours ──────────────────────────────────────
  // `this` is the element the action is declared on (the dispatcher applies it
  // as the receiver), so these read their own value without a DOM lookup.
  window.digitsOnly = function () {
    this.value = this.value.replace(/[^0-9]/g, '');
  };
  window.otpInput = function () {
    this.value = this.value.replace(/[^0-9]/g, '');
    if (this.value.length === 6) verifyAndCreate();
  };
  window.upperCaseInput = function () {
    this.value = this.value.toUpperCase();
  };
  window.regEmailInput = function () {
    clearRegMsg();
    checkEmailExists(this.value);
  };
  window.labTestInput = function () {
    filterLabTests(this.value);
    autoFillRefRange(this.value);
  };
  window.carboInput = function () {
    toggleCarboCalc();
    updateDoseHint();
  };
  window.hideLabTestDropdownSoon = function () {
    setTimeout(function () { hideLabTestDropdown(); }, 180);
  };
  window.focusField = function (id) {
    var el = $(id);
    if (el) el.focus();
  };
  window.addAllergyFromField = function () { rAddAllergy(); };

  // Parsed lab report preview: each cell edits one field of one row.
  window.setParsedReportField = function (i, field) {
    if (parsedReportRows[i]) parsedReportRows[i][field] = this.value;
  };

  // ── Drag and drop upload zones ──────────────────────────────────
  // The visual state is a CSS class now rather than inline style writes.
  window.dragEnterZone = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    this.classList.add('drag');
  };
  window.dragLeaveZone = function () {
    this.classList.remove('drag');
  };
  window.dropOnZone = function (ev, handler) {
    if (ev && ev.preventDefault) ev.preventDefault();
    this.classList.remove('drag');
    var files = ev && ev.dataTransfer ? ev.dataTransfer.files : null;
    if (files && files.length && typeof window[handler] === 'function') window[handler](files);
  };
  window.dropToInput = function (ev, inputId) {
    if (ev && ev.preventDefault) ev.preventDefault();
    this.classList.remove('drag');
    var inp = $(inputId);
    if (inp && ev.dataTransfer && ev.dataTransfer.files.length) {
      inp.files = ev.dataTransfer.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  // ── Lab pending files ───────────────────────────────────────────
  // Was `event.stopPropagation();_viewPendingFile(i,fi)` — the stopPropagation
  // matters because the row behind it is itself clickable.
  window.viewPendingFile = function (i, fi) {
    if (window.event && window.event.stopPropagation) window.event.stopPropagation();
    _viewPendingFile(i, fi);
  };
})();
