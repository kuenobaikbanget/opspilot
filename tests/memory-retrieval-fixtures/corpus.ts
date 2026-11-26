/**
 * Reproducible synthetic repeat-incident memory corpus.
 *
 * 18 resolved repeat-incident memory records and 20 query cases with gold
 * expected memory IDs. The corpus deliberately covers:
 * - `exact` cases: the query reuses the memory's exact vocabulary (FTS succeeds),
 * - `paraphrase` cases: realistic root-cause paraphrases with vocabulary mismatch
 *   (FTS `plainto_tsquery` AND-semantics misses them, concept embeddings find them),
 * - `distractor` cases: unrelated queries where no memory should dominate top-1.
 *
 * `concepts` are the deterministic semantic signal used by the harness to build
 * fixture embeddings (multi-hot vectors over a fixed concept vocabulary) — no
 * live paid API calls happen in tests.
 */

export type MemoryRecord = {
  id: string;
  summary: string;
  resolution: string;
  created_at: string;
  concepts: string[];
};

export type QueryCase = {
  id: string;
  query: string;
  kind: "exact" | "paraphrase" | "distractor";
  /** Gold memory IDs that are relevant for this query (empty for distractors). */
  expected: string[];
  concepts: string[];
};

export const MEMORY_RECORDS: MemoryRecord[] = [
  {
    id: "mem-oom-worker",
    summary: "OOM killer terminated worker process on app host",
    resolution: "Kernel log shows oom-kill for the PID of the node worker after the cgroup memory limit was hit; raised the systemd MemoryMax and restarted the unit.",
    created_at: "2025-01-02T10:00:00.000Z",
    concepts: ["linux", "kernel", "oom", "memory", "process-kill", "cgroup", "systemd"],
  },
  {
    id: "mem-enospc-root",
    summary: "ENOSPC write failure on root filesystem",
    resolution: "df showed / at 100%; log rotation and docker image prune freed space and app writes resumed.",
    created_at: "2025-01-03T10:00:00.000Z",
    concepts: ["disk", "full", "enospc", "root-partition", "cleanup", "docker"],
  },
  {
    id: "mem-nginx-502",
    summary: "502 Bad Gateway from nginx reverse proxy",
    resolution: "Upstream app container was down; nginx returned 502. Restarted the app container and the proxy recovered.",
    created_at: "2025-01-04T10:00:00.000Z",
    concepts: ["nginx", "proxy", "http-502", "upstream-down", "container"],
  },
  {
    id: "mem-tls-expired",
    summary: "x509 certificate has expired on ingress",
    resolution: "TLS cert past notAfter; renewed with certbot and reloaded nginx; handshake errors stopped.",
    created_at: "2025-01-05T10:00:00.000Z",
    concepts: ["tls", "certificate", "expired", "x509", "ingress", "renewal"],
  },
  {
    id: "mem-emfile",
    summary: "too many open files (EMFILE) in node service",
    resolution: "Raised fs.file-max and the systemd LimitNOFILE; the service recovered after restart.",
    created_at: "2025-01-06T10:00:00.000Z",
    concepts: ["file-descriptors", "emfile", "limits", "ulimit", "node", "restart"],
  },
  {
    id: "mem-pg-maxconn",
    summary: "PostgreSQL max_connections reached",
    resolution: "Connection pool exhausted all 100 slots; raised max_connections and added pgbouncer in front.",
    created_at: "2025-01-07T10:00:00.000Z",
    concepts: ["postgres", "connections", "pool-exhausted", "max-connections", "pgbouncer"],
  },
  {
    id: "mem-docker-restart-loop",
    summary: "Docker container restart loop with backoff",
    resolution: "CrashLoopBackOff due to a missing env var; fixed the compose env and the container stayed up.",
    created_at: "2025-01-08T10:00:00.000Z",
    concepts: ["docker", "container", "restart-loop", "crashloopbackoff", "config"],
  },
  {
    id: "mem-systemd-failed",
    summary: "systemd unit entered failed state after deploy",
    resolution: "journalctl showed a bad ExecStart path; corrected the unit file and daemon-reload, the service started.",
    created_at: "2025-01-09T10:00:00.000Z",
    concepts: ["systemd", "unit-failed", "execstart", "deploy", "journal"],
  },
  {
    id: "mem-port-conflict",
    summary: "bind: address already in use (EADDRINUSE)",
    resolution: "Another process held port 8080; killed the stale listener and the app bound successfully.",
    created_at: "2025-01-10T10:00:00.000Z",
    concepts: ["port-conflict", "eaddrinuse", "bind", "listener"],
  },
  {
    id: "mem-dns-apt",
    summary: "DNS resolution failure for apt mirrors",
    resolution: "resolv.conf pointed at a dead resolver; switched to a working nameserver and apt update succeeded.",
    created_at: "2025-01-11T10:00:00.000Z",
    concepts: ["dns", "resolver", "apt", "network", "nameserver"],
  },
  {
    id: "mem-memleak",
    summary: "Gradual memory leak in java service",
    resolution: "Heap dump showed a growing cache; cleared the cache and patched the leak, RSS stabilized.",
    created_at: "2025-01-12T10:00:00.000Z",
    concepts: ["memory", "leak", "heap", "java", "cache", "rss"],
  },
  {
    id: "mem-socket-permission",
    summary: "Permission denied on docker socket",
    resolution: "The agent user was not in the docker group; added the user and re-ran the command.",
    created_at: "2025-01-13T10:00:00.000Z",
    concepts: ["permissions", "docker-socket", "group", "access"],
  },
  {
    id: "mem-yum-lock",
    summary: "yum lock held by another process",
    resolution: "Killed the stale yum process holding /var/run/yum.pid and the transaction completed.",
    created_at: "2025-01-14T10:00:00.000Z",
    concepts: ["package-manager", "yum", "lock", "pid"],
  },
  {
    id: "mem-ext4-readonly",
    summary: "ext4 filesystem remounted read-only after I/O error",
    resolution: "dmesg showed I/O errors on sda; ran fsck in rescue mode and the filesystem remounted read-write.",
    created_at: "2025-01-15T10:00:00.000Z",
    concepts: ["filesystem", "io-error", "ext4", "fsck", "disk"],
  },
  {
    id: "mem-cpu-steal",
    summary: "High CPU steal time on virtualized host",
    resolution: "vmstat showed high st; noisy neighbor on the hypervisor, migrated the VM and steal dropped.",
    created_at: "2025-01-16T10:00:00.000Z",
    concepts: ["cpu", "steal", "virtualization", "hypervisor", "noisy-neighbor"],
  },
  {
    id: "mem-ssh-refused",
    summary: "SSH connection refused on port 22",
    resolution: "sshd was not listening; the service was stopped, started sshd and login worked.",
    created_at: "2025-01-17T10:00:00.000Z",
    concepts: ["ssh", "connection-refused", "sshd", "port", "service-down"],
  },
  {
    id: "mem-nodejs-heap",
    summary: "JavaScript heap out of memory in node app",
    resolution: "V8 OOM at 512MB heap; raised --max-old-space-size to 2048 and the app stabilized.",
    created_at: "2025-01-18T10:00:00.000Z",
    concepts: ["node", "heap", "oom", "memory", "v8", "limits"],
  },
  {
    id: "mem-nginx-504",
    summary: "504 Gateway Timeout from nginx upstream",
    resolution: "The app was slow and proxy_read_timeout was too low; raised it to 60s and 504s stopped.",
    created_at: "2025-01-19T10:00:00.000Z",
    concepts: ["nginx", "proxy", "http-504", "timeout", "slow-app"],
  },
];

