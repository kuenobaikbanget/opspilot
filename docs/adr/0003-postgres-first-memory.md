# ADR-0003: PostgreSQL-first storage and incident memory

- Status: Accepted
- Context: Small scale with 1–20 hosts, limited ops budget, RAG capability desired, no need for extra data services on day one.
- Decision: PostgreSQL for events, metrics, config hashes and human-resolved memory. Initial memory retrieval via built-in full-text search. No Redis, Loki, VictoriaMetrics or pgvector service in initial scaffold.
- Consequences: Easy local deployment. Large time-series volume requires retention/partitioning; FTS misses semantic similarities. Add pgvector/hybrid retrieval behind evaluation gate; external embedding provider may differ from reasoning provider.
