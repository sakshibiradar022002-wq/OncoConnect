// Unit tests for the security- and safety-critical pure logic.
//
// The e2e suite exercises endpoints; these cover the functions where a subtle
// regression would be dangerous rather than merely broken — patient data
// isolation, PHI encryption, and lab-value validation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.PHI_ENCRYPTION_KEY ||= 'a'.repeat(64);
process.env.JWT_SECRET ||= 'unit-test-secret';

const { patientOwnsKey } = await import('../src/routes/sync.js');
const { encryptPHI, decryptPHI, hashPassword, verifyPassword } = await import('../src/crypto.js');
const { validateLabSubmission } = await import('../src/validators/labResults.js');

// ── Shared clinical logic ─────────────────────────────────────────
// Evaluates public/js/clinical.js exactly as the browser receives it, so these
// cover the shipped file rather than a copy. This logic used to be duplicated
// in both apps with nothing keeping the copies in sync.
const clinical = await (async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const sandbox = {};
  vm.runInNewContext(readFileSync('public/js/clinical.js', 'utf8'), sandbox);
  return sandbox.__clinical;
})();

describe('CTCAE symptom grading', () => {
  test('maps the 0-10 slider onto grades 0-4', () => {
    const cases = [
      [0, 0], [1, 1], [3, 1], [4, 2], [6, 2], [7, 3], [8, 3], [9, 4], [10, 4],
    ];
    for (const [input, grade] of cases) {
      assert.equal(clinical.ctcaeGrade(input), grade, `slider ${input} should be grade ${grade}`);
    }
  });

  test('boundaries sit where CTCAE puts them', () => {
    // The thresholds are the clinically meaningful part: 3|4 separates mild
    // from moderate, 6|7 moderate from severe, 8|9 severe from very severe.
    assert.notEqual(clinical.ctcaeGrade(3), clinical.ctcaeGrade(4));
    assert.notEqual(clinical.ctcaeGrade(6), clinical.ctcaeGrade(7));
    assert.notEqual(clinical.ctcaeGrade(8), clinical.ctcaeGrade(9));
  });

  test('non-numeric and negative input degrade to grade 0, never a crash', () => {
    for (const v of [null, undefined, '', 'abc', NaN, -5]) {
      assert.equal(clinical.ctcaeGrade(v), 0);
    }
  });

  test('string input from a range control is accepted', () => {
    assert.equal(clinical.ctcaeGrade('7'), 3);
  });

  test('every grade has a label and a colour', () => {
    for (const key of ['CTCAE_SHORT', 'CTCAE_LABELS', 'CTCAE_COLS']) {
      assert.equal(clinical[key].length, 5, `${key} must cover grades 0-4`);
    }
    for (let g = 0; g <= 4; g++) {
      assert.match(clinical.CTCAE_COLS[g], /^#[0-9a-f]{6}$/i);
    }
  });
});

describe('currency formatting', () => {
  test('formats in Indian rupees', () => {
    assert.match(clinical.money(1000), /^₹/);
    assert.equal(clinical.money(0), '₹0');
  });
  test('treats missing values as zero rather than NaN', () => {
    for (const v of [null, undefined, '']) assert.equal(clinical.money(v), '₹0');
  });
});

// ── Patient data isolation ────────────────────────────────────────
// This is the boundary that keeps one patient out of another's records.
describe('patientOwnsKey — cross-patient isolation', () => {
  test('accepts each of the patient\'s own key families', () => {
    const own = [
      'pat_MRN001', 'msgs_MRN001', 'appts_MRN001', 'lab_subs_MRN001',
      'pat_tokens_MRN001', 'reminders_MRN001', 'invoices_MRN001',
      'checkin_MRN001', 'travel_MRN001',
      'log_MRN001_2026-07-30', 'medlog_MRN001_2026-07-30',
      'factbr_MRN001', 'alerts_doc42_MRN001',
    ];
    for (const k of own) {
      assert.equal(patientOwnsKey(k, 'MRN001'), true, `${k} should belong to MRN001`);
    }
  });

  test('rejects another patient\'s keys', () => {
    const foreign = [
      'pat_MRN002', 'msgs_MRN002', 'log_MRN002_2026-07-30',
      'alerts_doc42_MRN002', 'factbr_MRN002',
    ];
    for (const k of foreign) {
      assert.equal(patientOwnsKey(k, 'MRN001'), false, `${k} must NOT belong to MRN001`);
    }
  });

  // The reason the check is exact-pattern rather than substring: with
  // includes(), MRN "001" would match "0012" and one patient could write into
  // another's chart. Guard that specific regression.
  test('a shorter MRN does not match a longer one by prefix', () => {
    assert.equal(patientOwnsKey('pat_0012', '001'), false);
    assert.equal(patientOwnsKey('msgs_0012', '001'), false);
    assert.equal(patientOwnsKey('log_0012_2026-07-30', '001'), false);
    assert.equal(patientOwnsKey('alerts_doc1_0012', '001'), false);
  });

  test('rejects other owners\' infrastructure keys', () => {
    for (const k of ['doc_doc42', 'lab_doc42_lab1', 'users', 'clinic_cfg', '']) {
      assert.equal(patientOwnsKey(k, 'MRN001'), false, `${k} must not be patient-writable`);
    }
  });
});

// ── PHI encryption ────────────────────────────────────────────────
describe('PHI encryption', () => {
  test('round-trips objects, strings and numbers', () => {
    for (const v of [{ name: 'Asha Menon', mrn: 'MRN001' }, 'plain text', 42, ['a', 'b']]) {
      assert.deepEqual(decryptPHI(encryptPHI(v)), v);
    }
  });

  test('ciphertext does not leak the plaintext', () => {
    const enc = encryptPHI({ name: 'Asha Menon', diagnosis: 'Glioblastoma' });
    assert.ok(!enc.includes('Asha'), 'name must not appear in ciphertext');
    assert.ok(!enc.includes('Glioblastoma'), 'diagnosis must not appear in ciphertext');
  });

  test('encrypting the same value twice gives different ciphertext', () => {
    // A fresh IV each time — otherwise identical records are correlatable.
    assert.notEqual(encryptPHI('same'), encryptPHI('same'));
  });

  test('tampered ciphertext fails to decrypt rather than returning garbage', () => {
    const enc = encryptPHI({ secret: 'value' });
    const parts = enc.split('.');
    const flipped = parts[3].startsWith('A') ? 'B' + parts[3].slice(1) : 'A' + parts[3].slice(1);
    const tampered = [parts[0], parts[1], parts[2], flipped].join('.');
    assert.notDeepEqual(decryptPHI(tampered), { secret: 'value' });
  });

  test('null and undefined pass through without throwing', () => {
    assert.equal(decryptPHI(null), null);
    assert.equal(decryptPHI(undefined), null);
  });
});

// ── Password hashing ──────────────────────────────────────────────
describe('password hashing', () => {
  test('verifies the correct password and rejects a wrong one', () => {
    const h = hashPassword('CorrectHorse9');
    assert.equal(verifyPassword('CorrectHorse9', h), true);
    assert.equal(verifyPassword('correcthorse9', h), false);
    assert.equal(verifyPassword('', h), false);
  });

  test('never stores the password in the hash', () => {
    assert.ok(!hashPassword('CorrectHorse9').includes('CorrectHorse9'));
  });

  test('two accounts with the same password get different hashes', () => {
    assert.notEqual(hashPassword('SamePass123'), hashPassword('SamePass123'));
  });
});

// ── Lab result validation ─────────────────────────────────────────
describe('lab result validation', () => {
  test('accepts a physiologically normal panel', () => {
    const r = validateLabSubmission({
      results: [
        { test: 'Hemoglobin', value: '13.5' },
        { test: 'Platelets', value: '250' },
      ],
    });
    assert.equal(r.valid, true, r.errors?.join('; '));
  });

  test('rejects a value outside any possible physiological range', () => {
    const r = validateLabSubmission({
      results: [{ test: 'Hemoglobin', value: '999' }],
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.length > 0);
  });

  test('warns on a survivable but critical value without blocking it', () => {
    // Clinically real: severe neutropenia must still be recordable.
    const r = validateLabSubmission({
      results: [{ test: 'ANC', value: '0.6' }],
    });
    assert.equal(r.valid, true, 'a critical-but-real value must not be rejected');
    assert.ok(Array.isArray(r.warnings));
  });

  test('rejects a non-numeric value', () => {
    const r = validateLabSubmission({ results: [{ test: 'Hemoglobin', value: 'abc' }] });
    assert.equal(r.valid, false);
  });

  test('tolerates an unknown test name rather than dropping the result', () => {
    // Not every assay is in the range table; an unrecognised test should pass
    // through instead of blocking a legitimate submission.
    const r = validateLabSubmission({
      results: [{ test: 'Some Novel Biomarker', value: '4.2' }],
    });
    assert.equal(r.valid, true);
  });
});