export const QUERY_CASES: QueryCase[] = [
  // --- exact-keyword repeats (FTS already succeeds) ---
  {
    id: "q-exact-oom",
    query: "OOM killer terminated worker",
    kind: "exact",
    expected: ["mem-oom-worker"],
    concepts: ["linux", "kernel", "oom", "memory", "process-kill", "cgroup", "systemd"],
  },
  {
    id: "q-exact-enospc",
    query: "ENOSPC write failure root filesystem",
    kind: "exact",
    expected: ["mem-enospc-root"],
    concepts: ["disk", "full", "enospc", "root-partition", "cleanup", "docker"],
  },
  {
    id: "q-exact-502",
    query: "502 Bad Gateway nginx",
    kind: "exact",
    expected: ["mem-nginx-502"],
    concepts: ["nginx", "proxy", "http-502", "upstream-down", "container"],
  },
  {
    id: "q-exact-x509",
    query: "x509 certificate expired",
    kind: "exact",
    expected: ["mem-tls-expired"],
    concepts: ["tls", "certificate", "expired", "x509", "ingress", "renewal"],
  },
  {
    id: "q-exact-emfile",
    query: "too many open files EMFILE",
    kind: "exact",
    expected: ["mem-emfile"],
    concepts: ["file-descriptors", "emfile", "limits", "ulimit", "node", "restart"],
  },
  {
    id: "q-exact-pg",
    query: "PostgreSQL max_connections",
    kind: "exact",
    expected: ["mem-pg-maxconn"],
    concepts: ["postgres", "connections", "pool-exhausted", "max-connections", "pgbouncer"],
  },
  // --- paraphrase / synonym repeats (FTS vocabulary mismatch) ---
  {
    id: "q-paraphrase-oom",
    query: "container killed by Linux kernel memory pressure",
    kind: "paraphrase",
    expected: ["mem-oom-worker"],
    concepts: ["linux", "kernel", "oom", "memory", "process-kill", "container"],
  },
  {
    id: "q-paraphrase-502",
    query: "reverse proxy upstream connection refused",
    kind: "paraphrase",
    expected: ["mem-nginx-502"],
    concepts: ["nginx", "proxy", "upstream-down", "connection-refused", "http"],
  },
  {
    id: "q-paraphrase-enospc",
    query: "root partition 100% full",
    kind: "paraphrase",
    expected: ["mem-enospc-root"],
    concepts: ["disk", "full", "root-partition", "partition-100"],
  },
  {
    id: "q-paraphrase-tls",
    query: "TLS handshake failure on ingress",
    kind: "paraphrase",
    expected: ["mem-tls-expired"],
    concepts: ["tls", "handshake", "ingress", "certificate-problem"],
  },
  {
    id: "q-paraphrase-emfile",
    query: "EMFILE socket descriptor exhaustion",
    kind: "paraphrase",
    expected: ["mem-emfile"],
    concepts: ["file-descriptors", "emfile", "socket", "exhaustion", "limits"],
  },
  {
    id: "q-paraphrase-pg",
    query: "database connection pool exhausted",
    kind: "paraphrase",
    expected: ["mem-pg-maxconn"],
    concepts: ["postgres", "connections", "pool-exhausted", "database-client"],
  },
  {
    id: "q-paraphrase-docker",
    query: "container keeps restarting with backoff policy",
    kind: "paraphrase",
    expected: ["mem-docker-restart-loop"],
    concepts: ["docker", "container", "restart-loop", "backoff", "policy"],
  },
  {
    id: "q-paraphrase-systemd",
    query: "service unit failed to start after deploy",
    kind: "paraphrase",
    expected: ["mem-systemd-failed"],
    concepts: ["systemd", "unit-failed", "service-start", "deploy"],
  },
  {
    id: "q-paraphrase-nodeheap",
    query: "node process ran out of heap memory",
    kind: "paraphrase",
    expected: ["mem-nodejs-heap"],
    concepts: ["node", "heap", "oom", "memory", "process"],
  },
  {
    id: "q-paraphrase-dns",
    query: "cannot resolve package mirror hostnames",
    kind: "paraphrase",
    expected: ["mem-dns-apt"],
    concepts: ["dns", "resolve", "package-manager", "mirror", "apt"],
  },
  // --- negative / unrelated distractors ---
  {
    id: "q-distractor-printer",
    query: "office printer queue jammed",
    kind: "distractor",
    expected: [],
    concepts: ["printer", "office", "queue"],
  },
  {
    id: "q-distractor-coffee",
    query: "coffee machine not brewing in kitchen",
    kind: "distractor",
    expected: [],
    concepts: ["coffee", "kitchen", "appliance"],
  },
  {
    id: "q-distractor-wifi",
    query: "wifi captive portal login page not loading",
    kind: "distractor",
    expected: [],
    concepts: ["wifi", "captive-portal", "browser"],
  },
  {
    id: "q-distractor-slack",
    query: "slack notifications not delivered to channel",
    kind: "distractor",
    expected: [],
    concepts: ["slack", "notifications", "messaging"],
  },
];
