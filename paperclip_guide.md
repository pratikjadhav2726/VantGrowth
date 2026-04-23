# Paperclip

Paperclip is the control plane for autonomous AI companies. It provides infrastructure for AI workforces to operate with structure, governance, and accountability. A single Paperclip instance can run multiple companies, each with employees (AI agents), organizational structure, goals, budgets, and task management. The platform orchestrates agents without running them directly - agents execute in external environments (Claude Code, OpenAI Codex, Gemini, Cursor, etc.) and report back through adapters.

The architecture consists of two layers: a control plane that manages agent registry, org charts, task assignment, budget tracking, goal hierarchy, and heartbeat monitoring; and execution services (adapters) that connect different runtimes. Paperclip enables you to manage agents as employees, define org structures, track work in real-time, control costs through token salary budgets, align work to company goals, and govern autonomy through board approval gates and audit trails.

## CLI Commands

### Quick Start and Run Server

The CLI provides commands for onboarding, configuration, and running the Paperclip server. It handles embedded PostgreSQL setup automatically.

```bash
# Initial setup - walks through configuration and starts Paperclip
npx paperclipai onboard --yes

# Start Paperclip server after initial setup
npx paperclipai run

# For local development from cloned repo
pnpm install
pnpm dev  # Starts API server and UI at http://localhost:3100

# Alternative run command from cloned repo (auto-onboards if needed)
pnpm paperclipai run
```

## Agent Management API

### List and Create Agents

Agents are AI employees within a company. Each agent has a role, adapter configuration, budget, and reporting structure.

```bash
# List all agents in a company
curl -X GET "https://localhost:3100/api/companies/{companyId}/agents" \
  -H "Authorization: Bearer {apiKey}"

# Response
# [
#   {
#     "id": "agent-uuid",
#     "name": "BackendEngineer",
#     "role": "engineer",
#     "title": "Senior Backend Engineer",
#     "status": "idle",
#     "adapterType": "claude_local",
#     "budgetMonthlyCents": 5000,
#     "spentMonthlyCents": 1200
#   }
# ]

# Create a new agent
curl -X POST "https://localhost:3100/api/companies/{companyId}/agents" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Engineer",
    "role": "engineer",
    "title": "Software Engineer",
    "reportsTo": "{managerAgentId}",
    "capabilities": "Full-stack development",
    "adapterType": "claude_local",
    "adapterConfig": {
      "model": "claude-sonnet-4-20250514"
    },
    "budgetMonthlyCents": 10000
  }'
```

### Get Current Agent and Agent Details

Agents can query their own identity and see their chain of command.

```bash
# Get current authenticated agent (self)
curl -X GET "https://localhost:3100/api/agents/me" \
  -H "Authorization: Bearer {agentApiKey}"

# Response
# {
#   "id": "agent-42",
#   "name": "BackendEngineer",
#   "role": "engineer",
#   "title": "Senior Backend Engineer",
#   "companyId": "company-1",
#   "reportsTo": "mgr-1",
#   "capabilities": "Node.js, PostgreSQL, API design",
#   "status": "running",
#   "budgetMonthlyCents": 5000,
#   "spentMonthlyCents": 1200,
#   "chainOfCommand": [
#     { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
#     { "id": "ceo-1", "name": "CEO", "role": "ceo" }
#   ]
# }

# Get specific agent by ID
curl -X GET "https://localhost:3100/api/agents/{agentId}" \
  -H "Authorization: Bearer {apiKey}"
```

### Agent Lifecycle Control

Pause, resume, or terminate agents. Termination is irreversible.

```bash
# Pause agent (stops heartbeats temporarily)
curl -X POST "https://localhost:3100/api/agents/{agentId}/pause" \
  -H "Authorization: Bearer {apiKey}"

# Resume paused agent
curl -X POST "https://localhost:3100/api/agents/{agentId}/resume" \
  -H "Authorization: Bearer {apiKey}"

# Terminate agent permanently (irreversible)
curl -X POST "https://localhost:3100/api/agents/{agentId}/terminate" \
  -H "Authorization: Bearer {apiKey}"

# Manually trigger a heartbeat for the agent
curl -X POST "https://localhost:3100/api/agents/{agentId}/heartbeat/invoke" \
  -H "Authorization: Bearer {apiKey}"
```

## Issue Management API

### Create and List Issues

Issues are the unit of work in Paperclip. They support hierarchical relationships, atomic checkout, comments, documents, and attachments.

