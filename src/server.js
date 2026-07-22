// OncoConnect secure backend — long-lived server entry point.

import { app } from './app.js';
import { config } from './config.js';
import { startAppointmentReminders } from './push.js';

startAppointmentReminders();

app.listen(config.port, () => {
  console.log(`\n  OncoConnect server running on port ${config.port}`);
  console.log(`  Environment: ${config.isProd ? 'production' : 'development'}`);
  console.log(`  Health: http://localhost:${config.port}/health\n`);
});
