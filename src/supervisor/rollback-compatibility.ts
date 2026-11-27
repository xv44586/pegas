import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const goalContractSchemaVersion = 15
const collaborationSchemaVersion = 19
const automationSchemaVersion = 20
const memorySchemaVersion = 21
const goalProposalSchemaVersion = 22
const actionReconciliationSchemaVersion = 23
const steeringSchemaVersion = 24
const chatLaneSchemaVersion = 32
const permissionTierSchemaVersion = 40
const approvalRuleSchemaVersion = 41
const approvalReviewSchemaVersion = 42
const policyCallAuditSchemaVersion = 43
const autoReconciliationSchemaVersion = 44
const localDerivedMemorySchemaVersion = 53
const taskResumeSourcePolicySchemaVersion = 56

export class RollbackCompatibilityError extends Error {}

export class RollbackUnavailableError extends Error {}

export function assertRollbackCompatible(
  databasePath: string,
  targetMaximumSchema: number,
  targetTaskWorkflowVersion = 0,
): void {
  if (!existsSync(databasePath)) return
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const current = database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null }
    const currentVersion = current.version ?? 0
    if (
      currentVersion >= 61 &&
      targetMaximumSchema < 61 &&
      (database
        .prepare(
          "SELECT 1 FROM tasks WHERE working_directory IS NOT NULL AND status NOT IN ('completed','cancelled') LIMIT 1",
        )
        .get() ||
        database
          .prepare(
            "SELECT 1 FROM inbox_events WHERE required_contract_version >= 5 AND status IN ('pending','processing') LIMIT 1",
          )
          .get() ||
        database
          .prepare(
            "SELECT 1 FROM runs WHERE execution_contract_version >= 3 AND status IN ('queued','running','waiting') LIMIT 1",
          )
          .get())
    )
      throw new RollbackCompatibilityError(
        'Rollback is unsafe while project or directory work still needs the workspace contract',
      )
    if (
      currentVersion >= 60 &&
      targetMaximumSchema < 60 &&
      database
        .prepare(
          `SELECT 1 FROM actions
      WHERE json_type(request_json, '$.commandSelector') = 'object'
      AND status IN ('awaiting_approval','authorized','unknown') LIMIT 1`,
        )
        .get()
    ) {
      throw new RollbackCompatibilityError(
        'Rollback is unsafe while command authorization is pending or executing',
      )
    }
    if (
      currentVersion >= taskResumeSourcePolicySchemaVersion &&
      (targetTaskWorkflowVersion < 1 ||
        targetMaximumSchema < taskResumeSourcePolicySchemaVersion) &&
      database
        .prepare(
          'SELECT 1 FROM task_resume_source_policies WHERE enabled = 0 LIMIT 1',
        )
        .get()
    ) {
      throw new RollbackCompatibilityError(
        'Rollback is unsafe while a Task resume source is revoked',
      )
    }
    if (
      targetTaskWorkflowVersion < 1 &&
      hasLiveTaskWorkflow(database, currentVersion)
    ) {
      throw new RollbackCompatibilityError(
        'Rollback is unsafe while Task workflow inputs or deliveries still need the newer contract',
      )
    }
    if (
      currentVersion >= collaborationSchemaVersion &&
      targetMaximumSchema < collaborationSchemaVersion
    ) {
      const liveEvents = database
        .prepare(
          `SELECT 1 FROM inbox_events
           WHERE source = 'collaboration'
             AND status IN ('pending','processing')
           LIMIT 1`,
        )
        .get()
      const liveRelations = database
        .prepare(
          `SELECT 1 FROM channel_relations
           WHERE status IN ('pending','active') LIMIT 1`,
        )
        .get()
      if (liveEvents || liveRelations) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while collaboration events or relations are active',
        )
      }
    }
    if (
      currentVersion >= automationSchemaVersion &&
      targetMaximumSchema < automationSchemaVersion
    ) {
      const activeAutomation = database
        .prepare(
          `SELECT 1 FROM automations
           WHERE status = 'active' AND next_fire_at IS NOT NULL LIMIT 1`,
        )
        .get()
      const liveAutomationEvent = database
        .prepare(
          `SELECT 1 FROM inbox_events
           WHERE source = 'automation'
             AND status IN ('pending','processing')
           LIMIT 1`,
        )
        .get()
      if (activeAutomation || liveAutomationEvent) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while Automation schedules or events are active',
        )
      }
    }
    if (
      currentVersion >= memorySchemaVersion &&
      targetMaximumSchema < memorySchemaVersion
    ) {
      const liveMemory = database
        .prepare('SELECT 1 FROM memories LIMIT 1')
        .get()
      if (liveMemory) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while user Memory records exist',
        )
      }
    }
    if (
      currentVersion >= localDerivedMemorySchemaVersion &&
      targetMaximumSchema < localDerivedMemorySchemaVersion
    ) {
      const liveLocalMemory = database
        .prepare(
          `SELECT 1 FROM local_derived_memories WHERE state = 'valid' LIMIT 1`,
        )
        .get()
      if (liveLocalMemory) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while local derived Memory records exist',
        )
      }
    }
    if (
      currentVersion >= goalProposalSchemaVersion &&
      targetMaximumSchema < goalProposalSchemaVersion
    ) {
      const parkedClarification = database
        .prepare(
          `SELECT 1 FROM tasks
           WHERE status NOT IN ('completed','cancelled')
             AND status_reason = 'awaiting_goal_clarification'
           LIMIT 1`,
        )
        .get()
      if (parkedClarification) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while a Task is awaiting Goal clarification',
        )
      }
    }
    if (
      currentVersion >= actionReconciliationSchemaVersion &&
      targetMaximumSchema < actionReconciliationSchemaVersion
    ) {
      const reconciledAction = database
        .prepare(
          `SELECT 1 FROM actions
           WHERE protocol_version = 1 AND status = 'reconciled'
           LIMIT 1`,
        )
        .get()
      if (reconciledAction) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while reconciled Action outcomes exist',
        )
      }
    }
    if (
      currentVersion >= steeringSchemaVersion &&
      targetMaximumSchema < steeringSchemaVersion
    ) {
      const pendingSteering = database
        .prepare(
          `SELECT 1 FROM runs
           WHERE steering_json IS NOT NULL
             AND status IN ('queued','running','waiting')
           LIMIT 1`,
        )
        .get()
      if (pendingSteering) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while unconsumed steering directives exist',
        )
      }
    }
    if (
      currentVersion >= chatLaneSchemaVersion &&
      targetMaximumSchema < chatLaneSchemaVersion
    ) {
      const liveConversationRun = database
        .prepare(
          `SELECT 1 FROM runs
           WHERE status IN ('queued','running','waiting')
             AND task_id IN (SELECT id FROM tasks WHERE kind = 'conversation')
           LIMIT 1`,
        )
        .get()
      if (liveConversationRun) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while conversation Runs are still active',
        )
      }
    }
    if (
      currentVersion >= permissionTierSchemaVersion &&
      targetMaximumSchema < permissionTierSchemaVersion
    ) {
      const nonDefaultGlobalTier = database
        .prepare(
          `SELECT 1 FROM runtime_settings
           WHERE id = 1 AND permission_tier <> 'standard' LIMIT 1`,
        )
        .get()
      const taskTierOverride = database
        .prepare(
          `SELECT 1 FROM worker_profiles
           WHERE permission_mode IS NOT NULL
             AND permission_mode <> 'inherit'
           LIMIT 1`,
        )
        .get()
      if (nonDefaultGlobalTier || taskTierOverride) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while non-default permission tiers are configured',
        )
      }
    }
    if (
      currentVersion >= approvalRuleSchemaVersion &&
      targetMaximumSchema < approvalRuleSchemaVersion
    ) {
      const activeRules = database
        .prepare(`SELECT 1 FROM approval_rules WHERE status = 'active' LIMIT 1`)
        .get()
      if (activeRules) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while active approval rules exist',
        )
      }
    }
    if (
      currentVersion >= approvalReviewSchemaVersion &&
      targetMaximumSchema < approvalReviewSchemaVersion
    ) {
      const enabledReview = database
        .prepare(
          `SELECT 1 FROM runtime_settings
           WHERE id = 1 AND auto_review_enabled = 1 LIMIT 1`,
        )
        .get()
      if (enabledReview) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while auto review is enabled',
        )
      }
    }
    if (
      currentVersion >= policyCallAuditSchemaVersion &&
      targetMaximumSchema < policyCallAuditSchemaVersion
    ) {
      const accountableAllowance = database
        .prepare(
          `SELECT 1 FROM policy_call_audit
           WHERE decision = 'allow'
             AND (rule_id IS NOT NULL OR review_decision IS NOT NULL)
           LIMIT 1`,
        )
        .get()
      if (accountableAllowance) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while rule or review allowances exist only in the call audit table',
        )
      }
    }
    if (
      currentVersion >= autoReconciliationSchemaVersion &&
      targetMaximumSchema < autoReconciliationSchemaVersion
    ) {
      const automaticSettlement = database
        .prepare(
          `SELECT 1 FROM action_reconciliations
           WHERE automatic = 1 LIMIT 1`,
        )
        .get()
      if (automaticSettlement) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while automatically reconciled Action facts exist',
        )
      }
    }
  } finally {
    database.close()
  }
}

