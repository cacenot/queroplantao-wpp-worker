# Z-API — snapshot de estado

O snapshot atual da Z-API vive em `zapi_instances`, mas a observabilidade de webhook fica nas tabelas append-only:

- `zapi_instance_connection_events`
- `zapi_instance_device_snapshots`

`last_webhook_received_at` não deve existir em `zapi_instances`, porque webhooks de alta frequência transformariam a row de snapshot em hot row de update sem ganho real. O campo `received_at` nos eventos históricos já cobre esse caso.
