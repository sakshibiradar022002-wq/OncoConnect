// ChemoCure API client — drop-in bridge from localStorage to the secure backend.
// Include this in the HTML apps and replace direct localStorage calls with these.
// All requests send the session cookie automatically (credentials: 'include').

const API = {
  base: '', // same origin

  async _fetch(path, opts = {}) {
    const res = await fetch(this.base + '/api' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },

  // Auth
  register: (body) => API._fetch('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (email, password) => API._fetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  patientLogin: (mrn, password) => API._fetch('/auth/patient-login', { method: 'POST', body: JSON.stringify({ mrn, password }) }),
  me: () => API._fetch('/auth/me'),
  logout: () => API._fetch('/auth/logout', { method: 'POST' }),

  // Patients
  listPatients: () => API._fetch('/patients'),
  createPatient: (record) => API._fetch('/patients', { method: 'POST', body: JSON.stringify({ record }) }),
  getPatient: (id) => API._fetch('/patients/' + id),
  updatePatient: (id, record, changedFields) => API._fetch('/patients/' + id, { method: 'PUT', body: JSON.stringify({ record, changedFields }) }),
  resetPatientPassword: (id) => API._fetch('/patients/' + id + '/reset-password', { method: 'POST' }),
  deletePatient: (id) => API._fetch('/patients/' + id, { method: 'DELETE' }),

  // Labs
  listLabs: () => API._fetch('/labs'),
  createLab: (body) => API._fetch('/labs', { method: 'POST', body: JSON.stringify(body) }),
  assignTask: (body) => API._fetch('/labs/tasks', { method: 'POST', body: JSON.stringify(body) }),
  doctorTasks: () => API._fetch('/labs/tasks'),
  myLabTasks: () => API._fetch('/labs/my-tasks'),
  submitLabResult: (body) => API._fetch('/labs/submit', { method: 'POST', body: JSON.stringify(body) }),
  patientSubmissions: (patientId) => API._fetch('/labs/submissions/' + patientId),

  // Messages (doctor <-> patient). Patient omits patientId (scoped to self).
  sendMessage: (patientId, body) => API._fetch('/clinical/messages', { method: 'POST', body: JSON.stringify({ patientId, body }) }),
  getMessages: (patientId) => API._fetch('/clinical/messages/' + patientId),

  // Appointments
  createAppointment: (body) => API._fetch('/clinical/appointments', { method: 'POST', body: JSON.stringify(body) }),
  getAppointments: (patientId) => API._fetch('/clinical/appointments/' + patientId),
  setAppointmentStatus: (id, status) => API._fetch('/clinical/appointments/' + id + '/status', { method: 'PUT', body: JSON.stringify({ status }) }),

  // Symptom logs (patient writes, doctor views). Patient omits patientId.
  saveSymptomLog: (logDate, data, patientId) => API._fetch('/clinical/symptom-logs', { method: 'POST', body: JSON.stringify({ logDate, data, patientId }) }),
  getSymptomLogs: (patientId, from, to) => API._fetch('/clinical/symptom-logs/' + patientId + (from && to ? `?from=${from}&to=${to}` : '')),
  getSymptomLog: (patientId, date) => API._fetch('/clinical/symptom-logs/' + patientId + '/' + date),
};

window.ChemoCureAPI = API;
