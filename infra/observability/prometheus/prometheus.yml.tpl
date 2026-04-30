global:
  scrape_interval: 15s
  scrape_timeout: 10s
  evaluation_interval: 15s
  external_labels:
    environment: production

# Este arquivo é um TEMPLATE. O entrypoint do container prometheus (em
# docker-compose.yml) substitui os placeholders LAVINMQ_HOST, API_HOST,
# ZAPI_WORKER_HOST, MODERATION_WORKER_HOST pelas envs correspondentes
# antes de subir o Prometheus. Os hostnames precisam ser resolvíveis na
# network shared do Coolify (com hash, ex.: lavinmq-abc123). Os jobs
# cadvisor e node_exporter não usam placeholder porque rodam no mesmo
# docker-compose desta stack.

scrape_configs:
  # Prometheus se auto-monitorando — útil pra ver se o scraper está saudável.
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]

  # LavinMQ — endpoint Prometheus nativo (porta 15692 por default).
  # Docs: https://lavinmq.com/documentation/prometheus
  - job_name: lavinmq
    metrics_path: /metrics
    static_configs:
      - targets: ["__LAVINMQ_HOST__:15692"]

  # LavinMQ detalhado — expõe métricas por fila sob `lavinmq_detailed_*`
  # (com labels `queue` e `vhost`). O parâmetro `family` é OBRIGATÓRIO via
  # query string; sem ele, o endpoint retorna vazio.
  - job_name: lavinmq_detailed
    metrics_path: /metrics/detailed
    params:
      family: ['queue_coarse_metrics', 'queue_consumer_count']
    static_configs:
      - targets: ["__LAVINMQ_HOST__:15692"]

  # cAdvisor — métricas por container (cpu, mem, rede, FS).
  - job_name: cadvisor
    static_configs:
      - targets: ["cadvisor:8080"]

  # node-exporter — métricas do host (load, mem, disco, rede do host).
  - job_name: node_exporter
    static_configs:
      - targets: ["node-exporter:9100"]

  # API HTTP — expõe `/metrics` via Elysia. Porta é a HTTP_PORT da api (3000 default).
  - job_name: api
    metrics_path: /metrics
    static_configs:
      - targets: ["__API_HOST__:3000"]

  # Workers — cada processo expõe `/metrics` na sua porta de health
  # (WORKER_ZAPI_HEALTH_PORT, WORKER_MODERATION_HEALTH_PORT).
  - job_name: workers
    metrics_path: /metrics
    static_configs:
      - targets:
          - "__ZAPI_WORKER_HOST__:3011"
          - "__MODERATION_WORKER_HOST__:3012"
