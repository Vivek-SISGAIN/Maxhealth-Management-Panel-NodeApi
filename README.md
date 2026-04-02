# MaxHealth Management Panel — Backend API

A Node.js + Express + Prisma REST API for the MaxHealth Management Dashboard. Connects to a shared PostgreSQL database to surface medical cases, underwriting approvals, KPIs, alerts, analytics, and department metrics.

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Project Structure](#project-structure)
3. [Setup & Running](#setup--running)
4. [Environment Variables](#environment-variables)
5. [Base URL & Versioning](#base-url--versioning)
6. [Response Envelope](#response-envelope)
7. [API Reference](#api-reference)
   - [Health](#health)
   - [Overview](#overview)
   - [Medical Cases](#medical-cases)
   - [Tasks](#tasks)
   - [Members](#members)
   - [Approvals](#approvals)
   - [Alerts](#alerts)
   - [Analytics](#analytics)
   - [Performance & KPIs](#performance--kpis)
   - [Departments](#departments)
   - [Chat](#chat)
8. [Database Schema Summary](#database-schema-summary)
9. [Integration Notes](#integration-notes)
10. [Error Codes](#error-codes)

---

## Tech Stack

| Layer     | Technology                          |
|-----------|-------------------------------------|
| Runtime   | Node.js 20+                         |
| Framework | Express 4                           |
| ORM       | Prisma 5 (PostgreSQL)               |
| Messaging | RabbitMQ (amqplib)                  |
| Cache     | Redis (ioredis)                     |
| Logging   | Pino + pino-http                    |

---

## Project Structure

```
src/
  app.js                         # Express app setup
  server.js                      # HTTP server entry point
  lib/
    logger.js                    # Pino logger
    rabbitmq.js                  # RabbitMQ connection helper
  routes/
    health.js                    # /healthz
    index.js                     # Route aggregator
    management/
      index.js                   # Mounts all management routers
      overview.controller.js     # GET /overview, /system-status
      cases.controller.js        # GET /cases, /tasks, /members  ← NEW
      approvals.controller.js    # GET/PATCH /approvals
      alerts.controller.js       # GET/PATCH /alerts
      analytics.controller.js    # GET /analytics/*
      performance.controller.js  # GET /performance, /performance/kpis
      departments.controller.js  # GET /departments
      chat.controller.js         # POST /chat
prisma/
  schema.prisma
  seed.sql
```

---

## Setup & Running

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Generate Prisma client

```bash
npm run prisma:generate
```

### 4. Push schema to DB (dev)

```bash
npm run db:push
```

### 5. Seed initial data

```bash
psql $DATABASE_URL -f prisma/seed.sql
```

### 6. Start

```bash
# Development (hot reload)
npm run dev

# Production
npm start
```

### Docker Compose

```bash
docker-compose up --build
```

---

## Environment Variables

| Variable            | Required | Default              | Description                                     |
|---------------------|----------|----------------------|-------------------------------------------------|
| `DATABASE_URL`      | ✅       | —                    | PostgreSQL connection string                    |
| `PORT`              | ❌       | `3000`               | HTTP port                                       |
| `NODE_ENV`          | ❌       | `development`        | `development` or `production`                   |
| `RABBITMQ_URL`      | ❌       | `amqp://localhost`   | RabbitMQ connection string                      |
| `REDIS_URL`         | ❌       | `redis://localhost`  | Redis connection string                         |
| `MEDICAL_API_BASE_URL` | ❌    | `http://localhost:2808` | Base URL of the Medical Panel API            |

---

## Base URL & Versioning

All endpoints are prefixed with `/management`:

```
http://localhost:3000/management/<endpoint>
```

---

## Response Envelope

Every response wraps data in a consistent envelope:

```jsonc
// Success
{
  "success": true,
  "data": { ... }          // single object
}

// Success — list
{
  "success": true,
  "items": [ ... ],        // array name varies per endpoint (see docs below)
  "meta": {
    "total": 120,
    "page": 1,
    "limit": 20,
    "totalPages": 6
  }
}

// Error
{
  "success": false,
  "message": "Human-readable error message"
}
```

---

## API Reference

### Health

#### `GET /healthz`

Lightweight liveness probe.

**Response**
```json
{ "status": "ok" }
```

---

#### `GET /health`

Full health with service name.

**Response**
```json
{
  "status": "ok",
  "service": "Management Panel API",
  "timestamp": "2026-04-01T12:00:00.000Z"
}
```

---

### Overview

#### `GET /management/overview`

Dashboard summary: latest KPIs, pending approvals, active alerts, department status, and aggregate counts including **medical case stats**.

**Response**
```jsonc
{
  "success": true,
  "data": {
    "kpis": [
      {
        "id": "uuid",
        "name": "Total Revenue",
        "value": "AED 4.2M",
        "change": "+12.5%",
        "trend": "up",
        "period": "vs last month",
        "category": "financial",
        "department": null
      }
    ],
    "pendingApprovals": [ /* ManagementApproval objects, max 10 */ ],
    "activeAlerts": [ /* ManagementAlert objects, max 5 */ ],
    "departmentStatus": [
      {
        "department": "Sales & Marketing",
        "status": "Excellent",
        "performance": 94,
        "alerts": 0
      }
    ],
    "stats": {
      "approvals": {
        "total": 45,
        "pending": 12,
        "approved": 28,
        "rejected": 5
      },
      "alerts": {
        "total": 18,
        "active": 6,
        "acknowledged": 8,
        "resolved": 4
      },
      "medicalCases": {
        "total": 320,
        "new": 45,
        "inReview": 80,
        "completed": 190,
        "slaBreached": 7
      }
    }
  }
}
```

---

#### `GET /management/system-status`

Returns static infrastructure status.

**Response**
```json
{
  "success": true,
  "data": [
    { "system": "PostgreSQL Database", "status": "operational", "uptime": "99.8%", "lastUpdate": "..." },
    { "system": "Redis Cache", "status": "operational", "uptime": "99.9%", "lastUpdate": "..." },
    { "system": "RabbitMQ", "status": "operational", "uptime": "99.5%", "lastUpdate": "..." },
    { "system": "API Server", "status": "operational", "uptime": "100%", "lastUpdate": "..." }
  ]
}
```

---

### Medical Cases

These endpoints expose `UnderwritingCase` records sent by the Medical Panel.

#### `GET /management/cases`

List all medical underwriting cases.

**Query Parameters**

| Param       | Type   | Description                                               |
|-------------|--------|-----------------------------------------------------------|
| `status`    | string | Filter by status: `NEW`, `IN_REVIEW`, `COMPLETED`, `ON_HOLD` |
| `result`    | string | Filter by result: `APPROVED`, `CONDITIONAL`, `REJECTED`   |
| `policyType`| string | Filter by policy type                                     |
| `broker`    | string | Partial match on broker name                              |
| `search`    | string | Search across `caseId`, `client`, `broker`                |
| `page`      | number | Page number (default: `1`)                                |
| `limit`     | number | Items per page (default: `20`, max: `100`)                |

**Response**
```jsonc
{
  "success": true,
  "cases": [
    {
      "id": "CASE-001",
      "caseId": "UW-2026-001",
      "client": "Al Fardan Group",
      "broker": "Marsh UAE",
      "policyType": "Group Medical",
      "memberCount": 250,
      "riskScore": 72.5,
      "status": "IN_REVIEW",
      "result": null,
      "assignedDoctor": "dr.ahmed",
      "notes": "High-risk group, review pending",
      "completedAt": null,
      "createdAt": "2026-03-01T09:00:00.000Z",
      "updatedAt": "2026-03-15T14:30:00.000Z"
    }
  ],
  "meta": { "total": 120, "page": 1, "limit": 20, "totalPages": 6 }
}
```

---

#### `GET /management/cases/stats`

Aggregated case statistics.

**Response**
```jsonc
{
  "success": true,
  "stats": {
    "total": 320,
    "byStatus": {
      "new": 45,
      "inReview": 80,
      "completed": 190,
      "onHold": 5
    },
    "byResult": {
      "approved": 150,
      "rejected": 20,
      "conditional": 20
    },
    "totalMembers": 4800,
    "slaBreached": 7
  }
}
```

---

#### `GET /management/cases/:id`

Full case detail including members, linked task, and doctor workbench summary.

**Path Parameters**

| Param | Type   | Description              |
|-------|--------|--------------------------|
| `id`  | string | UnderwritingCase `Id`    |

**Response**
```jsonc
{
  "success": true,
  "data": {
    "id": "CASE-001",
    "caseId": "UW-2026-001",
    "client": "Al Fardan Group",
    "broker": "Marsh UAE",
    "policyType": "Group Medical",
    "memberCount": 2,
    "riskScore": 72.5,
    "status": "IN_REVIEW",
    "result": null,
    "assignedDoctor": "dr.ahmed",
    "notes": null,
    "completedAt": null,
    "createdAt": "2026-03-01T09:00:00.000Z",
    "updatedAt": "2026-03-15T14:30:00.000Z",
    "members": [
      {
        "id": "MBR-001",
        "caseId": "CASE-001",
        "memberId": "M-001",
        "name": "John Doe",
        "age": 35,
        "gender": "Male",
        "planCategory": "Gold"
      }
    ],
    "task": {
      "id": "TASK-001",
      "taskType": "UNDERWRITING",
      "caseId": "CASE-001",
      "priority": "HIGH",
      "status": "IN_PROGRESS",
      "slaDeadline": "2026-03-20T18:00:00.000Z",
      "slaBreach": false,
      "createdAt": "2026-03-01T09:00:00.000Z",
      "updatedAt": "2026-03-15T14:30:00.000Z"
    },
    "workbench": {
      "members": {
        "MBR-001": {
          "stage": "SENT_FOR_MANAGEMENT_APPROVAL",
          "riskLevel": "high",
          "summary": { "adjustedPremium": 150000 }
        }
      }
    }
  }
}
```

---

#### `GET /management/cases/:id/members`

All underwriting members for a case.

**Response**
```jsonc
{
  "success": true,
  "data": [
    {
      "id": "MBR-001",
      "caseId": "CASE-001",
      "memberId": "M-001",
      "name": "John Doe",
      "age": 35,
      "gender": "Male",
      "planCategory": "Gold"
    }
  ]
}
```

---

#### `GET /management/cases/:id/workbench`

Member-level doctor workbench data extracted from the task metadata.

**Response**
```jsonc
{
  "success": true,
  "data": {
    "taskId": "TASK-001",
    "caseId": "CASE-001",
    "members": [
      {
        "memberId": "MBR-001",
        "memberName": "John Doe",
        "stage": "SENT_FOR_MANAGEMENT_APPROVAL",
        "stageUpdatedAt": "2026-03-14T10:00:00.000Z",
        "stageHistory": [
          { "stage": "SENT_FOR_MANAGEMENT_APPROVAL", "at": "2026-03-14T10:00:00.000Z", "by": "dr.ahmed", "notes": null }
        ],
        "riskLevel": "high",
        "summary": {
          "annualPremium": 120000,
          "medicalServicesCharges": 15000,
          "complicationPercent": 10,
          "complicationAmount": 12000,
          "totalLoad": 27000,
          "adjustedPremium": 147000
        },
        "clinicalRemarks": "Pre-existing hypertension, controlled.",
        "underwritingRemarks": "Loading applied at 10%.",
        "managementDecision": null,
        "documents": [
          { "url": "s3://bucket/doc.pdf", "name": "Medical Report", "uploadedAt": "2026-03-10T08:00:00.000Z" }
        ]
      }
    ]
  }
}
```

---

#### `GET /management/cases/:id/timeline`

Full chronological audit trail of stage transitions across all members.

**Response**
```jsonc
{
  "success": true,
  "data": [
    {
      "memberId": "MBR-001",
      "memberName": "John Doe",
      "stage": "SENT_FOR_MANAGEMENT_APPROVAL",
      "at": "2026-03-14T10:00:00.000Z",
      "by": "dr.ahmed",
      "notes": null
    }
  ]
}
```

---

### Tasks

#### `GET /management/tasks`

List all `MedicalTask` records.

**Query Parameters**

| Param       | Type    | Description                                                          |
|-------------|---------|----------------------------------------------------------------------|
| `taskType`  | string  | `PREAUTH`, `UNDERWRITING`, `RENEWAL`, `LOADING`, `LATE_ADDITION`    |
| `status`    | string  | `PENDING`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `SLA_BREACH`    |
| `priority`  | string  | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`                                  |
| `caseId`    | string  | Filter by linked case                                                |
| `assignedTo`| string  | Filter by assignee username                                          |
| `slaBreach` | boolean | `true` / `false`                                                     |
| `page`      | number  | Default: `1`                                                         |
| `limit`     | number  | Default: `20`, max: `100`                                            |

**Response**
```jsonc
{
  "success": true,
  "tasks": [
    {
      "id": "TASK-001",
      "taskType": "UNDERWRITING",
      "caseId": "CASE-001",
      "policyId": null,
      "assignedTo": "dr.ahmed",
      "priority": "HIGH",
      "status": "IN_PROGRESS",
      "slaDeadline": "2026-03-20T18:00:00.000Z",
      "slaBreach": false,
      "metadata": { "doctorWorkbench": { "members": {} } },
      "createdAt": "2026-03-01T09:00:00.000Z",
      "updatedAt": "2026-03-15T14:30:00.000Z",
      "completedAt": null
    }
  ],
  "meta": { "total": 50, "page": 1, "limit": 20, "totalPages": 3 }
}
```

---

#### `GET /management/tasks/stats`

Task aggregate statistics.

**Response**
```jsonc
{
  "success": true,
  "stats": {
    "total": 50,
    "byStatus": {
      "pending": 10,
      "inProgress": 20,
      "completed": 18,
      "cancelled": 2
    },
    "slaBreach": 7,
    "byType": {
      "PREAUTH": 5,
      "UNDERWRITING": 30,
      "RENEWAL": 8,
      "LOADING": 4,
      "LATE_ADDITION": 3
    }
  }
}
```

---

#### `GET /management/tasks/:id`

Single task by ID.

**Response**
```jsonc
{
  "success": true,
  "data": { /* full task object as above */ }
}
```

---

### Members

#### `GET /management/members`

List underwriting members.

**Query Parameters**

| Param         | Type   | Description                    |
|---------------|--------|--------------------------------|
| `caseId`      | string | Filter by case                 |
| `gender`      | string | `Male`, `Female`               |
| `planCategory`| string | e.g. `Gold`, `Silver`, `Basic` |
| `page`        | number | Default: `1`                   |
| `limit`       | number | Default: `20`, max: `100`      |

**Response**
```jsonc
{
  "success": true,
  "members": [
    {
      "id": "MBR-001",
      "caseId": "CASE-001",
      "memberId": "M-001",
      "name": "John Doe",
      "age": 35,
      "gender": "Male",
      "planCategory": "Gold"
    }
  ],
  "meta": { "total": 4800, "page": 1, "limit": 20, "totalPages": 240 }
}
```

---

#### `GET /management/members/:id`

Single member with workbench snapshot.

**Response**
```jsonc
{
  "success": true,
  "data": {
    "id": "MBR-001",
    "caseId": "CASE-001",
    "memberId": "M-001",
    "name": "John Doe",
    "age": 35,
    "gender": "Male",
    "planCategory": "Gold",
    "workbench": {
      "stage": "SENT_FOR_MANAGEMENT_APPROVAL",
      "riskLevel": "high",
      "summary": { "adjustedPremium": 147000 },
      "managementDecision": null
    }
  }
}
```

---

### Approvals

> **Source modes:** The approvals endpoints support two data sources controlled by the `source` query param.
> - `source=medical` *(default)*: reads from `MedicalTask` workbench (live medical flow)
> - `source=legacy`: reads from `ManagementApproval` table (legacy approvals)

---

#### `GET /management/approvals`

**Query Parameters**

| Param        | Type   | Default    | Description                                             |
|--------------|--------|------------|---------------------------------------------------------|
| `status`     | string | `pending`  | `pending`, `approved`, `rejected`, `all`                |
| `priority`   | string | —          | `low`, `medium`, `high`, `urgent`                       |
| `department` | string | —          | Department name filter                                  |
| `search`     | string | —          | Search across code, description, member name            |
| `source`     | string | `medical`  | `medical` or `legacy`                                   |
| `page`       | number | `1`        |                                                         |
| `limit`      | number | `20`       | Max: `100`                                              |

**Response (medical source)**
```jsonc
{
  "success": true,
  "approvals": [
    {
      "id": "TASK-001:MBR-001",
      "approvalCode": "UW-2026-001",
      "referenceId": "CASE-001",
      "type": "Medical Underwriting Approval",
      "department": "Medical Underwriting",
      "requestor": "dr.ahmed",
      "requestorId": "dr.ahmed",
      "description": "Underwriting decision required for John Doe",
      "details": "Pre-existing hypertension, controlled.",
      "amount": "AED 147,000",
      "priority": "high",
      "status": "pending",
      "dueDate": "3/20/2026",
      "submittedDate": "2026-03-14T10:00:00.000Z",
      "decidedBy": null,
      "decidedAt": null,
      "rejectionNotes": null,
      "icon": "Shield",
      "source": "medical_workbench",
      "taskId": "TASK-001",
      "caseId": "CASE-001",
      "memberId": "MBR-001",
      "memberName": "John Doe",
      "workbenchStage": "SENT_FOR_MANAGEMENT_APPROVAL",
      "summary": {
        "annualPremium": 120000,
        "medicalServicesCharges": 15000,
        "complicationPercent": 10,
        "complicationAmount": 12000,
        "totalLoad": 27000,
        "adjustedPremium": 147000
      }
    }
  ],
  "meta": { "total": 15, "page": 1, "limit": 20, "totalPages": 1 }
}
```

---

#### `GET /management/approvals/stats`

**Response**
```jsonc
{
  "success": true,
  "totalPending": 15,
  "totalApproved": 40,
  "totalRejected": 5,
  "urgentRequests": 3,
  "todayApprovals": 2,
  "avgProcessingTime": "2.5 days",
  "departmentStats": [
    {
      "department": "Medical Underwriting",
      "pending": 15,
      "approved": 40,
      "rejected": 5,
      "avgTime": "2.5 days"
    }
  ]
}
```

---

#### `GET /management/approvals/:id`

Single approval detail.

- Medical: `:id` is `taskId:memberId` e.g. `TASK-001:MBR-001`
- Legacy: `:id` is the UUID from `ManagementApproval`

**Query Parameters**

| Param   | Type   | Default   | Description          |
|---------|--------|-----------|----------------------|
| `source`| string | `medical` | `medical` or `legacy`|

**Response (medical)**
```jsonc
{
  "success": true,
  "data": {
    /* approval object as above */,
    "workbench": {
      "stage": "SENT_FOR_MANAGEMENT_APPROVAL",
      "stageUpdatedAt": "2026-03-14T10:00:00.000Z",
      "stageHistory": [ /* ... */ ],
      "messages": [ /* ... */ ],
      "riskLevel": "high",
      "clinicalRemarks": "Pre-existing hypertension.",
      "underwritingRemarks": "Loading at 10%.",
      "summary": { /* premium breakdown */ },
      "chargesBreakdown": null,
      "documents": [ /* ... */ ],
      "formSnapshot": { "memberName": "John Doe", "age": 35 },
      "managementDecision": null
    }
  }
}
```

---

#### `PATCH /management/approvals/:id/approve`

Approve a medical underwriting decision for a member. `:id` = `taskId:memberId`.

**Request Body**
```jsonc
{
  "decidedBy": "ceo@maxhealth.com",  // optional, defaults to "management"
  "notes": "Approved with standard loading."  // optional
}
```

**Response**
```jsonc
{
  "success": true,
  "data": { /* updated approval object */ }
}
```

---

#### `PATCH /management/approvals/:id/reject`

Reject a medical underwriting decision. `:id` = `taskId:memberId`.

**Request Body**
```jsonc
{
  "decidedBy": "ceo@maxhealth.com",
  "notes": "Risk too high for current product offering."
}
```

**Response**
```jsonc
{
  "success": true,
  "data": { /* updated approval object */ }
}
```

---

#### `POST /management/approvals`

Create a legacy approval entry.

**Request Body**
```jsonc
{
  "type": "Budget Approval",
  "department": "Finance & Accounting",
  "requestor": "John Smith",
  "requestorId": "john.smith",
  "description": "Q2 IT Infrastructure Budget",
  "details": "Servers, cloud costs, licences",
  "amount": "AED 250,000",
  "priority": "high",
  "dueDate": "2026-04-30",
  "metadata": {}
}
```

**Response**
```jsonc
{
  "success": true,
  "data": {
    "id": "uuid",
    "approvalCode": "APV-012",
    "type": "Budget Approval",
    "status": "pending",
    /* ... */
  }
}
```

---

#### `GET /management/approvals/document-access`

Proxy to the Medical Panel API to generate a signed document URL.

**Query Parameters**

| Param | Type   | Required | Description               |
|-------|--------|----------|---------------------------|
| `url` | string | ✅       | The raw S3 / storage URL  |

**Response**
```jsonc
{
  "success": true,
  "accessUrl": "https://signed.url.example.com/doc.pdf?token=..."
}
```

---

### Alerts

#### `GET /management/alerts`

**Query Parameters**

| Param        | Type   | Description                                    |
|--------------|--------|------------------------------------------------|
| `status`     | string | `active`, `acknowledged`, `resolved`           |
| `severity`   | string | `low`, `medium`, `high`, `critical`            |
| `department` | string | Department name                                |
| `page`       | number | Default: `1`                                   |
| `limit`      | number | Default: `20`, max: `100`                      |

**Response**
```jsonc
{
  "success": true,
  "alerts": [
    {
      "id": "uuid",
      "type": "SLA_BREACH",
      "title": "SLA Deadline Approaching",
      "message": "3 underwriting tasks are approaching their SLA deadline.",
      "department": "Medical Underwriting",
      "severity": "high",
      "status": "active",
      "actionRequired": true,
      "source": "medical_workbench",
      "metadata": null,
      "expiresAt": null,
      "acknowledgedBy": null,
      "acknowledgedAt": null,
      "resolvedBy": null,
      "resolvedAt": null,
      "createdAt": "2026-03-15T09:00:00.000Z",
      "timestamp": "3/15/2026, 9:00:00 AM"
    }
  ],
  "meta": { "total": 18, "page": 1, "limit": 20, "totalPages": 1 }
}
```

---

#### `GET /management/alerts/stats`

**Response**
```jsonc
{
  "success": true,
  "activeCount": 6,
  "criticalCount": 2,
  "systemStatus": {
    "overall": "degraded",
    "uptime": "99.98%",
    "apiStatus": { "status": "operational", "latency": "45ms" },
    "databaseStatus": { "status": "operational", "connections": 45 },
    "serverStatus": { "status": "operational", "cpu": "67%" },
    "networkStatus": { "status": "operational", "latency": "12ms" }
  }
}
```

---

#### `GET /management/alerts/:id`

**Response**
```jsonc
{
  "success": true,
  "data": { /* alert object */ }
}
```

---

#### `POST /management/alerts`

Create an alert.

**Request Body**
```jsonc
{
  "type": "SYSTEM_WARNING",
  "title": "High Memory Usage",
  "message": "Server memory usage exceeded 90%.",
  "department": "Operations",
  "severity": "high",
  "source": "monitoring",
  "metadata": { "server": "app-01", "memoryUsage": "92%" },
  "expiresAt": "2026-04-02T00:00:00.000Z"   // optional
}
```

**Response**
```jsonc
{
  "success": true,
  "data": { /* created alert */ }
}
```

---

#### `PATCH /management/alerts/:id/acknowledge`

**Request Body**
```jsonc
{
  "acknowledgedBy": "ops.team@maxhealth.com"
}
```

**Response**
```jsonc
{
  "success": true,
  "data": { /* updated alert with status: "acknowledged" */ }
}
```

---

#### `PATCH /management/alerts/:id/resolve`

**Request Body**
```jsonc
{
  "resolvedBy": "ops.team@maxhealth.com"
}
```

**Response**
```jsonc
{
  "success": true,
  "data": { /* updated alert with status: "resolved" */ }
}
```

---

### Analytics

#### `GET /management/analytics`

**Query Parameters**

| Param    | Type   | Default    | Description                                         |
|----------|--------|------------|-----------------------------------------------------|
| `period` | string | `monthly`  | `daily`, `weekly`, `monthly`, `quarterly`, `yearly` |
| `type`   | string | —          | `revenue`, `performance`, `distribution`, `trends`  |

**Response**
```jsonc
{
  "success": true,
  "data": {
    "period": "monthly",
    "revenue": [ /* snapshot objects */ ],
    "performance": [ /* snapshot objects */ ],
    "distribution": [ /* snapshot objects */ ],
    "trends": [ /* snapshot objects */ ]
  }
}
```

Each snapshot object:
```jsonc
{
  "id": "uuid",
  "period": "monthly",
  "type": "revenue",
  "data": { /* arbitrary JSON payload */ },
  "recordedAt": "2026-03-01T00:00:00.000Z"
}
```

---

#### `GET /management/analytics/revenue`
#### `GET /management/analytics/performance`
#### `GET /management/analytics/distribution`
#### `GET /management/analytics/trends`

Convenience endpoints for specific analytics types. All accept `period` query param.

---

#### `POST /management/analytics/snapshot`

Ingest a new analytics snapshot (called by Medical or other service integrations).

**Request Body**
```jsonc
{
  "period": "monthly",
  "type": "revenue",
  "data": {
    "labels": ["Jan", "Feb", "Mar"],
    "values": [1200000, 1350000, 1420000]
  }
}
```

**Response**
```jsonc
{
  "success": true,
  "data": { /* created snapshot */ }
}
```

---

### Performance & KPIs

#### `GET /management/performance`

Full performance view: latest KPIs, quarterly snapshots, and competitive analysis.

**Response**
```jsonc
{
  "success": true,
  "data": {
    "kpis": [
      {
        "id": "uuid",
        "name": "Policy Sales",
        "value": "85%",
        "change": "+5%",
        "trend": "up",
        "period": "vs last month",
        "category": "sales",
        "department": "Sales & Marketing"
      }
    ],
    "quarterly": [
      {
        "id": "uuid",
        "period": "Q1-2026",
        "data": { /* JSON payload */ },
        "recordedAt": "2026-01-01T00:00:00.000Z"
      }
    ],
    "competitive": { /* JSON payload or null */ }
  }
}
```

---

#### `GET /management/performance/kpis`

Latest value for each KPI name.

**Response**
```jsonc
{
  "success": true,
  "data": [ /* array of KPI objects */ ]
}
```

---

#### `POST /management/performance/kpis`

Ingest KPI data (bulk or single).

**Request Body** (array or single object)
```jsonc
[
  {
    "name": "Total Revenue",
    "value": "AED 4.5M",
    "change": "+7.2%",
    "trend": "up",
    "period": "vs last month",
    "category": "financial",
    "department": null
  }
]
```

**Response**
```jsonc
{
  "success": true,
  "data": { "count": 1 }
}
```

---

### Departments

#### `GET /management/departments`

All department metrics grouped by department name, showing latest value per metric key.

**Query Parameters**

| Param        | Type   | Description              |
|--------------|--------|--------------------------|
| `department` | string | Filter to a single dept  |

**Response**
```jsonc
{
  "success": true,
  "data": [
    {
      "name": "Sales & Marketing",
      "metrics": {
        "headcount": "42",
        "revenue": "AED 1.8M",
        "targetAchievement": "94%"
      }
    }
  ]
}
```

---

#### `GET /management/departments/:name/metrics`

Full metric history for a department.

**Response**
```jsonc
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "departmentName": "Sales & Marketing",
      "metricKey": "headcount",
      "metricValue": "42",
      "recordedAt": "2026-03-01T00:00:00.000Z",
      "createdAt": "2026-03-01T00:00:00.000Z"
    }
  ]
}
```

---

#### `POST /management/departments/metrics`

Ingest department metrics (bulk or single).

**Request Body**
```jsonc
[
  {
    "departmentName": "Operations",
    "metricKey": "claimsProcessed",
    "metricValue": "1240"
  }
]
```

**Response**
```jsonc
{ "success": true, "data": [ /* echo of input */ ] }
```

---

### Chat

#### `POST /management/chat`

Send a message and receive an AI response.

**Request Body**
```jsonc
{
  "message": "What is the current revenue status?",
  "sessionId": "session-abc-123",
  "userId": "manager@maxhealth.com"
}
```

**Response**
```jsonc
{
  "success": true,
  "data": {
    "userMessage": {
      "id": "uuid",
      "sessionId": "session-abc-123",
      "userId": "manager@maxhealth.com",
      "role": "user",
      "content": "What is the current revenue status?",
      "createdAt": "2026-04-01T12:00:00.000Z"
    },
    "aiResponse": {
      "id": "uuid",
      "sessionId": "session-abc-123",
      "userId": "manager@maxhealth.com",
      "role": "assistant",
      "content": "Based on the current dashboard data, revenue is trending upward at +12.5% compared to last month.",
      "createdAt": "2026-04-01T12:00:00.001Z"
    }
  }
}
```

---

#### `GET /management/chat/:sessionId/history`

Retrieve conversation history for a session.

**Response**
```jsonc
{
  "success": true,
  "data": [
    { "id": "uuid", "sessionId": "session-abc-123", "role": "user", "content": "...", "createdAt": "..." },
    { "id": "uuid", "sessionId": "session-abc-123", "role": "assistant", "content": "...", "createdAt": "..." }
  ]
}
```

---

## Database Schema Summary

| Table                          | Owned By       | Description                                           |
|-------------------------------|----------------|-------------------------------------------------------|
| `ManagementKPI`               | Management     | KPI metrics (revenue, sales targets, etc.)            |
| `ManagementDepartmentMetric`  | Management     | Per-department metric key-value store                 |
| `ManagementAnalyticsSnapshot` | Management     | Periodic analytics blobs (revenue, trends, etc.)      |
| `ManagementAlert`             | Management     | System and operational alerts                         |
| `ManagementApproval`          | Management     | Legacy approval requests                              |
| `ManagementChatMessage`       | Management     | Chat history per session                              |
| `MedicalTask`                 | **Medical** (shared read/write) | Tasks from the medical workbench. Metadata contains `doctorWorkbench.members[memberId]` per-member workbench state |
| `UnderwritingCase`            | **Medical** (shared read) | Underwriting case records from medical               |
| `UnderwritingMember`          | **Medical** (shared read) | Member records linked to cases                        |

---

## Integration Notes

### Medical Panel → Management Panel flow

1. Medical Panel creates a `MedicalTask` with `TaskType = UNDERWRITING`.
2. For each member, it writes into `Metadata.doctorWorkbench.members[memberId]`.
3. When ready for management review, it sets `members[memberId].stage = "SENT_FOR_MANAGEMENT_APPROVAL"`.
4. Management Panel reads these via `GET /management/cases` and `GET /management/approvals`.
5. Management approves/rejects via `PATCH /management/approvals/:id/approve` or `/reject`.
6. This writes back `managementDecision` into the same `Metadata` field and sets `stage = APPROVED | REJECTED`.
7. The Medical Panel polls or listens to observe the decision.

### Approval ID format (medical source)

All medical approvals use a compound ID:

```
{taskId}:{memberId}
```

Example: `task-abc-123:member-xyz-456`

### Push data endpoints

The following endpoints are intended to be called **by the Medical Panel** to push data into the Management Panel DB:

| Endpoint                              | Purpose                           |
|---------------------------------------|-----------------------------------|
| `POST /management/analytics/snapshot` | Push analytics snapshots          |
| `POST /management/performance/kpis`   | Push KPI updates                  |
| `POST /management/departments/metrics`| Push department metrics           |
| `POST /management/alerts`             | Push alerts from medical system   |

---

## Error Codes

| HTTP Status | Meaning                              |
|-------------|--------------------------------------|
| `200`       | Success                              |
| `201`       | Created                              |
| `400`       | Bad request (missing/invalid params) |
| `404`       | Resource not found                   |
| `500`       | Internal server error                |

All errors follow the envelope:
```json
{ "success": false, "message": "Description of the error" }
```
