export const migrations = [
  `
  CREATE TABLE plans (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL, deadline_at_ms INTEGER NOT NULL,
    time_zone TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active', 'archived')),
    deduct_rest INTEGER NOT NULL CHECK(deduct_rest IN (0, 1)),
    archived_at_ms INTEGER, revision INTEGER NOT NULL DEFAULT 1, updated_at_ms INTEGER NOT NULL,
    CHECK(deadline_at_ms > started_at_ms),
    CHECK((state = 'active') = (archived_at_ms IS NULL))
  );
  CREATE UNIQUE INDEX one_active_plan ON plans(state) WHERE state = 'active';
  CREATE INDEX archived_plans ON plans(archived_at_ms DESC, id) WHERE state = 'archived';
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
    title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('todo', 'doing', 'done')),
    due_at_ms INTEGER, remaining_estimate_minutes INTEGER CHECK(remaining_estimate_minutes >= 0),
    completed_at_ms INTEGER, deleted_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    CHECK((status = 'done') = (completed_at_ms IS NOT NULL))
  );
  CREATE INDEX tasks_by_plan ON tasks(plan_id, deleted_at_ms, status, due_at_ms);
  CREATE TABLE rest_rules (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
    label TEXT NOT NULL, start_local TEXT NOT NULL, end_local TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 19),
    CHECK(start_local != end_local),
    UNIQUE(plan_id, sort_order)
  );
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY, value_json TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE task_groups (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id),
    title TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  );
  CREATE INDEX groups_by_plan ON task_groups(plan_id, created_at_ms, id);
  ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id) ON DELETE SET NULL;
  CREATE INDEX tasks_by_group ON tasks(group_id);
  `
]
