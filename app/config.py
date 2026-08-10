import logging
from pathlib import Path
from pydantic_settings import BaseSettings
from pydantic import field_validator

PROJECT_ROOT = Path(__file__).parent.parent


class Settings(BaseSettings):
    root_path: str = "/bx/api"
    db_url: str = f"mysql+aiomysql://root:root123@localhost:3306/super_agent?charset=utf8mb4"
    es_hosts: list[str] = ["http://localhost:9200"]
    es_index_prefix: str = "bx-messages"
    openai_api_base: str = "https://api.openai.com/v1"
    openai_api_keys: list[str] = []
    # Model configuration
    default_model: str = "MiniMax-M2"
    compress_model: str = "MiniMax-M2"
    compress_api_base: str = ""    # env: COMPRESS_API_BASE — falls back to openai_api_base
    compress_api_key: str = ""     # env: COMPRESS_API_KEY — falls back to openai_api_keys[0]
    available_models: list[str] = ["MiniMax-M2"]
    # Web tools
    web_search_backend: str = ""  # "bing_cn" | "ddgs" | "" (auto-detect)
    bing_cn_url: str = "https://cn.bing.com"  # Bing CN base URL, overridable for proxy
    web_fetch_max_content_bytes: int = 1_000_000  # 1MB content limit
    # Docker sandbox
    docker_sandbox_image: str = "bx-sandbox:latest"
    docker_max_containers_per_user: int = 3
    docker_max_global_containers: int = 200
    docker_container_idle_timeout_minutes: int = 30
    # SSE
    sse_keepalive_interval_seconds: int = 15
    sse_ingress_timeout_seconds: int = 300
    jwt_secret: str = ""
    debug: bool = False
    cors_allow_origins: list[str] = ["http://localhost:3000"]
    saas_mode: bool = False  # env: SAAS_MODE=true/false — SaaS remote: path-whitelist file ops

    # sys-infra: system pre-built skills/subagents, baked into the container image at build time.
    # Structure: sys-infra/skills/{name}/SKILL.md, sys-infra/subagents/{name}/AGENT.md
    sys_infra_path: str = str(PROJECT_ROOT / "sys-infra")  # env: SYS_INFRA_PATH

    # Cache
    redis_url: str = "redis://localhost:6379/0"       # env: REDIS_URL
    redis_password: str = ""                            # env: REDIS_PASSWORD
    cache_default_ttl: int = 300                        # env: CACHE_DEFAULT_TTL

    # Object Storage
    object_storage_backend: str = ""                    # env: OBJECT_STORAGE_BACKEND (s3|minio|oss|file|"")
    object_storage_endpoint: str = ""                   # env: OBJECT_STORAGE_ENDPOINT
    object_storage_bucket: str = "bx-sa"               # env: OBJECT_STORAGE_BUCKET
    object_storage_prefix: str = "bx-sa"               # env: OBJECT_STORAGE_PREFIX
    object_storage_access_key: str = ""                 # env: OBJECT_STORAGE_ACCESS_KEY
    object_storage_secret_key: str = ""                 # env: OBJECT_STORAGE_SECRET_KEY
    object_storage_region: str = ""                     # env: OBJECT_STORAGE_REGION

    # Embedding (for ES hybrid memory search)
    embedding_model: str = "text-embedding-3-small"     # env: EMBEDDING_MODEL
    embedding_api_base: str = ""                        # env: EMBEDDING_API_BASE — falls back to openai_api_base
    embedding_api_key: str = ""                         # env: EMBEDDING_API_KEY — falls back to openai_api_keys[0]
    embedding_dim: int = 1536                           # env: EMBEDDING_DIM

    # Vision (multimodal image recognition)
    vision_model: str = ""                              # env: VISION_MODEL
    vision_api_base: str = ""                           # env: VISION_API_BASE
    vision_api_key: str = ""                            # env: VISION_API_KEY

    # Memory Distiller
    memory_distill_enabled: bool = True                 # env: MEMORY_DISTILL_ENABLED
    memory_distill_min_messages: int = 4                # env: MEMORY_DISTILL_MIN_MESSAGES
    memory_distill_max_input_chars: int = 8000          # env: MEMORY_DISTILL_MAX_INPUT_CHARS

    # History loading
    history_load_limit: int = 500                       # env: HISTORY_LOAD_LIMIT

    # Memory Injection
    memory_injection_max_chars: int = 500               # env: MEMORY_INJECTION_MAX_CHARS
    memory_injection_top_k: int = 10                    # env: MEMORY_INJECTION_TOP_K

    # Context Compression — absolute-token-offset thresholds (matching Claude Code & OpenClaw)
    context_window_tokens: int = 200_000                # env: CONTEXT_WINDOW_TOKENS — model context window size
    max_output_tokens: int = 20_000                     # env: MAX_OUTPUT_TOKENS — reserved for model response
    auto_compact_buffer_tokens: int = 13_000             # env: AUTO_COMPACT_BUFFER_TOKENS — headroom before auto-compact fires
    max_overflow_retries: int = 3                        # env: MAX_OVERFLOW_RETRIES — circuit breaker for reactive recovery
    # Microcompact: clear old tool results before each API call
    microcompact_enabled: bool = True                    # env: MICROCOMPACT_ENABLED
    microcompact_keep_recent: int = 5                    # env: MICROCOMPACT_KEEP_RECENT — keep last N tool results

    # Agent Plan-Execute Loop
    max_plan_steps: int = 90                            # env: MAX_PLAN_STEPS — max plan step executions before forced stop

    # Subagent
    subagent_default_max_turns: int = 10                # env: SUBAGENT_DEFAULT_MAX_TURNS — default max turns for spawned sub-agents

    # MCP servers config file path
    mcp_config_path: str = str(PROJECT_ROOT / "config" / "mcp_servers.json")  # env: MCP_CONFIG_PATH

    # Internal API token for scheduler → super-agent communication
    internal_api_token: str = ""  # env: INTERNAL_API_TOKEN

    @field_validator("context_window_tokens", "max_plan_steps", mode="before")
    @classmethod
    def validate_numeric_bounds(cls, v, info):
        v = int(v)
        if info.field_name == "context_window_tokens":
            if v < 32_000:
                logging.getLogger(__name__).warning(
                    f"context_window_tokens={v} too low (min 32K), using default 200000"
                )
                return 200_000
            return v
        # max_plan_steps
        if v < 1:
            logging.getLogger(__name__).warning(
                f"max_plan_steps={v} too low, using default 90"
            )
            return 90
        if v > 500:
            logging.getLogger(__name__).warning(
                f"max_plan_steps={v} exceeds cap 500, using 500"
            )
            return 500
        return v

    @field_validator("es_hosts", "openai_api_keys", "available_models", "cors_allow_origins", mode="before")
    @classmethod
    def parse_json_or_csv(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if v.startswith(("[", "{")):
                import json
                return json.loads(v)
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    model_config = {"env_file": str(PROJECT_ROOT / ".env"), "env_file_encoding": "utf-8"}


settings = Settings()