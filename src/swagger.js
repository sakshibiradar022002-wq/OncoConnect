import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'OncoConnect API',
      version: '1.0.0',
      description: 'Neuro-oncology EMR system with secure patient records, team collaboration, and lab integration',
      contact: {
        name: 'OncoConnect Support',
        email: 'support@oncoconnect.health'
      },
      license: {
        name: 'DPDP Compliant',
        url: 'https://oncoconnect.health/compliance'
      }
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server'
      },
      {
        url: 'https://api.oncoconnect.health',
        description: 'Production server'
      }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token obtained from /auth/register or /auth/login'
        }
      },
      schemas: {
        Patient: {
          type: 'object',
          properties: {
            mrn: { type: 'string', example: 'TEST001' },
            name: { type: 'string', example: 'John Doe' },
            age: { type: 'integer', example: 45 },
            sex: { type: 'string', enum: ['Male', 'Female', 'Other'] },
            diag: { type: 'string', example: 'Glioblastoma Multiforme' },
            phase: { type: 'string', enum: ['Diagnosis', 'Pre-Treatment', 'Treatment Phase', 'Post-Treatment', 'Monitoring', 'Palliative'] },
            grade: { type: 'string', example: 'Grade IV' },
            createdAt: { type: 'string', format: 'date-time' }
          }
        },
        Doctor: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            name: { type: 'string' },
            specialty: { type: 'string' },
            hospital: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' }
          }
        },
        LabResult: {
          type: 'object',
          properties: {
            date: { type: 'string', format: 'date' },
            test: { type: 'string', example: 'Hemoglobin' },
            value: { type: 'string', example: '13.5' },
            ref: { type: 'string', example: '12-17 g/dL' },
            status: { type: 'string', enum: ['Normal', 'High', 'Low', 'Critical'] }
          }
        },
        KeyValue: {
          type: 'object',
          description: 'Encrypted key-value storage with timestamp',
          properties: {
            v: { type: 'object', description: 'Decrypted value' },
            ts: { type: 'string', format: 'date-time', description: 'Last update timestamp' }
          }
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            role: { type: 'string', enum: ['doctor', 'admin', 'kv-lab'] },
            active: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
            lastLogin: { type: 'string', format: 'date-time' },
            name: { type: 'string' }
          }
        },
        AuditEntry: {
          type: 'object',
          properties: {
            ts: { type: 'string', format: 'date-time' },
            actorId: { type: 'string' },
            actorRole: { type: 'string' },
            action: { type: 'string' },
            targetId: { type: 'string' },
            ip: { type: 'string' },
            detail: { type: 'object' }
          }
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            detail: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' }
          }
        }
      }
    },
    security: [{ BearerAuth: [] }],
    tags: [
      { name: 'Auth', description: 'Authentication & Registration' },
      { name: 'Sync', description: 'Encrypted data synchronization for doctor/patient/lab' },
      { name: 'Team', description: 'Team collaboration & access control' },
      { name: 'Admin', description: 'Administrator controls & audit' },
      { name: 'Push', description: 'Push notification management' },
      { name: 'Email', description: 'Email & OTP services' },
      { name: 'Health', description: 'System health & status' }
    ]
  },
  apis: [
    './src/routes/auth.js',
    './src/routes/sync.js',
    './src/routes/team.js',
    './src/routes/admin.js',
    './src/routes/push.js',
    './src/routes/email.js'
  ]
};

export const swaggerSpec = swaggerJsdoc(options);