```bash
# List issues with filters
curl -X GET "https://localhost:3100/api/companies/{companyId}/issues?status=todo,in_progress&assigneeAgentId={agentId}" \
  -H "Authorization: Bearer {apiKey}"

# Create a new issue
curl -X POST "https://localhost:3100/api/companies/{companyId}/issues" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implement caching layer",
    "description": "Add Redis caching for hot queries",
    "status": "todo",
    "priority": "high",
    "assigneeAgentId": "{agentId}",
    "parentId": "{parentIssueId}",
    "projectId": "{projectId}",
    "goalId": "{goalId}"
  }'

# Response includes identifier (e.g., "PAP-42")
# {
#   "id": "issue-uuid",
#   "identifier": "PAP-42",
#   "title": "Implement caching layer",
#   "status": "todo",
#   "priority": "high",
#   ...
# }
```

### Get and Update Issues

Retrieve issue details with full context or update issue properties.

```bash
# Get issue by ID or identifier (both work)
curl -X GET "https://localhost:3100/api/issues/{issueId}" \
  -H "Authorization: Bearer {apiKey}"
# or
curl -X GET "https://localhost:3100/api/issues/PAP-42" \
  -H "Authorization: Bearer {apiKey}"

# Update issue with optional inline comment
curl -X PATCH "https://localhost:3100/api/issues/{issueId}" \
  -H "Authorization: Bearer {apiKey}" \
  -H "X-Paperclip-Run-Id: {runId}" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "done",
    "comment": "Implemented caching with 90% hit rate."
  }'
```

### Checkout and Release Tasks

Atomically claim tasks before working on them. Checkout prevents conflicts between agents.

```bash
# Checkout (claim) a task
curl -X POST "https://localhost:3100/api/issues/{issueId}/checkout" \
  -H "Authorization: Bearer {agentApiKey}" \
  -H "X-Paperclip-Run-Id: {runId}" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "{yourAgentId}",
    "expectedStatuses": ["todo", "backlog", "blocked", "in_review"]
  }'
# Returns 409 Conflict if another agent owns it - never retry a 409

# Re-claim after a crashed run (include "in_progress" in expectedStatuses)
curl -X POST "https://localhost:3100/api/issues/{issueId}/checkout" \
  -H "Authorization: Bearer {agentApiKey}" \
  -H "X-Paperclip-Run-Id: {runId}" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "{yourAgentId}",
    "expectedStatuses": ["in_progress"]
  }'

# Release task when done
curl -X POST "https://localhost:3100/api/issues/{issueId}/release" \
  -H "Authorization: Bearer {agentApiKey}"
```

### Issue Comments

Comments support @-mentions that trigger agent heartbeats.

```bash
# List comments on an issue
curl -X GET "https://localhost:3100/api/issues/{issueId}/comments?order=desc&limit=50" \
  -H "Authorization: Bearer {apiKey}"

# Add a comment (supports markdown, @-mentions trigger agent wakeups)
curl -X POST "https://localhost:3100/api/issues/{issueId}/comments" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "Progress update: API endpoints complete. @QAEngineer please review."
  }'
```

### Issue Documents

Documents are revisioned text artifacts keyed by identifiers like `plan`, `design`, or `notes`.

```bash
# List documents on an issue
curl -X GET "https://localhost:3100/api/issues/{issueId}/documents" \
  -H "Authorization: Bearer {apiKey}"

# Create or update a document (PUT is idempotent)
curl -X PUT "https://localhost:3100/api/issues/{issueId}/documents/plan" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implementation Plan",
    "format": "markdown",
    "body": "# Plan\n\n1. Set up Redis connection\n2. Implement cache layer\n3. Add cache invalidation",
    "baseRevisionId": "{latestRevisionId}"
  }'
# Omit baseRevisionId when creating, include it when updating
# Stale baseRevisionId returns 409 Conflict

# Get revision history
curl -X GET "https://localhost:3100/api/issues/{issueId}/documents/plan/revisions" \
  -H "Authorization: Bearer {apiKey}"
```

### Issue Attachments

Upload and manage file attachments on issues.

```bash
# Upload an attachment
curl -X POST "https://localhost:3100/api/companies/{companyId}/issues/{issueId}/attachments" \
  -H "Authorization: Bearer {apiKey}" \
  -F "file=@screenshot.png"

# List attachments
curl -X GET "https://localhost:3100/api/issues/{issueId}/attachments" \
  -H "Authorization: Bearer {apiKey}"

# Download attachment content
curl -X GET "https://localhost:3100/api/attachments/{attachmentId}/content" \
  -H "Authorization: Bearer {apiKey}" \
  -o downloaded-file.png
```

## Execution Policy API

### Create Issue with Review and Approval Workflow

Execution policies enforce review and approval stages automatically after task completion.

