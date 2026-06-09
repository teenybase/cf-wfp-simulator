/** Public types for the WFP REST API surface and bindings. */

export type BindingType =
  | 'd1' | 'kv_namespace' | 'r2_bucket' | 'durable_object_namespace'
  | 'queue' | 'service' | 'plain_text' | 'secret_text' | 'json' | 'assets';

export interface BindingBase { type: BindingType; name: string }
export interface D1Binding extends BindingBase { type: 'd1'; id: string }
export interface KVBinding extends BindingBase { type: 'kv_namespace'; namespace_id: string }
export interface R2Binding extends BindingBase { type: 'r2_bucket'; bucket_name: string }
export interface DOBinding extends BindingBase { type: 'durable_object_namespace'; class_name: string; script_name?: string }
export interface QueueBinding extends BindingBase { type: 'queue'; queue_name: string }
export interface ServiceBinding extends BindingBase { type: 'service'; service: string }
export interface PlainTextBinding extends BindingBase { type: 'plain_text'; text: string }
export interface SecretTextBinding extends BindingBase { type: 'secret_text'; text: string }
export interface JSONBinding extends BindingBase { type: 'json'; json: unknown }
export interface AssetsBinding extends BindingBase { type: 'assets' }

export type Binding =
  | D1Binding | KVBinding | R2Binding | DOBinding | QueueBinding | ServiceBinding
  | PlainTextBinding | SecretTextBinding | JSONBinding | AssetsBinding;

export interface AssetsConfig {
  html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
  not_found_handling?: 'none' | 'single-page-application' | '404-page';
  run_worker_first?: boolean | string[];
}

export interface DurableObjectMigration {
  tag?: string;
  /** Classes added with KV-backed storage (transactional KV). */
  new_classes?: string[];
  /** Classes added with SQLite-backed storage. */
  new_sqlite_classes?: string[];
  deleted_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
  transferred_classes?: { from: string; from_script: string; to: string }[];
}

export interface ScriptMetadata {
  main_module?: string;
  body_part?: string;
  bindings?: Binding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  tags?: string[];
  /** Assets binding payload — `jwt` is the completion token from the asset upload flow. */
  assets?: { jwt: string; config?: AssetsConfig };
  /** DO migrations metadata. Sim derives per-class storage mode from this. */
  migrations?: DurableObjectMigration[];
  /** Tail consumers wired via service binding. */
  tail_consumers?: { service: string; environment?: string; namespace?: string }[];
  observability?: { enabled?: boolean; head_sampling_rate?: number };
  placement?: { mode?: 'smart' };
  logpush?: boolean;
  usage_model?: 'standard' | 'bundled' | 'unbound';
  limits?: { cpu_ms?: number; subrequests?: number };
}

export interface ScriptInfo {
  id: string;
  tags?: string[];
  created_on?: string;
  modified_on?: string;
  etag?: string;
}

export interface CFEnvelope<T> {
  result: T;
  success: boolean;
  errors: { code?: number; message: string }[];
  messages: { code?: number; message: string }[];
}
