/**
 * SQLite 数据层（§10.4）。
 * better-sqlite3 同步 API + WAL 模式 + schema_version 迁移表。
 *
 * 存储布局：
 *   {userData}/matrix-agent/
 *   ├── data.db
 *   ├── profiles/{profileId}/   （各 Profile 的 userDataDir）
 *   └── logs/{taskId}/{step}.txt
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  ExtractTemplate,
  Flow,
  LoginCheck,
  Profile,
  ProfileGroup,
  ProxyPoolEntry,
  Schedule,
  Settings,
  Task,
  TaskStatus,
  TaskStep,
  TaskTemplate,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/constants';

let db: Database.Database | null = null;
let dataRoot = '';

export function getDataRoot(): string {
  return dataRoot;
}

export function getProfilesDir(): string {
  return path.join(dataRoot, 'profiles');
}

export function getLogsDir(taskId: string): string {
  return path.join(dataRoot, 'logs', taskId);
}

// ------------------------------------------------------------------ 迁移

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE profiles (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        group_id   TEXT,
        status     TEXT NOT NULL DEFAULT 'idle',
        data       TEXT NOT NULL,          -- Profile 完整 JSON（指纹/代理等字段）
        last_used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        type         TEXT NOT NULL DEFAULT 'single',
        requires_auth INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'pending',
        profile_id   TEXT,
        profile_ids  TEXT,
        result       TEXT,
        retry_count  INTEGER NOT NULL DEFAULT 0,
        max_steps    INTEGER NOT NULL DEFAULT 100,
        error_message TEXT,
        created_at   TEXT NOT NULL,
        started_at   TEXT,
        completed_at TEXT
      );
      CREATE INDEX idx_tasks_status ON tasks(status);

      CREATE TABLE task_steps (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        type         TEXT NOT NULL,
        description  TEXT NOT NULL,
        idx          INTEGER,
        value        TEXT,
        page_state_hash TEXT NOT NULL DEFAULT '',
        snapshot_file TEXT,
        success      INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        timestamp    TEXT NOT NULL
      );
      CREATE INDEX idx_steps_task ON task_steps(task_id, seq);

      CREATE TABLE running_instances (
        profile_id TEXT PRIMARY KEY,
        pid        INTEGER NOT NULL,
        started_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // v2：批量任务父子关系 + 定时任务 + 任务模板
    version: 2,
    sql: `
      ALTER TABLE tasks ADD COLUMN parent_id TEXT;
      CREATE INDEX idx_tasks_parent ON tasks(parent_id);

      CREATE TABLE schedules (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        instruction   TEXT NOT NULL,
        requires_auth INTEGER NOT NULL DEFAULT 1,
        profile_ids   TEXT NOT NULL DEFAULT '[]',
        spec          TEXT NOT NULL,          -- ScheduleSpec JSON
        enabled       INTEGER NOT NULL DEFAULT 1,
        last_run_at   TEXT,
        next_run_at   TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE templates (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        instruction   TEXT NOT NULL,
        requires_auth INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL
      );
    `,
  },
  {
    // v3：步骤截图存档 + 登录态检测
    version: 3,
    sql: `
      ALTER TABLE task_steps ADD COLUMN screenshot_file TEXT;

      CREATE TABLE login_checks (
        id              TEXT PRIMARY KEY,
        profile_id      TEXT NOT NULL,
        name            TEXT NOT NULL,
        url             TEXT NOT NULL,
        mode            TEXT NOT NULL DEFAULT 'selector',
        target          TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'unknown',
        detail          TEXT,
        last_checked_at TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_login_checks_profile ON login_checks(profile_id);
    `,
  },
  {
    // v4：Profile 分组
    version: 4,
    sql: `
      CREATE TABLE profile_groups (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    // v5：流程复用（flows）+ 任务扩展（流程回放/存流程/结构化采集）
    version: 5,
    sql: `
      ALTER TABLE tasks ADD COLUMN flow_id TEXT;
      ALTER TABLE tasks ADD COLUMN save_flow_as TEXT;
      ALTER TABLE tasks ADD COLUMN collect_fields TEXT;

      CREATE TABLE flows (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        instruction   TEXT NOT NULL,
        steps         TEXT NOT NULL,          -- FlowStep[] JSON
        requires_auth INTEGER NOT NULL DEFAULT 1,
        run_count     INTEGER NOT NULL DEFAULT 0,
        last_run_at   TEXT,
        last_status   TEXT,
        created_at    TEXT NOT NULL
      );
    `,
  },
  {
    // v6：任务执行录像
    version: 6,
    sql: `
      ALTER TABLE tasks ADD COLUMN recording_file TEXT;
    `,
  },
  {
    // v7：代理池 + 提取模板 + LLM token 用量（仪表盘成本估算）
    version: 7,
    sql: `
      ALTER TABLE tasks ADD COLUMN llm_usage TEXT;

      CREATE TABLE proxy_pool (
        id          TEXT PRIMARY KEY,
        label       TEXT,
        type        TEXT NOT NULL DEFAULT 'http',
        host        TEXT NOT NULL,
        port        INTEGER NOT NULL,
        username    TEXT,
        password_enc TEXT,
        status      TEXT NOT NULL DEFAULT 'unknown',
        ip          TEXT,
        latency_ms  INTEGER,
        last_error  TEXT,
        checked_at  TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE extract_templates (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        category    TEXT NOT NULL DEFAULT '通用',
        fields      TEXT NOT NULL,           -- string[] JSON
        instruction TEXT NOT NULL DEFAULT '',
        builtin     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
    `,
  },
];

export function initDatabase(): Database.Database {
  if (db) return db;

  dataRoot = path.join(app.getPath('userData'), 'matrix-agent');
  fs.mkdirSync(getProfilesDir(), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });

  const dbPath = path.join(dataRoot, 'data.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`);
  const row = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number | null };
  const current = row?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version > current) {
      const tx = db.transaction(() => {
        db!.exec(m.sql);
        db!.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(m.version);
      });
      tx();
    }
  }

  return db;
}

function getDb(): Database.Database {
  if (!db) throw new Error('数据库尚未初始化，请在 app ready 后调用 initDatabase()');
  return db;
}

// ------------------------------------------------------------------ Settings

export function getSettings(): Settings {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'app'`).get() as
    | { value: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES ('app', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(settings));
}

// ------------------------------------------------------------------ Profile

interface ProfileRow {
  id: string;
  name: string;
  group_id: string | null;
  status: string;
  data: string;
  last_used_at: string | null;
  created_at: string;
}

function rowToProfile(r: ProfileRow): Profile {
  const data = JSON.parse(r.data) as Partial<Profile>;
  return {
    ...(data as Profile),
    id: r.id,
    name: r.name,
    groupId: r.group_id ?? undefined,
    status: r.status as Profile['status'],
    lastUsedAt: r.last_used_at ?? undefined,
    createdAt: r.created_at,
  };
}

export function listProfiles(): Profile[] {
  const rows = getDb().prepare(`SELECT * FROM profiles ORDER BY created_at ASC`).all() as ProfileRow[];
  return rows.map(rowToProfile);
}

export function getProfile(id: string): Profile | null {
  const row = getDb().prepare(`SELECT * FROM profiles WHERE id = ?`).get(id) as ProfileRow | undefined;
  return row ? rowToProfile(row) : null;
}

export function upsertProfile(p: Profile): void {
  const { id, name, groupId, status, lastUsedAt, createdAt, ...rest } = p;
  getDb()
    .prepare(
      `INSERT INTO profiles (id, name, group_id, status, data, last_used_at, created_at)
       VALUES (@id, @name, @group_id, @status, @data, @last_used_at, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         group_id = excluded.group_id,
         status = excluded.status,
         data = excluded.data,
         last_used_at = excluded.last_used_at`,
    )
    .run({
      id,
      name,
      group_id: groupId ?? null,
      status,
      data: JSON.stringify(rest),
      last_used_at: lastUsedAt ?? null,
      created_at: createdAt,
    });
}

export function deleteProfile(id: string): void {
  getDb().prepare(`DELETE FROM profiles WHERE id = ?`).run(id);
}

export function setProfileStatus(id: string, status: Profile['status']): void {
  getDb()
    .prepare(`UPDATE profiles SET status = ?, last_used_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), id);
}

// ------------------------------------------------------------------ Task

interface TaskRow {
  id: string;
  name: string;
  type: string;
  requires_auth: number;
  status: string;
  profile_id: string | null;
  profile_ids: string | null;
  parent_id?: string | null;
  flow_id?: string | null;
  save_flow_as?: string | null;
  collect_fields?: string | null;
  recording_file?: string | null;
  llm_usage?: string | null;
  result: string | null;
  retry_count: number;
  max_steps: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    name: r.name,
    type: r.type as Task['type'],
    requiresAuth: r.requires_auth === 1,
    status: r.status as TaskStatus,
    profileId: r.profile_id ?? undefined,
    profileIds: r.profile_ids ? (JSON.parse(r.profile_ids) as string[]) : undefined,
    parentId: r.parent_id ?? undefined,
    flowId: r.flow_id ?? undefined,
    saveFlowAs: r.save_flow_as ?? undefined,
    collectFields: r.collect_fields ? (JSON.parse(r.collect_fields) as string[]) : undefined,
    recordingFile: r.recording_file ?? undefined,
    llmUsage: r.llm_usage ? (JSON.parse(r.llm_usage) as Task['llmUsage']) : undefined,
    result: r.result ? (JSON.parse(r.result) as Task['result']) : undefined,
    retryCount: r.retry_count,
    maxSteps: r.max_steps,
    errorMessage: r.error_message ?? undefined,
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
  };
}

export function listTasks(limit = 200): Task[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as TaskRow[];
  return rows.map(rowToTask);
}

export function getTask(id: string): Task | null {
  const row = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function upsertTask(t: Task): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, name, type, requires_auth, status, profile_id, profile_ids, parent_id,
                          flow_id, save_flow_as, collect_fields, recording_file, llm_usage,
                          result, retry_count, max_steps, error_message, created_at, started_at, completed_at)
       VALUES (@id, @name, @type, @requires_auth, @status, @profile_id, @profile_ids, @parent_id,
               @flow_id, @save_flow_as, @collect_fields, @recording_file, @llm_usage,
               @result, @retry_count, @max_steps, @error_message, @created_at, @started_at, @completed_at)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         profile_id = excluded.profile_id,
         result = excluded.result,
         retry_count = excluded.retry_count,
         error_message = excluded.error_message,
         recording_file = excluded.recording_file,
         llm_usage = excluded.llm_usage,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at`,
    )
    .run({
      id: t.id,
      name: t.name,
      type: t.type,
      requires_auth: t.requiresAuth ? 1 : 0,
      status: t.status,
      profile_id: t.profileId ?? null,
      profile_ids: t.profileIds ? JSON.stringify(t.profileIds) : null,
      parent_id: t.parentId ?? null,
      flow_id: t.flowId ?? null,
      save_flow_as: t.saveFlowAs ?? null,
      collect_fields: t.collectFields ? JSON.stringify(t.collectFields) : null,
      recording_file: t.recordingFile ?? null,
      llm_usage: t.llmUsage ? JSON.stringify(t.llmUsage) : null,
      result: t.result ? JSON.stringify(t.result) : null,
      retry_count: t.retryCount,
      max_steps: t.maxSteps,
      error_message: t.errorMessage ?? null,
      created_at: t.createdAt,
      started_at: t.startedAt ?? null,
      completed_at: t.completedAt ?? null,
    });
}

/** 批量任务的子任务列表 */
export function listChildTasks(parentId: string): Task[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC`)
    .all(parentId) as TaskRow[];
  return rows.map(rowToTask);
}

export function setTaskStatus(id: string, status: TaskStatus, extra?: Partial<Task>): void {
  const t = getTask(id);
  if (!t) return;
  t.status = status;
  if (extra) Object.assign(t, extra);
  upsertTask(t);
}

// ------------------------------------------------------------------ TaskStep

interface StepRow {
  id: string;
  task_id: string;
  seq: number;
  type: string;
  description: string;
  idx: number | null;
  value: string | null;
  page_state_hash: string;
  snapshot_file: string | null;
  screenshot_file?: string | null;
  success: number;
  error_message: string | null;
  timestamp: string;
}

function rowToStep(r: StepRow): TaskStep {
  return {
    id: r.id,
    taskId: r.task_id,
    seq: r.seq,
    type: r.type as TaskStep['type'],
    description: r.description,
    idx: r.idx ?? undefined,
    value: r.value ?? undefined,
    pageStateHash: r.page_state_hash,
    snapshotFile: r.snapshot_file ?? undefined,
    screenshotFile: r.screenshot_file ?? undefined,
    success: r.success === 1,
    errorMessage: r.error_message ?? undefined,
    timestamp: r.timestamp,
  };
}

export function addTaskStep(step: TaskStep): void {
  getDb()
    .prepare(
      `INSERT INTO task_steps (id, task_id, seq, type, description, idx, value,
                               page_state_hash, snapshot_file, screenshot_file, success, error_message, timestamp)
       VALUES (@id, @task_id, @seq, @type, @description, @idx, @value,
               @page_state_hash, @snapshot_file, @screenshot_file, @success, @error_message, @timestamp)`,
    )
    .run({
      id: step.id,
      task_id: step.taskId,
      seq: step.seq,
      type: step.type,
      description: step.description,
      idx: step.idx ?? null,
      value: step.value ?? null,
      page_state_hash: step.pageStateHash,
      snapshot_file: step.snapshotFile ?? null,
      screenshot_file: step.screenshotFile ?? null,
      success: step.success ? 1 : 0,
      error_message: step.errorMessage ?? null,
      timestamp: step.timestamp,
    });
}

export function listTaskSteps(taskId: string): TaskStep[] {
  const rows = getDb()
    .prepare(`SELECT * FROM task_steps WHERE task_id = ? ORDER BY seq ASC`)
    .all(taskId) as StepRow[];
  return rows.map(rowToStep);
}

export function nextStepSeq(taskId: string): number {
  const row = getDb()
    .prepare(`SELECT MAX(seq) AS m FROM task_steps WHERE task_id = ?`)
    .get(taskId) as { m: number | null };
  return (row?.m ?? 0) + 1;
}

/** 截图异步落盘后回写步骤记录（每步截图存档） */
export function updateStepScreenshot(stepId: string, file: string): void {
  getDb().prepare(`UPDATE task_steps SET screenshot_file = ? WHERE id = ?`).run(file, stepId);
}

// ------------------------------------------------------------------ running_instances（§8.3）

export function registerRunningInstance(profileId: string, pid: number): void {
  getDb()
    .prepare(
      `INSERT INTO running_instances (profile_id, pid, started_at) VALUES (?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at`,
    )
    .run(profileId, pid, new Date().toISOString());
}

export function unregisterRunningInstance(profileId: string): void {
  getDb().prepare(`DELETE FROM running_instances WHERE profile_id = ?`).run(profileId);
}

export function listRunningInstances(): { profileId: string; pid: number; startedAt: string }[] {
  const rows = getDb()
    .prepare(`SELECT profile_id, pid, started_at FROM running_instances`)
    .all() as { profile_id: string; pid: number; started_at: string }[];
  return rows.map((r) => ({ profileId: r.profile_id, pid: r.pid, startedAt: r.started_at }));
}

export function clearRunningInstances(): void {
  getDb().prepare(`DELETE FROM running_instances`).run();
}

/** 崩溃恢复：把 running / paused 任务标记为 interrupted（§8.3-1） */
export function markActiveTasksInterrupted(): number {
  const res = getDb()
    .prepare(
      `UPDATE tasks SET status = 'interrupted'
       WHERE status IN ('running', 'paused')`,
    )
    .run();
  return res.changes;
}

// ------------------------------------------------------------------ Schedules（定时任务）

interface ScheduleRow {
  id: string;
  name: string;
  instruction: string;
  requires_auth: number;
  profile_ids: string;
  spec: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

function rowToSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    name: r.name,
    instruction: r.instruction,
    requiresAuth: r.requires_auth === 1,
    profileIds: JSON.parse(r.profile_ids) as string[],
    spec: JSON.parse(r.spec) as Schedule['spec'],
    enabled: r.enabled === 1,
    lastRunAt: r.last_run_at ?? undefined,
    nextRunAt: r.next_run_at ?? undefined,
    createdAt: r.created_at,
  };
}

export function listSchedules(): Schedule[] {
  const rows = getDb().prepare(`SELECT * FROM schedules ORDER BY created_at DESC`).all() as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function upsertSchedule(s: Schedule): void {
  getDb()
    .prepare(
      `INSERT INTO schedules (id, name, instruction, requires_auth, profile_ids, spec, enabled, last_run_at, next_run_at, created_at)
       VALUES (@id, @name, @instruction, @requires_auth, @profile_ids, @spec, @enabled, @last_run_at, @next_run_at, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         instruction = excluded.instruction,
         requires_auth = excluded.requires_auth,
         profile_ids = excluded.profile_ids,
         spec = excluded.spec,
         enabled = excluded.enabled,
         last_run_at = excluded.last_run_at,
         next_run_at = excluded.next_run_at`,
    )
    .run({
      id: s.id,
      name: s.name,
      instruction: s.instruction,
      requires_auth: s.requiresAuth ? 1 : 0,
      profile_ids: JSON.stringify(s.profileIds),
      spec: JSON.stringify(s.spec),
      enabled: s.enabled ? 1 : 0,
      last_run_at: s.lastRunAt ?? null,
      next_run_at: s.nextRunAt ?? null,
      created_at: s.createdAt,
    });
}

export function deleteSchedule(id: string): void {
  getDb().prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
}

/** 到点待触发的启用中调度 */
export function listDueSchedules(nowIso: string): Schedule[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM schedules
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
    )
    .all(nowIso) as ScheduleRow[];
  return rows.map(rowToSchedule);
}

// ------------------------------------------------------------------ Templates（任务模板）

interface TemplateRow {
  id: string;
  name: string;
  instruction: string;
  requires_auth: number;
  created_at: string;
}

function rowToTemplate(r: TemplateRow): TaskTemplate {
  return {
    id: r.id,
    name: r.name,
    instruction: r.instruction,
    requiresAuth: r.requires_auth === 1,
    createdAt: r.created_at,
  };
}

export function listTemplates(): TaskTemplate[] {
  const rows = getDb().prepare(`SELECT * FROM templates ORDER BY created_at DESC`).all() as TemplateRow[];
  return rows.map(rowToTemplate);
}

export function upsertTemplate(t: TaskTemplate): void {
  getDb()
    .prepare(
      `INSERT INTO templates (id, name, instruction, requires_auth, created_at)
       VALUES (@id, @name, @instruction, @requires_auth, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         instruction = excluded.instruction,
         requires_auth = excluded.requires_auth`,
    )
    .run({
      id: t.id,
      name: t.name,
      instruction: t.instruction,
      requires_auth: t.requiresAuth ? 1 : 0,
      created_at: t.createdAt,
    });
}

export function deleteTemplate(id: string): void {
  getDb().prepare(`DELETE FROM templates WHERE id = ?`).run(id);
}

// ------------------------------------------------------------------ LoginChecks（登录态检测）

interface LoginCheckRow {
  id: string;
  profile_id: string;
  name: string;
  url: string;
  mode: string;
  target: string;
  status: string;
  detail: string | null;
  last_checked_at: string | null;
  created_at: string;
}

function rowToLoginCheck(r: LoginCheckRow): LoginCheck {
  return {
    id: r.id,
    profileId: r.profile_id,
    name: r.name,
    url: r.url,
    mode: r.mode as LoginCheck['mode'],
    target: r.target,
    status: r.status as LoginCheck['status'],
    detail: r.detail ?? undefined,
    lastCheckedAt: r.last_checked_at ?? undefined,
    createdAt: r.created_at,
  };
}

export function listLoginChecks(profileId?: string): LoginCheck[] {
  const rows = (
    profileId
      ? getDb()
          .prepare(`SELECT * FROM login_checks WHERE profile_id = ? ORDER BY created_at ASC`)
          .all(profileId)
      : getDb().prepare(`SELECT * FROM login_checks ORDER BY created_at ASC`).all()
  ) as LoginCheckRow[];
  return rows.map(rowToLoginCheck);
}

export function getLoginCheck(id: string): LoginCheck | null {
  const row = getDb().prepare(`SELECT * FROM login_checks WHERE id = ?`).get(id) as
    | LoginCheckRow
    | undefined;
  return row ? rowToLoginCheck(row) : null;
}

export function upsertLoginCheck(c: LoginCheck): void {
  getDb()
    .prepare(
      `INSERT INTO login_checks (id, profile_id, name, url, mode, target, status, detail, last_checked_at, created_at)
       VALUES (@id, @profile_id, @name, @url, @mode, @target, @status, @detail, @last_checked_at, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         url = excluded.url,
         mode = excluded.mode,
         target = excluded.target,
         status = excluded.status,
         detail = excluded.detail,
         last_checked_at = excluded.last_checked_at`,
    )
    .run({
      id: c.id,
      profile_id: c.profileId,
      name: c.name,
      url: c.url,
      mode: c.mode,
      target: c.target,
      status: c.status,
      detail: c.detail ?? null,
      last_checked_at: c.lastCheckedAt ?? null,
      created_at: c.createdAt,
    });
}

export function deleteLoginCheck(id: string): void {
  getDb().prepare(`DELETE FROM login_checks WHERE id = ?`).run(id);
}

// ------------------------------------------------------------------ ProfileGroups（分组）

export function listGroups(): ProfileGroup[] {
  const rows = getDb()
    .prepare(`SELECT id, name, created_at FROM profile_groups ORDER BY created_at ASC`)
    .all() as { id: string; name: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

export function createGroup(id: string, name: string): ProfileGroup {
  const g: ProfileGroup = { id, name, createdAt: new Date().toISOString() };
  getDb().prepare(`INSERT INTO profile_groups (id, name, created_at) VALUES (?, ?, ?)`).run(
    g.id,
    g.name,
    g.createdAt,
  );
  return g;
}

export function renameGroup(id: string, name: string): void {
  getDb().prepare(`UPDATE profile_groups SET name = ? WHERE id = ?`).run(name, id);
}

/** 删除分组：组内 Profile 落到「未分组」，Profile 本身不动 */
export function deleteGroup(id: string): void {
  const tx = getDb().transaction(() => {
    getDb().prepare(`UPDATE profiles SET group_id = NULL WHERE group_id = ?`).run(id);
    getDb().prepare(`DELETE FROM profile_groups WHERE id = ?`).run(id);
  });
  tx();
}

// ------------------------------------------------------------------ Flows（流程复用）

interface FlowRow {
  id: string;
  name: string;
  instruction: string;
  steps: string;
  requires_auth: number;
  run_count: number;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
}

function rowToFlow(r: FlowRow): Flow {
  return {
    id: r.id,
    name: r.name,
    instruction: r.instruction,
    steps: JSON.parse(r.steps) as Flow['steps'],
    requiresAuth: r.requires_auth === 1,
    runCount: r.run_count,
    lastRunAt: r.last_run_at ?? undefined,
    lastStatus: (r.last_status as Flow['lastStatus']) ?? undefined,
    createdAt: r.created_at,
  };
}

export function listFlows(): Flow[] {
  const rows = getDb().prepare(`SELECT * FROM flows ORDER BY created_at DESC`).all() as FlowRow[];
  return rows.map(rowToFlow);
}

export function getFlow(id: string): Flow | null {
  const row = getDb().prepare(`SELECT * FROM flows WHERE id = ?`).get(id) as FlowRow | undefined;
  return row ? rowToFlow(row) : null;
}

export function upsertFlow(f: Flow): void {
  getDb()
    .prepare(
      `INSERT INTO flows (id, name, instruction, steps, requires_auth, run_count, last_run_at, last_status, created_at)
       VALUES (@id, @name, @instruction, @steps, @requires_auth, @run_count, @last_run_at, @last_status, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         instruction = excluded.instruction,
         steps = excluded.steps,
         requires_auth = excluded.requires_auth,
         run_count = excluded.run_count,
         last_run_at = excluded.last_run_at,
         last_status = excluded.last_status`,
    )
    .run({
      id: f.id,
      name: f.name,
      instruction: f.instruction,
      steps: JSON.stringify(f.steps),
      requires_auth: f.requiresAuth ? 1 : 0,
      run_count: f.runCount,
      last_run_at: f.lastRunAt ?? null,
      last_status: f.lastStatus ?? null,
      created_at: f.createdAt,
    });
}

export function deleteFlow(id: string): void {
  getDb().prepare(`DELETE FROM flows WHERE id = ?`).run(id);
}

// ------------------------------------------------------------------ ProxyPool（全局代理池）

interface ProxyPoolRow {
  id: string;
  label: string | null;
  type: string;
  host: string;
  port: number;
  username: string | null;
  password_enc: string | null;
  status: string;
  ip: string | null;
  latency_ms: number | null;
  last_error: string | null;
  checked_at: string | null;
  created_at: string;
}

function rowToProxyEntry(r: ProxyPoolRow): ProxyPoolEntry {
  return {
    id: r.id,
    label: r.label ?? undefined,
    type: r.type as ProxyPoolEntry['type'],
    host: r.host,
    port: r.port,
    username: r.username ?? undefined,
    passwordEnc: r.password_enc ?? undefined,
    status: r.status as ProxyPoolEntry['status'],
    ip: r.ip ?? undefined,
    latencyMs: r.latency_ms ?? undefined,
    lastError: r.last_error ?? undefined,
    checkedAt: r.checked_at ?? undefined,
    createdAt: r.created_at,
  };
}

export function listProxyPool(): ProxyPoolEntry[] {
  const rows = getDb().prepare(`SELECT * FROM proxy_pool ORDER BY created_at ASC`).all() as ProxyPoolRow[];
  return rows.map(rowToProxyEntry);
}

export function getProxyEntry(id: string): ProxyPoolEntry | null {
  const row = getDb().prepare(`SELECT * FROM proxy_pool WHERE id = ?`).get(id) as ProxyPoolRow | undefined;
  return row ? rowToProxyEntry(row) : null;
}

export function upsertProxyEntry(e: ProxyPoolEntry): void {
  getDb()
    .prepare(
      `INSERT INTO proxy_pool (id, label, type, host, port, username, password_enc, status, ip, latency_ms, last_error, checked_at, created_at)
       VALUES (@id, @label, @type, @host, @port, @username, @password_enc, @status, @ip, @latency_ms, @last_error, @checked_at, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         type = excluded.type,
         host = excluded.host,
         port = excluded.port,
         username = excluded.username,
         password_enc = excluded.password_enc,
         status = excluded.status,
         ip = excluded.ip,
         latency_ms = excluded.latency_ms,
         last_error = excluded.last_error,
         checked_at = excluded.checked_at`,
    )
    .run({
      id: e.id,
      label: e.label ?? null,
      type: e.type,
      host: e.host,
      port: e.port,
      username: e.username ?? null,
      password_enc: e.passwordEnc ?? null,
      status: e.status,
      ip: e.ip ?? null,
      latency_ms: e.latencyMs ?? null,
      last_error: e.lastError ?? null,
      checked_at: e.checkedAt ?? null,
      created_at: e.createdAt,
    });
}

export function deleteProxyEntry(id: string): void {
  getDb().prepare(`DELETE FROM proxy_pool WHERE id = ?`).run(id);
}

export function clearProxyPool(): number {
  return getDb().prepare(`DELETE FROM proxy_pool`).run().changes;
}

// ------------------------------------------------------------------ ExtractTemplates（结构化采集模板）

interface ExtractTemplateRow {
  id: string;
  name: string;
  category: string;
  fields: string;
  instruction: string;
  builtin: number;
  created_at: string;
}

function rowToExtractTemplate(r: ExtractTemplateRow): ExtractTemplate {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    fields: JSON.parse(r.fields) as string[],
    instruction: r.instruction,
    builtin: r.builtin === 1,
    createdAt: r.created_at,
  };
}

export function listExtractTemplates(): ExtractTemplate[] {
  const rows = getDb()
    .prepare(`SELECT * FROM extract_templates ORDER BY builtin DESC, created_at ASC`)
    .all() as ExtractTemplateRow[];
  return rows.map(rowToExtractTemplate);
}

export function upsertExtractTemplate(t: ExtractTemplate): void {
  getDb()
    .prepare(
      `INSERT INTO extract_templates (id, name, category, fields, instruction, builtin, created_at)
       VALUES (@id, @name, @category, @fields, @instruction, @builtin, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         category = excluded.category,
         fields = excluded.fields,
         instruction = excluded.instruction`,
    )
    .run({
      id: t.id,
      name: t.name,
      category: t.category,
      fields: JSON.stringify(t.fields),
      instruction: t.instruction,
      builtin: t.builtin ? 1 : 0,
      created_at: t.createdAt,
    });
}

export function deleteExtractTemplate(id: string): void {
  getDb().prepare(`DELETE FROM extract_templates WHERE id = ?`).run(id);
}
