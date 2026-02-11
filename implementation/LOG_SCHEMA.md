# unified-agent Gateway Log Schema

## Event Fields

Every structured log/event emitted by the gateway should include:

- `ts`: ISO timestamp
- `session_id`: gateway session id
- `meta_session_id`: canonical meta-session id
- `provider`: active provider (`claude|codex|gemini|mock`)
- `kind`: `control_request|control_response|transport_state|assistant_event|error`
- `subtype`: operation-specific subtype (for control messages)
- `request_id`: request correlation id when available
- `payload`: sanitized object payload

## Recommended Operational Dashboards

- `requests_total{provider,subtype}`
- `control_response_latency_ms{provider,subtype}`
- `policy_denials_total{reason}`
- `unsupported_subtype_total{provider,subtype}`
- `reconnect_attempts_total{provider}`
