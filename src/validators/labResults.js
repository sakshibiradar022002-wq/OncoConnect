// Lab result validation: physiological ranges and clinical safety checks.
// Prevents invalid values and flags suspicious results.

const PHYSIOLOGICAL_RANGES = {
  // Haematology
  'hemoglobin': { min: 2.0, max: 20.0, unit: 'g/dL', critical: { low: 7.0, high: 18.0 } },
  'haemoglobin': { min: 2.0, max: 20.0, unit: 'g/dL', critical: { low: 7.0, high: 18.0 } },
  'hgb': { min: 2.0, max: 20.0, unit: 'g/dL', critical: { low: 7.0, high: 18.0 } },
  'wbc': { min: 0.5, max: 50.0, unit: '×10³/µL', critical: { low: 1.0, high: 30.0 } },
  'white blood cell count': { min: 0.5, max: 50.0, unit: '×10³/µL', critical: { low: 1.0, high: 30.0 } },
  'platelets': { min: 5.0, max: 1000.0, unit: '×10³/µL', critical: { low: 10.0, high: 500.0 } },
  'platelet': { min: 5.0, max: 1000.0, unit: '×10³/µL', critical: { low: 10.0, high: 500.0 } },
  'hematocrit': { min: 10.0, max: 60.0, unit: '%', critical: { low: 20.0, high: 55.0 } },
  'haematocrit': { min: 10.0, max: 60.0, unit: '%', critical: { low: 20.0, high: 55.0 } },
  'anc': { min: 0.5, max: 30.0, unit: '×10³/µL', critical: { low: 1.0, high: 20.0 } },
  'neutrophils': { min: 0.5, max: 30.0, unit: '×10³/µL', critical: { low: 1.0, high: 20.0 } },
  'lymphocytes': { min: 0.5, max: 30.0, unit: '×10³/µL', critical: { low: 0.8, high: 10.0 } },

  // Liver function
  'alt': { min: 0, max: 500.0, unit: 'U/L', critical: { low: 0, high: 300.0 } },
  'alanine': { min: 0, max: 500.0, unit: 'U/L', critical: { low: 0, high: 300.0 } },
  'ast': { min: 0, max: 500.0, unit: 'U/L', critical: { low: 0, high: 300.0 } },
  'aspartate': { min: 0, max: 500.0, unit: 'U/L', critical: { low: 0, high: 300.0 } },
  'alp': { min: 0, max: 800.0, unit: 'U/L', critical: { low: 0, high: 500.0 } },
  'ggt': { min: 0, max: 500.0, unit: 'U/L', critical: { low: 0, high: 250.0 } },
  'bilirubin': { min: 0, max: 20.0, unit: 'mg/dL', critical: { low: 0, high: 5.0 } },
  'albumin': { min: 0.5, max: 10.0, unit: 'g/dL', critical: { low: 2.0, high: 5.5 } },

  // Renal function
  'creatinine': { min: 0.2, max: 15.0, unit: 'mg/dL', critical: { low: 0.3, high: 8.0 } },
  'bun': { min: 0, max: 100.0, unit: 'mg/dL', critical: { low: 0, high: 50.0 } },
  'egfr': { min: 5.0, max: 120.0, unit: 'mL/min', critical: { low: 10.0, high: 120.0 } },

  // Electrolytes
  'sodium': { min: 100.0, max: 160.0, unit: 'mEq/L', critical: { low: 110.0, high: 150.0 } },
  'na': { min: 100.0, max: 160.0, unit: 'mEq/L', critical: { low: 110.0, high: 150.0 } },
  'potassium': { min: 2.0, max: 8.0, unit: 'mEq/L', critical: { low: 2.5, high: 7.0 } },
  'k': { min: 2.0, max: 8.0, unit: 'mEq/L', critical: { low: 2.5, high: 7.0 } },
  'chloride': { min: 80.0, max: 120.0, unit: 'mEq/L', critical: { low: 85.0, high: 115.0 } },
  'cl': { min: 80.0, max: 120.0, unit: 'mEq/L', critical: { low: 85.0, high: 115.0 } },
  'bicarbonate': { min: 10.0, max: 40.0, unit: 'mEq/L', critical: { low: 15.0, high: 35.0 } },
  'co2': { min: 10.0, max: 40.0, unit: 'mEq/L', critical: { low: 15.0, high: 35.0 } },
  'calcium': { min: 4.0, max: 14.0, unit: 'mg/dL', critical: { low: 6.0, high: 13.0 } },
  'magnesium': { min: 0.5, max: 5.0, unit: 'mg/dL', critical: { low: 1.0, high: 4.0 } },
  'phosphate': { min: 0.5, max: 10.0, unit: 'mg/dL', critical: { low: 1.5, high: 8.0 } },

  // Glucose & metabolic
  'glucose': { min: 20.0, max: 600.0, unit: 'mg/dL', critical: { low: 40.0, high: 500.0 } },
  'fasting': { min: 20.0, max: 600.0, unit: 'mg/dL', critical: { low: 40.0, high: 500.0 } },
  'hba1c': { min: 3.0, max: 15.0, unit: '%', critical: { low: 4.0, high: 14.0 } },

  // Coagulation
  'pt': { min: 5.0, max: 150.0, unit: 'sec', critical: { low: 8.0, high: 100.0 } },
  'appt': { min: 10.0, max: 200.0, unit: 'sec', critical: { low: 15.0, high: 150.0 } },
  'aptt': { min: 10.0, max: 200.0, unit: 'sec', critical: { low: 15.0, high: 150.0 } },
  'inr': { min: 0.5, max: 20.0, unit: '', critical: { low: 0.8, high: 15.0 } },
  'fibrinogen': { min: 50.0, max: 800.0, unit: 'mg/dL', critical: { low: 100.0, high: 600.0 } },

  // Inflammation markers
  'crp': { min: 0, max: 500.0, unit: 'mg/L', critical: { low: 0, high: 100.0 } },
  'esr': { min: 0, max: 150.0, unit: 'mm/hr', critical: { low: 0, high: 100.0 } },
  'ldh': { min: 50.0, max: 2000.0, unit: 'U/L', critical: { low: 100.0, high: 1000.0 } },

  // Iron & vitamins
  'ferritin': { min: 5.0, max: 5000.0, unit: 'ng/mL', critical: { low: 10.0, high: 2000.0 } },
  'vitamin d': { min: 5.0, max: 200.0, unit: 'ng/mL', critical: { low: 10.0, high: 150.0 } },
  'vitamin b12': { min: 50.0, max: 2000.0, unit: 'pg/mL', critical: { low: 100.0, high: 1500.0 } },
  'folate': { min: 1.0, max: 50.0, unit: 'ng/mL', critical: { low: 2.0, high: 40.0 } },
  'iron': { min: 20.0, max: 400.0, unit: 'µg/dL', critical: { low: 40.0, high: 300.0 } },

  // Uric acid
  'uric acid': { min: 1.0, max: 20.0, unit: 'mg/dL', critical: { low: 1.5, high: 15.0 } },
  'urate': { min: 1.0, max: 20.0, unit: 'mg/dL', critical: { low: 1.5, high: 15.0 } },

  // Thyroid
  'tsh': { min: 0.01, max: 100.0, unit: 'mIU/L', critical: { low: 0.05, high: 50.0 } },
  'ft4': { min: 0.1, max: 10.0, unit: 'ng/dL', critical: { low: 0.3, high: 8.0 } },
  't4': { min: 2.0, max: 20.0, unit: 'µg/dL', critical: { low: 3.0, high: 15.0 } },
  'ft3': { min: 1.0, max: 10.0, unit: 'pg/mL', critical: { low: 2.0, high: 8.0 } },

  // Prostate & tumor markers
  'psa': { min: 0, max: 1000.0, unit: 'ng/mL', critical: { low: 0, high: 500.0 } },
  'cea': { min: 0, max: 1000.0, unit: 'ng/mL', critical: { low: 0, high: 500.0 } },
  'afp': { min: 0, max: 10000.0, unit: 'ng/mL', critical: { low: 0, high: 5000.0 } },
};

