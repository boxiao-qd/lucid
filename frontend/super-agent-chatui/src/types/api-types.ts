export interface SessionItem {
  session_id: string;
  title?: string;
  model?: string;
  created_at: string;
  updated_at?: string;
  message_count: number;
  is_active: boolean;
}

export interface Attachment {
  type: string;
  url: string;
  name: string;
}

export interface MessageItem {
  id: string;
  session_id: string;
  role: string;
  content?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  tool_name?: string;
  tool_call_id?: string;
  reasoning_content?: string;
  token_count: number;
  is_compressed: boolean;
  attachments?: Attachment[];
  created_at: string;
}

export interface MemoryItem {
  id: string;
  key: string;
  value: string;
  source: string;
  created_at: string;
}

export interface SkillItem {
  id: string;
  name: string;
  content_md: string;
  header_description?: string;
  object_key?: string;
  is_global: boolean;
  usage_count: number;
  created_at: string;
  source?: "user" | "sys_infra";
  version?: string;
  slug?: string;
}

export interface AgentDefinitionSummary {
  agent_type: string;
  when_to_use: string;
  source: "builtin" | "database";
  tools: string[] | null;
  disallowed_tools: string[] | null;
  color: string | null;
  model: string | null;
}

export interface AgentDefinitionListResponse {
  agents: AgentDefinitionSummary[];
}

export interface CronJobItem {
  id: string;
  name: string | null;
  prompt: string;
  cron_expr: string;
  is_active: number;
  is_running: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  run_count: number;
  consecutive_errors: number;
}

export interface CronJobListResponse {
  jobs: CronJobItem[];
  count: number;
}

export interface CronRunItem {
  id: string;
  cron_job_id: string;
  session_id: string | null;
  status: string;
  result_summary: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_seconds: number | null;
  file_id: string | null;
  created_at: string;
}

export interface CronRunListResponse {
  runs: CronRunItem[];
  count: number;
}

export interface SubagentItem {
  id: string;
  name: string;
  definition_md: string;
  header_description?: string;
  object_key?: string;
  tools: string[];
  constraints: string[];
  is_global: boolean;
  created_at: string;
}

export interface SearchResultItem {
  session_id: string;
  session_title?: string;
  snippet: string;
  message_id?: string;
  timestamp?: string;
}

export interface ModelOption {
  model_id: string;
  name: string;
  description?: string;
}

export interface ToolOption {
  tool_name: string;
  display_name: string;
  description?: string;
  category: string;
}

export interface SettingsData {
  models: ModelOption[];
  current_model?: string;
  enabled_tools: string[];
  available_tools: ToolOption[];
}

export interface PaginationMeta {
  total: number;
  page: number;
  page_size: number;
}