function hasLiveTaskWorkflow(database: DatabaseSync, schema: number): boolean {
  if (
    schema >= collaborationSchemaVersion &&
    database
      .prepare(
        `SELECT 1 FROM inbox_events
       WHERE status IN ('pending','processing')
       AND (required_contract_version >= 3 OR (source = 'review' AND type = 'user.message'))
       LIMIT 1`,
      )
      .get()
  )
    return true
  if (
    schema >= collaborationSchemaVersion &&
    database
      .prepare(
        `SELECT 1 FROM runs JOIN tasks ON tasks.id = runs.task_id
       JOIN inbox_events ON inbox_events.id = tasks.origin_event_id
       WHERE runs.status IN ('queued','running','waiting')
       AND inbox_events.required_contract_version >= 4 LIMIT 1`,
      )
      .get()
  )
    return true
  if (
    schema >= steeringSchemaVersion &&
    database
      .prepare(
        `SELECT 1 FROM runs JOIN tasks ON tasks.id = runs.task_id
       WHERE runs.steering_json IS NOT NULL AND tasks.status NOT IN ('completed','cancelled')
       AND runs.status IN ('queued','running','waiting','failed') LIMIT 1`,
      )
      .get()
  )
    return true
  return (
    schema >= goalContractSchemaVersion &&
    Boolean(
      database
        .prepare(
          `SELECT 1 FROM tasks WHERE tasks.status NOT IN ('completed','cancelled') AND (
         tasks.status_reason IN ('awaiting_delivery_acceptance','review_rework_queued','review_rework_failed')
         OR 1 = (
           SELECT json_extract(contract_json, '$.requireAcceptance') FROM goal_contracts
           WHERE task_id = tasks.id ORDER BY revision DESC LIMIT 1
         )
       ) LIMIT 1`,
        )
        .get(),
    )
  )
}