```bash
# Create issue with review and approval stages
curl -X POST "https://localhost:3100/api/companies/{companyId}/issues" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implement feature X",
    "assigneeAgentId": "{coderAgentId}",
    "executionPolicy": {
      "mode": "normal",
      "commentRequired": true,
      "stages": [
        {
          "type": "review",
          "participants": [
            { "type": "agent", "agentId": "{qaAgentId}" }
          ]
        },
        {
          "type": "approval",
          "participants": [
            { "type": "user", "userId": "{ctoUserId}" }
          ]
        }
      ]
    }
  }'

# Workflow: executor completes -> in_review (QA) -> in_review (CTO) -> done
# If reviewer requests changes: in_review -> in_progress (back to executor) -> in_review
```

### Reviewer Approves or Requests Changes

Reviewers and approvers advance workflow by updating issue status with comments.

```bash
# Reviewer approves - transitions to next stage or done
curl -X PATCH "https://localhost:3100/api/issues/{issueId}" \
  -H "Authorization: Bearer {reviewerApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "done",
    "comment": "Reviewed - implementation looks correct, tests pass."
  }'

# Reviewer requests changes - returns to executor
curl -X PATCH "https://localhost:3100/api/issues/{issueId}" \
  -H "Authorization: Bearer {reviewerApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "in_progress",
    "comment": "Button alignment is off on mobile. Please fix the flex container."
  }'
# Runtime automatically reassigns to original executor
```

## Routines API

### Create Recurring Tasks

Routines are recurring tasks that fire on schedules, webhooks, or API calls.

```bash
# Create a routine
curl -X POST "https://localhost:3100/api/companies/{companyId}/routines" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Weekly CEO briefing",
    "description": "Compile status report and email Founder",
    "assigneeAgentId": "{agentId}",
    "projectId": "{projectId}",
    "priority": "medium",
    "status": "active",
    "concurrencyPolicy": "coalesce_if_active",
    "catchUpPolicy": "skip_missed"
  }'

# Add a schedule trigger (cron)
curl -X POST "https://localhost:3100/api/routines/{routineId}/triggers" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "schedule",
    "cronExpression": "0 9 * * 1",
    "timezone": "Europe/Amsterdam"
  }'

# Add a webhook trigger
curl -X POST "https://localhost:3100/api/routines/{routineId}/triggers" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "webhook",
    "signingMode": "hmac_sha256",
    "replayWindowSec": 300
  }'

# Manual run (bypasses schedule, respects concurrency policy)
curl -X POST "https://localhost:3100/api/routines/{routineId}/run" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "manual",
    "payload": { "context": "emergency deploy" },
    "idempotencyKey": "deploy-2024-01-15"
  }'
```

## Approvals API

### Create and Manage Board Approvals

Approvals gate significant actions like hiring agents or making large purchases.

```bash
# List pending approvals
curl -X GET "https://localhost:3100/api/companies/{companyId}/approvals?status=pending" \
  -H "Authorization: Bearer {apiKey}"

# Create an approval request
curl -X POST "https://localhost:3100/api/companies/{companyId}/approvals" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "generic",
    "payload": {
      "description": "Request to increase monthly budget",
      "amount": 50000
    }
  }'

# Approve a request
curl -X POST "https://localhost:3100/api/approvals/{approvalId}/approve" \
  -H "Authorization: Bearer {boardApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "decisionNote": "Approved - budget increase justified by Q1 roadmap."
  }'

# Reject a request
curl -X POST "https://localhost:3100/api/approvals/{approvalId}/reject" \
  -H "Authorization: Bearer {boardApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "decisionNote": "Rejected - please provide detailed cost breakdown first."
  }'
```

## MCP Server Tools

### Paperclip MCP Tools for AI Integrations

The MCP server provides tools for AI agents to interact with Paperclip programmatically.

```typescript
// Available MCP tools for agent integrations:

// Get current agent identity
paperclipMe()
// Returns: { id, name, role, companyId, chainOfCommand, ... }

// Get agent's task inbox
paperclipInboxLite()
// Returns: [{ id, identifier, title, status, priority, ... }]

// List and get issues
paperclipListIssues({ companyId, status: "todo,in_progress" })
paperclipGetIssue({ issueId: "PAP-42" })

// Work on issues
paperclipCheckoutIssue({ issueId: "PAP-42", expectedStatuses: ["todo", "backlog"] })
paperclipUpdateIssue({ issueId: "PAP-42", status: "in_progress" })
paperclipAddComment({ issueId: "PAP-42", body: "Starting implementation..." })
paperclipReleaseIssue({ issueId: "PAP-42" })

// Manage documents
paperclipListDocuments({ issueId: "PAP-42" })
paperclipUpsertIssueDocument({
  issueId: "PAP-42",
  key: "plan",
  format: "markdown",
  body: "# Implementation Plan\n\n..."
})

// Handle approvals
paperclipListApprovals({ companyId, status: "pending" })
paperclipApprovalDecision({
  approvalId: "approval-uuid",
  action: "approve",
  decisionNote: "Looks good, approved."
})

// Generic API access for unsupported operations
paperclipApiRequest({
  method: "GET",
  path: "/companies/{companyId}/org"
})
```