function normalizeTestName(testName) {
  return testName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function validateLabResult(test, value) {
  if (!test || value === null || value === undefined || value === '') {
    return { valid: false, error: 'Test name and value required' };
  }

  const numVal = parseFloat(value);
  if (isNaN(numVal)) {
    return { valid: false, error: 'Lab value must be numeric' };
  }

  const normalized = normalizeTestName(test);
  const range = Object.entries(PHYSIOLOGICAL_RANGES).find(
    ([key]) => normalizeTestName(key) === normalized
  )?.[1];

  if (!range) {
    return { valid: true, warning: null }; // Unknown test, allow but don't validate
  }

  const { min, max, critical } = range;
  const warnings = [];

  // Absolute bounds check
  if (numVal < min || numVal > max) {
    return {
      valid: false,
      error: `Lab value ${numVal} is outside physiological range (${min}–${max})`,
    };
  }

  // Critical flag (values outside safe treatment range)
  if (critical) {
    if (numVal < critical.low) {
      warnings.push(`⚠️ CRITICAL LOW: ${numVal} is critically low (normal: >${critical.low})`);
    } else if (numVal > critical.high) {
      warnings.push(`⚠️ CRITICAL HIGH: ${numVal} is critically high (normal: <${critical.high})`);
    }
  }

  return {
    valid: true,
    warning: warnings.length > 0 ? warnings.join('; ') : null,
  };
}

export function validateLabSubmission(submission) {
  if (!submission || !Array.isArray(submission.results)) {
    return { valid: true, warnings: [] };
  }

  const warnings = [];
  const errors = [];

  for (const result of submission.results) {
    if (!result.test || result.value === null) continue;

    const validation = validateLabResult(result.test, result.value);
    if (!validation.valid) {
      errors.push(`${result.test}: ${validation.error}`);
    } else if (validation.warning) {
      warnings.push(`${result.test}: ${validation.warning}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
