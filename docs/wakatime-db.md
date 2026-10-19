# WakaTime database (`wakatime`)

Read directly by `/v1/coding`, `/v1/coding/days` and `/v1/telemetry` through `DATABASE_WAKATIME_URL` (same server as `DATABASE_URL`, database `wakatime`). Maintained by another tool (goose migrations); this service only reads it.

## Tables that matter

| Table                               | Notes                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heartbeats`                        | One row per heartbeat. `time` is the key (indexed). `category` has case variants (`ai coding` and `AI Coding`), `ai_line_changes`/`human_line_changes` can be negative (deleted lines), `ai_session` is set on AI heartbeats |
| `source_user_agents`                | `id` is referenced by `heartbeats.source_user_agent_id`; `ai_agent_key` is `claude`, `codex` or `copilot`; `source` is `api`, `wakatime-export` or `estimate`                                                                |
| `ai_model_pricing`                  | `model_key`, `display_name`, `input_cost_per_mtok`, `output_cost_per_mtok`; `default` row is the fallback                                                                                                                    |
| `import_profile`, `import_snapshot` | profile (timezone `Asia/Bangkok`, timeout 15 min) and import runs                                                                                                                                                            |

There is no `model` column: the model is a token inside the user-agent (`sonnet/5-5`, `gpt/6-astra-medium`), taken from `coalesce(heartbeats.plugin, source_user_agents.user_agent)`.

## Estimated model for unattributed AI time (2026-10-17)

24,942 AI heartbeats (1,079 sessions, ~207 h) carried neither a model nor an agent, so they showed up as `Unknown`. At the owner's request they were assigned to models **by estimate**, per session, by time: GPT-6 Astra 40%, Claude Sonnet 5.5 40%, GPT-6.1 Sol 20% (tokens follow the sessions, so their split is 43.7 / 40.0 / 16.3 %). These are not measurements.

- Three marker rows were added to `source_user_agents` with `source = 'estimate'` (ids `estimate-gpt-6-astra`, `estimate-claude-sonnet-5-5`, `estimate-gpt-6.1-sol`; the user-agent text starts with `estimated`).
- The affected `heartbeats` now point at them (`source_user_agent_id`) and have `plugin = NULL`.
- The original values of every changed row are in `public.heartbeat_model_estimate_backup` (`heartbeat_id`, `old_source_user_agent_id`, `old_plugin`, `ai_session`, `assigned_ua_id`).
- Estimated token volume is now costed with those models' prices, so the telemetry cost total rose by roughly $9.5k.

Find the estimated rows: `select count(*) from heartbeats where source_user_agent_id like 'estimate-%';`

Undo:

```sql
begin;
update heartbeats h
   set source_user_agent_id = b.old_source_user_agent_id, plugin = b.old_plugin, updated_at = now()
  from public.heartbeat_model_estimate_backup b
 where b.heartbeat_id = h.id;
delete from source_user_agents where source = 'estimate';
-- check the row count, then commit; keep or drop the backup table afterwards
commit;
```

A later import of the same export may not carry this assignment (heartbeats are de-duplicated by `dedupe_hash`), so check `Unknown` again after importing.