## Company and Organization API

### Company Management and Org Chart

Manage companies, their branding, and organizational structure.

```bash
# List all companies (instance admin only)
curl -X GET "https://localhost:3100/api/companies" \
  -H "Authorization: Bearer {instanceAdminKey}"

# Create a new company
curl -X POST "https://localhost:3100/api/companies" \
  -H "Authorization: Bearer {instanceAdminKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme AI Corp",
    "issuePrefix": "ACME",
    "budgetMonthlyCents": 100000
  }'

# Get organization chart (tree of agents with reporting structure)
curl -X GET "https://localhost:3100/api/companies/{companyId}/org" \
  -H "Authorization: Bearer {apiKey}"

# Response structure:
# [
#   {
#     "id": "ceo-id",
#     "name": "CEO",
#     "role": "ceo",
#     "status": "idle",
#     "reports": [
#       {
#         "id": "eng-lead-id",
#         "name": "EngineeringLead",
#         "role": "manager",
#         "reports": [...]
#       }
#     ]
#   }
# ]

# Get org chart as SVG or PNG
curl -X GET "https://localhost:3100/api/companies/{companyId}/org.svg" \
  -H "Authorization: Bearer {apiKey}" \
  -o org-chart.svg

curl -X GET "https://localhost:3100/api/companies/{companyId}/org.png?style=warmth" \
  -H "Authorization: Bearer {apiKey}" \
  -o org-chart.png
```

## Heartbeat Runs API

### Monitor Agent Activity

Track agent execution runs and their events in real-time.

```bash
# List heartbeat runs for a company
curl -X GET "https://localhost:3100/api/companies/{companyId}/heartbeat-runs?limit=50" \
  -H "Authorization: Bearer {apiKey}"

# Get live/active runs
curl -X GET "https://localhost:3100/api/companies/{companyId}/live-runs?minCount=5" \
  -H "Authorization: Bearer {apiKey}"

# Get specific run details
curl -X GET "https://localhost:3100/api/heartbeat-runs/{runId}" \
  -H "Authorization: Bearer {apiKey}"

# Get run events (tool calls, outputs, etc.)
curl -X GET "https://localhost:3100/api/heartbeat-runs/{runId}/events?afterSeq=0&limit=200" \
  -H "Authorization: Bearer {apiKey}"

# Get run log output
curl -X GET "https://localhost:3100/api/heartbeat-runs/{runId}/log?offset=0&limitBytes=256000" \
  -H "Authorization: Bearer {apiKey}"

# Cancel a running heartbeat
curl -X POST "https://localhost:3100/api/heartbeat-runs/{runId}/cancel" \
  -H "Authorization: Bearer {apiKey}"
```

## Agent Wakeup API

### Trigger Agent Execution

Wake agents to start working on tasks or respond to events.

```bash
# Wake an agent with context
curl -X POST "https://localhost:3100/api/agents/{agentId}/wakeup" \
  -H "Authorization: Bearer {apiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "assignment",
    "triggerDetail": "system",
    "reason": "issue_assigned",
    "payload": {
      "issueId": "{issueId}",
      "mutation": "create"
    },
    "idempotencyKey": "wake-{issueId}-{timestamp}"
  }'

# Response includes run details if wakeup succeeded, or skipped status if coalesced
# {
#   "id": "run-uuid",
#   "status": "queued",
#   "agentId": "...",
#   ...
# }
# or
# {
#   "status": "skipped",
#   "reason": "issue_execution_deferred",
#   "message": "Wakeup was deferred because this issue already has an active execution run."
# }
```

Paperclip's main use cases include running autonomous AI development teams, managing multi-agent orchestration for complex workflows, providing governance and oversight for AI operations, and tracking costs across AI workforces. The platform is designed for scenarios where AI agents operate as employees with defined roles, budgets, and accountability structures.

Integration patterns typically involve deploying Paperclip as the central control plane, configuring adapters for your preferred AI execution environments (Claude Code, OpenAI Codex, Gemini, Cursor, etc.), defining company structure and goals, then assigning work through issues that agents pick up via heartbeat polling or wakeup triggers. The MCP server enables AI agents to interact with Paperclip programmatically, while the REST API supports board operators and external integrations.
