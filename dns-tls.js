'use strict';
// DNS records + TLS (cert-manager) for a newly installed cluster.
//
// Two DNS options, chosen at the start of the Install New Cluster wizard:
//   'consumer' - IONOS consumer DNS (api.hosting.ionos.com), the domain's zone lives in the IONOS DNS account.
//   'cloud'    - IONOS Cloud DNS (dns.de-fra.ionos.com). The wizard lists the contract's Cloud DNS zones (the delegated
//                domains) in a drop-down; the chosen zone becomes the base domain and the cluster's records
//                (<cluster>, api.<cluster>, api-int.<cluster>, *.apps.<cluster>) are created inside it.
//
// TLS: Red Hat cert-manager Operator + a DNS-01 webhook + a Let's Encrypt ClusterIssuer, then named
// certificates for the API server and the default ingress controller (what ocp1 uses), so the console and
// API present a valid certificate. The consumer path mirrors ocp1 exactly (custom fabmade webhook image,
// host-network pod, ionos-credentials secret). The Cloud DNS path uses the official ionos-cloud webhook
// (Helm chart) and has NOT been tested end-to-end yet.

const fetch = require('node-fetch');

const CERT_WEBHOOK_IMAGE_DEFAULT = 'ghcr.io/paul-mccutcheon-ionos/cert-manager-webhook-ionos:1.2.2-custom';
const CONSUMER_DNS_API = 'https://api.hosting.ionos.com/dns/v1';
const CLOUD_DNS_API    = 'https://dns.de-fra.ionos.com';
const KUBECONFIG_ON_MGMT = '/opt/ocp-install/auth/kubeconfig';
const ISSUER_NAME = 'letsencrypt-ionos';

// ── DNS ──────────────────────────────────────────────────────────────────────

async function consumerDns(cfg, method, p, body) {
  const r = await fetch(CONSUMER_DNS_API + p, {
    method,
    headers: { 'X-API-Key': `${cfg.keyPrefix}.${cfg.keySecret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`IONOS DNS API ${method} ${p} returned ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// records: [{ name: <fully qualified>, type, content, ttl }]
async function ensureConsumerRecords(cfg, records, log) {
  const zones = await consumerDns(cfg, 'GET', '/zones');
  const zone = (Array.isArray(zones) ? zones : []).find(z => z.name === cfg.domain);
  if (!zone) throw new Error(`DNS zone "${cfg.domain}" was not found in the IONOS DNS account (found: ${(zones || []).map(z => z.name).join(', ') || 'none'}).`);
  const full = await consumerDns(cfg, 'GET', `/zones/${zone.id}`);
  const existing = full.records || [];
  for (const rec of records) {
    const ex = existing.find(e => e.name === rec.name && e.type === rec.type);
    if (ex && ex.content === rec.content) { log(`  (exists) ${rec.type} ${rec.name} -> ${rec.content}\n`); continue; }
    if (ex) {
      await consumerDns(cfg, 'PUT', `/zones/${zone.id}/records/${ex.id}`, { name: rec.name, type: rec.type, content: rec.content, ttl: rec.ttl || 3600, disabled: false });
      log(`  (updated) ${rec.type} ${rec.name} -> ${rec.content}\n`);
    } else {
      await consumerDns(cfg, 'POST', `/zones/${zone.id}/records`, [{ name: rec.name, type: rec.type, content: rec.content, ttl: rec.ttl || 3600, disabled: false }]);
      log(`  (new)    ${rec.type} ${rec.name} -> ${rec.content}\n`);
    }
  }
  return { zoneName: cfg.domain, nameservers: [] };
}

async function cloudDnsApi(token, method, p, body) {
  const r = await fetch(CLOUD_DNS_API + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`IONOS Cloud DNS API ${method} ${p} returned ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// All Cloud DNS zones of the contract the token belongs to (paged). `delegated` says whether the public NS records of
// the zone already point at the IONOS name servers (true/false), or null when that could not be determined.
async function listCloudDnsZones(token) {
  const out = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await cloudDnsApi(token, 'GET', `/zones?limit=100&offset=${offset}`);
    const items = page.items || [];
    for (const z of items) {
      out.push({
        id: z.id, name: z.properties?.zoneName, enabled: z.properties?.enabled !== false,
        description: z.properties?.description || '', state: z.metadata?.state || '',
        nameservers: z.metadata?.nameservers || [],
      });
    }
    if (items.length < 100) break;
  }
  await Promise.all(out.map(async z => {
    z.delegated = null;
    if (!z.name || !z.nameservers.length) return;
    try {
      const have = (await require('dns').promises.resolveNs(z.name)).map(n => n.toLowerCase().replace(/\.$/, ''));
      const want = z.nameservers.map(n => n.toLowerCase().replace(/\.$/, ''));
      z.delegated = want.some(n => have.includes(n));
    } catch (_) { z.delegated = false; }
  }));
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

// Create/refresh the cluster's records inside an EXISTING (delegated) Cloud DNS zone. Record names are relative to the zone.
async function ensureCloudDnsRecords(cfg, zoneName, records, log) {
  const found = await cloudDnsApi(cfg.token, 'GET', `/zones?filter.zoneName=${encodeURIComponent(zoneName)}`);
  const zone = (found.items || []).find(z => z.properties?.zoneName === zoneName) || (found.items || [])[0];
  if (!zone) throw new Error(`Cloud DNS zone "${zoneName}" was not found in this contract. Pick one of the delegated domains from the list.`);
  log(`  Using Cloud DNS zone ${zoneName} (${zone.metadata?.state || 'state unknown'})
`);
  const zoneId = zone.id;
  const recs = await cloudDnsApi(cfg.token, 'GET', `/zones/${zoneId}/records?limit=1000`);
  const existing = recs.items || [];
  for (const rec of records) {
    const ex = existing.find(e => e.properties?.name === rec.name && e.properties?.type === rec.type);
    if (ex && ex.properties.content === rec.content) { log(`  (exists) ${rec.type} ${rec.name} -> ${rec.content}
`); continue; }
    if (ex) {
      await cloudDnsApi(cfg.token, 'PUT', `/zones/${zoneId}/records/${ex.id}`, { properties: { name: rec.name, type: rec.type, content: rec.content, ttl: rec.ttl || 3600, enabled: true } });
      log(`  (updated) ${rec.type} ${rec.name} -> ${rec.content}
`);
    } else {
      await cloudDnsApi(cfg.token, 'POST', `/zones/${zoneId}/records`, { properties: { name: rec.name, type: rec.type, content: rec.content, ttl: rec.ttl || 3600, enabled: true } });
      log(`  (new)    ${rec.type} ${rec.name} -> ${rec.content}
`);
    }
  }
  return { zoneName, nameservers: zone.metadata?.nameservers || [] };
}

// The DNS records a cluster needs. api-int points at the NLB public listener (the wizard's NLB has no
// private listener; nodes reach it through the NAT gateway). For Cloud DNS the names are relative to the chosen zone
// (= the base domain): <cluster>, api.<cluster>, api-int.<cluster>, *.apps.<cluster>.
function clusterDnsRecords(provider, clusterName, baseDomain, nlbPubIp) {
  const rel = ['@', 'api', 'api-int', '*.apps'];
  if (provider === 'cloud') return rel.map(n => ({ name: n === '@' ? clusterName : `${n}.${clusterName}`, type: 'A', content: nlbPubIp, ttl: 3600 }));
  const suffix = `${clusterName}.${baseDomain}`;
  return rel.map(n => ({ name: n === '@' ? suffix : `${n}.${suffix}`, type: 'A', content: nlbPubIp, ttl: 3600 }));
}

// Create/refresh the cluster's DNS records. opts: { provider, clusterName, baseDomain, nlbPubIp,
//   dnsDomain, dnsKeyPrefix, dnsKeySecret, ionosToken, cloudDnsZone }
async function ensureClusterDns(opts, log) {
  const provider = opts.provider === 'cloud' ? 'cloud' : 'consumer';
  const records = clusterDnsRecords(provider, opts.clusterName, opts.baseDomain, opts.nlbPubIp);
  if (provider === 'cloud') {
    if (!opts.ionosToken) throw new Error('IONOS Cloud DNS needs the IONOS API token.');
    const zoneName = (opts.cloudDnsZone || opts.baseDomain || '').trim();
    if (!zoneName) throw new Error('IONOS Cloud DNS: choose the delegated domain (zone) first.');
    if (zoneName !== opts.baseDomain) throw new Error(`The base domain (${opts.baseDomain}) must equal the chosen Cloud DNS zone (${zoneName}): the cluster is <name>.${zoneName}.`);
    const r = await ensureCloudDnsRecords({ token: opts.ionosToken }, zoneName, records, log);
    return { provider, zoneName: r.zoneName, nameservers: r.nameservers, records };
  }
  if (!opts.dnsKeyPrefix || !opts.dnsKeySecret) throw new Error('IONOS consumer DNS needs the DNS API key prefix and secret.');
  const domain = opts.dnsDomain || opts.baseDomain;
  const r = await ensureConsumerRecords({ keyPrefix: opts.dnsKeyPrefix, keySecret: opts.dnsKeySecret, domain }, records, log);
  return { provider, zoneName: r.zoneName, nameservers: [], records };
}

// ── cert-manager manifests ───────────────────────────────────────────────────

const q = v => JSON.stringify(String(v));   // a JSON string is a valid YAML double-quoted scalar

function operatorYaml() {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: cert-manager-operator
  labels:
    openshift.io/cluster-monitoring: "true"
---
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: openshift-cert-manager-operator
  namespace: cert-manager-operator
spec:
  targetNamespaces:
  - cert-manager-operator
  upgradeStrategy: Default
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: openshift-cert-manager-operator
  namespace: cert-manager-operator
spec:
  channel: stable-v1
  name: openshift-cert-manager-operator
  source: redhat-operators
  sourceNamespace: openshift-marketplace
  installPlanApproval: Automatic
`;
}

// Mirrors ocp1: custom fabmade webhook image, host-network pod using the operator's webhook service account.
function consumerWebhookYaml({ image, keyPrefix, keySecret }) {
  return `apiVersion: v1
kind: Secret
metadata:
  name: ionos-credentials
  namespace: cert-manager
type: Opaque
stringData:
  IONOS_PUBLIC_PREFIX: ${q(keyPrefix)}
  IONOS_SECRET: ${q(keySecret)}
---
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: cert-manager-webhook-ionos-selfsign
  namespace: cert-manager
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: cert-manager-webhook-ionos-webhook-tls
  namespace: cert-manager
spec:
  commonName: cert-manager-webhook-ionos.cert-manager.svc
  dnsNames:
  - cert-manager-webhook-ionos
  - cert-manager-webhook-ionos.cert-manager
  - cert-manager-webhook-ionos.cert-manager.svc
  - cert-manager-webhook-ionos.cert-manager.svc.cluster.local
  duration: 8760h
  renewBefore: 360h
  issuerRef:
    name: cert-manager-webhook-ionos-selfsign
  secretName: cert-manager-webhook-ionos-webhook-tls
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: secret-reader
  namespace: cert-manager
rules:
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: secret-reader
  namespace: cert-manager
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: secret-reader
subjects:
- kind: ServiceAccount
  name: cert-manager-webhook
  namespace: cert-manager
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: system:openshift:scc:hostnetwork
  namespace: cert-manager
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:openshift:scc:hostnetwork
subjects:
- kind: ServiceAccount
  name: cert-manager-webhook
  namespace: cert-manager
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cert-manager-webhook-ionos-solver
rules:
- apiGroups: ["acme.fabmade.de"]
  resources: ["*"]
  verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cert-manager-webhook-ionos-solver
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cert-manager-webhook-ionos-solver
subjects:
- kind: ServiceAccount
  name: cert-manager
  namespace: cert-manager
---
apiVersion: v1
kind: Service
metadata:
  name: cert-manager-webhook-ionos
  namespace: cert-manager
spec:
  type: ClusterIP
  selector:
    app: cert-manager-webhook-ionos
  ports:
  - port: 443
    protocol: TCP
    targetPort: 10443
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cert-manager-webhook-ionos
  namespace: cert-manager
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cert-manager-webhook-ionos
  template:
    metadata:
      labels:
        app: cert-manager-webhook-ionos
    spec:
      serviceAccountName: cert-manager-webhook
      hostNetwork: true
      dnsPolicy: ClusterFirst
      containers:
      - name: webhook
        image: ${q(image)}
        imagePullPolicy: IfNotPresent
        args:
        - --secure-port=10443
        - --tls-cert-file=/certs/tls.crt
        - --tls-private-key-file=/certs/tls.key
        env:
        - name: GROUP_NAME
          value: acme.fabmade.de
        - name: SECURE_PORT
          value: "10443"
        ports:
        - containerPort: 10443
          protocol: TCP
        volumeMounts:
        - name: certs
          mountPath: /certs
          readOnly: true
      volumes:
      - name: certs
        secret:
          secretName: cert-manager-webhook-ionos-webhook-tls
---
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1alpha1.acme.fabmade.de
  annotations:
    cert-manager.io/inject-ca-from: cert-manager/cert-manager-webhook-ionos-webhook-tls
spec:
  group: acme.fabmade.de
  version: v1alpha1
  groupPriorityMinimum: 1000
  versionPriority: 15
  service:
    name: cert-manager-webhook-ionos
    namespace: cert-manager
    port: 443
`;
}

function cloudWebhookSecretYaml({ token }) {
  return `apiVersion: v1
kind: Secret
metadata:
  name: cert-manager-webhook-ionos-cloud
  namespace: cert-manager
type: Opaque
stringData:
  auth-token: ${q(token)}
`;
}

function clusterIssuerYaml({ provider, email, staging }) {
  const server = staging ? 'https://acme-staging-v02.api.letsencrypt.org/directory' : 'https://acme-v02.api.letsencrypt.org/directory';
  const solver = provider === 'cloud'
    ? `        webhook:
          groupName: acme.ionos.com
          solverName: ionos-cloud
          config:
            secretRef: cert-manager-webhook-ionos-cloud
            authTokenSecretKey: auth-token`
    : `        webhook:
          groupName: acme.fabmade.de
          solverName: ionos
          config:
            apiUrl: ${CONSUMER_DNS_API}
            publicKeySecretRef:
              key: IONOS_PUBLIC_PREFIX
              name: ionos-credentials
            secretKeySecretRef:
              key: IONOS_SECRET
              name: ionos-credentials`;
  return `apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: ${ISSUER_NAME}
spec:
  acme:
    email: ${q(email)}
    server: ${server}
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
    - dns01:
${solver}
`;
}

function certificatesYaml({ clusterName, baseDomain }) {
  const apex = `${clusterName}.${baseDomain}`;
  return `apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-cert
  namespace: openshift-config
spec:
  commonName: api.${apex}
  dnsNames:
  - api.${apex}
  issuerRef:
    kind: ClusterIssuer
    name: ${ISSUER_NAME}
  secretName: api-cert-secret
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ingress-tls
  namespace: openshift-ingress
spec:
  dnsNames:
  - ${apex}
  - "*.apps.${apex}"
  duration: 2160h
  issuerRef:
    kind: ClusterIssuer
    name: ${ISSUER_NAME}
  secretName: ingress-tls-secret
`;
}

// ── DNS node-record sync (in-cluster CronJob) ────────────────────────────────
// Keeps one A record per node (<node>.<cluster>.<domain> -> InternalIP) in the cluster's DNS zone as nodes come and go
// (autoscaler, replacements). Runs inside the cluster so it keeps working with no one using this app. Plain Python
// (stdlib only): the cluster's CLI image has oc/curl/python3 but no jq. IONOS consumer DNS only (Cloud DNS is tested separately).
const DNS_SYNC_SCRIPT = `import json, os, ssl, sys, urllib.request, urllib.error
APEX = os.environ["CLUSTER_APEX"].lower()
ZONE = os.environ["DNS_ZONE"]
API = "https://api.hosting.ionos.com/dns/v1"
KEY = os.environ["DNS_API_KEY_PREFIX"] + "." + os.environ["DNS_API_KEY_SECRET"]
RESERVED = {APEX, "api." + APEX, "api-int." + APEX}

def dns(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=(json.dumps(body).encode() if body is not None else None),
                                 headers={"X-API-Key": KEY, "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            t = r.read().decode()
            return json.loads(t) if t.strip() else {}
    except urllib.error.HTTPError as e:
        raise SystemExit("IONOS DNS API %s %s -> %s %s" % (method, path, e.code, e.read().decode()[:200]))

def private(ip):
    p = ip.split(".")
    return len(p) == 4 and (p[0] == "10" or (p[0] == "172" and 16 <= int(p[1]) <= 31) or (p[0] == "192" and p[1] == "168"))

sa = "/var/run/secrets/kubernetes.io/serviceaccount/"
ctx = ssl.create_default_context(cafile=sa + "ca.crt")
rq = urllib.request.Request("https://kubernetes.default.svc/api/v1/nodes", headers={"Authorization": "Bearer " + open(sa + "token").read()})
nodes = json.load(urllib.request.urlopen(rq, context=ctx, timeout=30))["items"]
desired = {}
for n in nodes:
    ip = next((a["address"] for a in n["status"].get("addresses", []) if a["type"] == "InternalIP"), None)
    name = n["metadata"]["name"].lower()
    if ip:
        desired[name if name.endswith("." + APEX) else name + "." + APEX] = ip
if not desired:
    raise SystemExit("no nodes with an InternalIP found - refusing to change DNS")

zones = dns("GET", "/zones")
zone = next((z for z in zones if z["name"] == ZONE), None)
if not zone:
    raise SystemExit("DNS zone %s not found in the IONOS DNS account" % ZONE)
recs = dns("GET", "/zones/" + zone["id"]).get("records", [])

# records this job may manage: A records exactly one label under the cluster name, private IP, not reserved
depth = len(APEX.split(".")) + 1
managed = [r for r in recs if r["type"] == "A" and r["name"].endswith("." + APEX) and r["name"] not in RESERVED
           and len(r["name"].split(".")) == depth and not r["name"].startswith("*") and private(r["content"])]

for fq, ip in sorted(desired.items()):
    ex = next((r for r in recs if r["type"] == "A" and r["name"] == fq), None)
    if ex and ex["content"] == ip:
        print("unchanged", fq, ip)
    elif ex:
        dns("PUT", "/zones/%s/records/%s" % (zone["id"], ex["id"]), {"name": fq, "type": "A", "content": ip, "ttl": 3600, "disabled": False})
        print("updated  ", fq, ip, "(was %s)" % ex["content"])
    else:
        dns("POST", "/zones/%s/records" % zone["id"], [{"name": fq, "type": "A", "content": ip, "ttl": 3600, "disabled": False}])
        print("created  ", fq, ip)

stale = [r for r in managed if r["name"] not in desired]
if stale and len(stale) > max(2, len(managed) // 2):
    raise SystemExit("refusing to delete %d of %d node records in one run - check the cluster/DNS first" % (len(stale), len(managed)))
for r in stale:
    dns("DELETE", "/zones/%s/records/%s" % (zone["id"], r["id"]))
    print("deleted  ", r["name"], r["content"], "(no such node)")
print("done:", len(desired), "nodes,", len(stale), "stale record(s) removed")
`;

function dnsSyncYaml({ apex, zone, keyPrefix, keySecret, image }) {
  const indented = DNS_SYNC_SCRIPT.split('\n').map(l => '    ' + l).join('\n');
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ionos-dns-sync
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: dns-sync
  namespace: ionos-dns-sync
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ionos-dns-sync-nodes
rules:
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ionos-dns-sync-nodes
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ionos-dns-sync-nodes
subjects:
- kind: ServiceAccount
  name: dns-sync
  namespace: ionos-dns-sync
---
apiVersion: v1
kind: Secret
metadata:
  name: ionos-dns-credentials
  namespace: ionos-dns-sync
type: Opaque
stringData:
  DNS_API_KEY_PREFIX: ${q(keyPrefix)}
  DNS_API_KEY_SECRET: ${q(keySecret)}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ionos-dns-sync-script
  namespace: ionos-dns-sync
data:
  sync.py: |
${indented}
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ionos-dns-sync
  namespace: ionos-dns-sync
spec:
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 2
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: 240
      template:
        spec:
          serviceAccountName: dns-sync
          restartPolicy: Never
          containers:
          - name: sync
            image: ${q(image)}
            command: ["python3", "/scripts/sync.py"]
            env:
            - name: CLUSTER_APEX
              value: ${q(apex)}
            - name: DNS_ZONE
              value: ${q(zone)}
            envFrom:
            - secretRef:
                name: ionos-dns-credentials
            volumeMounts:
            - name: script
              mountPath: /scripts
          volumes:
          - name: script
            configMap:
              name: ionos-dns-sync-script
`;
}

// ── endpoint ─────────────────────────────────────────────────────────────────

// deps: { app, makeSseHelpers, clusterInstallState, sshConnect, sshRunScript, sshRunScriptStreaming }
function register(deps) {
  const { app, makeSseHelpers, clusterInstallState, sshConnect, sshRunScript, sshRunScriptStreaming } = deps;

  // POST /api/new-cluster/cloud-dns-zones { ionosToken } — the delegated domains (Cloud DNS zones) of the token's contract.
  app.post('/api/new-cluster/cloud-dns-zones', async (req, res) => {
    const token = String((req.body && req.body.ionosToken) || '').trim();
    if (!token) return res.status(400).json({ error: 'The IONOS API token is required.' });
    try { res.json({ zones: await listCloudDnsZones(token) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });

  // POST /api/new-cluster/configure-certs  (SSE)
  // Runs on the management VM with the cluster's admin kubeconfig. Idempotent (oc apply + waits).
  app.post('/api/new-cluster/configure-certs', async (req, res) => {
    const b = req.body || {};
    const { clusterName } = b;
    const saved = clusterInstallState.get(clusterName) || {};
    const { step, log, done, fail } = makeSseHelpers(res);

    const mgmtHost  = saved.infra?.mgmtPubIp || b.mgmtHost;
    const privKey   = b.mgmtSshPrivKey || saved.mgmtSshPrivKey;
    const baseDomain = b.baseDomain || saved.baseDomain;
    const provider  = b.dnsProvider === 'cloud' ? 'cloud' : 'consumer';
    const kubeconfig = b.kubeconfigPath || KUBECONFIG_ON_MGMT;
    const email     = (b.acmeEmail || `admin@${b.dnsDomain || baseDomain}`).trim();
    const staging   = !!b.acmeStaging;
    const image     = (b.certWebhookImage || CERT_WEBHOOK_IMAGE_DEFAULT).trim();
    const apex      = `${clusterName}.${baseDomain}`;

    if (!clusterName || !baseDomain) { fail('clusterName and baseDomain are required.'); return; }
    if (!mgmtHost || !privKey) { fail('Missing management host or SSH key (run the install phases first, or pass mgmtHost + mgmtSshPrivKey).'); return; }
    if (provider === 'consumer' && (!b.dnsApiKeyPrefix || !b.dnsApiKeySecret)) { fail('IONOS consumer DNS: the DNS API key prefix and secret are required.'); return; }
    if (provider === 'cloud' && !(b.ionosToken || saved.ionosToken)) { fail('IONOS Cloud DNS: the IONOS API token is required.'); return; }

    let conn;
    let kcCurrent = kubeconfig;
    const oc = script => sshRunScript(conn, `export KUBECONFIG=${kcCurrent}\n${script}`);
    const apply = yaml => oc(`oc apply -f - <<'MANIFEST_EOF'\n${yaml}\nMANIFEST_EOF`);
    // Poll `cmd` on the VM until its output matches `okRe`; log a progress line every ~30 s.
    const waitFor = async (label, cmd, okRe, timeoutSec, progressCmd) => {
      const deadline = Date.now() + timeoutSec * 1000;
      let n = 0;
      while (Date.now() < deadline) {
        let out = '';
        try { out = (await oc(cmd)).stdout.trim(); } catch (_) { out = ''; }
        if (okRe.test(out)) return out;
        if (n++ % 3 === 0) {
          let prog = '';
          if (progressCmd) { try { prog = (await oc(progressCmd)).stdout.trim().split('\n').slice(-3).join(' | '); } catch (_) {} }
          log(`  waiting for ${label}... ${prog}\n`);
        }
        await new Promise(r => setTimeout(r, 10000));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };

    try {
      conn = await sshConnect(mgmtHost, 'root', privKey);
      // The installer's admin kubeconfig trusts only the cluster's internal CA. Once the named Let's Encrypt
      // certificate is served for api.<cluster>.<domain>, `oc` with that file fails ("unknown authority"), so the
      // whole phase uses a copy that skips server verification (our own admin kubeconfig, private traffic).
      await sshRunScript(conn, `set -e
cp ${kubeconfig} /tmp/kc-skip-verify && chmod 600 /tmp/kc-skip-verify
sed -i '/certificate-authority-data:/d' /tmp/kc-skip-verify
CL=$(KUBECONFIG=/tmp/kc-skip-verify oc config view -o jsonpath='{.clusters[0].name}')
KUBECONFIG=/tmp/kc-skip-verify oc config set-cluster "$CL" --insecure-skip-tls-verify=true >/dev/null`);
      kcCurrent = '/tmp/kc-skip-verify';
      await oc('oc whoami >/dev/null 2>&1 || { echo "oc cannot reach the cluster with ' + kubeconfig + '"; exit 1; }');
      log(`Cluster ${apex} reachable. DNS option: ${provider === 'cloud' ? 'IONOS Cloud DNS (delegated domain)' : 'IONOS consumer DNS'}.\n`);

      step('Install cert-manager Operator for Red Hat OpenShift', 'running');
      await apply(operatorYaml());
      await waitFor('the operator to install', `oc -n cert-manager-operator get csv --no-headers 2>/dev/null | grep -i cert-manager | awk '{print $NF}'`, /Succeeded/, 900,
        `oc -n cert-manager-operator get csv,installplan --no-headers 2>&1 | cut -c1-120`);
      await waitFor('cert-manager deployments', `oc -n cert-manager get deploy cert-manager cert-manager-webhook cert-manager-cainjector -o jsonpath='{range .items[*]}{.status.availableReplicas}{"\\n"}{end}' 2>/dev/null | grep -c '^1$'`, /^3$/, 600,
        `oc -n cert-manager get deploy --no-headers 2>&1`);
      step('Install cert-manager Operator for Red Hat OpenShift', 'done');

      if (provider === 'consumer') {
        step('Deploy IONOS DNS-01 webhook (consumer DNS)', 'running');
        log(`  webhook image: ${image}\n`);
        await apply(consumerWebhookYaml({ image, keyPrefix: b.dnsApiKeyPrefix, keySecret: b.dnsApiKeySecret }));
        await waitFor('the webhook certificate', `oc -n cert-manager get certificate cert-manager-webhook-ionos-webhook-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null`, /True/, 300);
        await oc(`oc -n cert-manager rollout restart deploy/cert-manager-webhook-ionos >/dev/null 2>&1 || true`);
        await waitFor('the webhook pod', `oc -n cert-manager get deploy cert-manager-webhook-ionos -o jsonpath='{.status.availableReplicas}' 2>/dev/null`, /^1$/, 300,
          `oc -n cert-manager get pods -l app=cert-manager-webhook-ionos --no-headers 2>&1`);
        await waitFor('the webhook API service', `oc get apiservice v1alpha1.acme.fabmade.de -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null`, /True/, 300,
          `oc get apiservice v1alpha1.acme.fabmade.de --no-headers 2>&1`);
        step('Deploy IONOS DNS-01 webhook (consumer DNS)', 'done');
      } else {
        step('Deploy IONOS Cloud DNS webhook (Helm chart)', 'running');
        await apply(cloudWebhookSecretYaml({ token: b.ionosToken || saved.ionosToken }));
        await sshRunScriptStreaming(conn, `export KUBECONFIG=${kubeconfig}
set -e
command -v helm >/dev/null 2>&1 || { curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash >/dev/null 2>&1; }
helm repo add cert-manager-webhook-ionos-cloud https://ionos-cloud.github.io/cert-manager-webhook-ionos-cloud >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1
helm upgrade cert-manager-webhook-ionos-cloud --namespace cert-manager --install cert-manager-webhook-ionos-cloud/cert-manager-webhook-ionos-cloud 2>&1 | tail -3
`, chunk => log(chunk));
        await waitFor('the Cloud DNS webhook pod', `oc -n cert-manager get deploy -o name 2>/dev/null | grep -i ionos-cloud | head -1 | xargs -r -I{} oc -n cert-manager get {} -o jsonpath='{.status.availableReplicas}'`, /^[1-9]/, 300,
          `oc -n cert-manager get pods --no-headers 2>&1 | grep -i ionos`);
        step('Deploy IONOS Cloud DNS webhook (Helm chart)', 'done');
      }

      step("Create Let's Encrypt ClusterIssuer", 'running');
      log(`  ACME: ${staging ? 'STAGING (certificates will not be trusted by browsers)' : 'production'}, account e-mail ${email}\n`);
      await apply(clusterIssuerYaml({ provider, email, staging }));
      await waitFor('the ClusterIssuer', `oc get clusterissuer ${ISSUER_NAME} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null`, /True/, 300,
        `oc get clusterissuer ${ISSUER_NAME} -o jsonpath='{.status.conditions[*].message}' 2>&1`);
      step("Create Let's Encrypt ClusterIssuer", 'done');

      step('Request certificates (API server + ingress wildcard)', 'running');
      await apply(certificatesYaml({ clusterName, baseDomain }));
      await waitFor('the certificates (DNS-01 can take several minutes)',
        `a=$(oc -n openshift-config get certificate api-cert -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null); i=$(oc -n openshift-ingress get certificate ingress-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null); echo "$a/$i"`,
        /^True\/True$/, 1500,
        `oc get challenge -A --no-headers 2>&1 | cut -c1-160`);
      step('Request certificates (API server + ingress wildcard)', 'done');

      step('Apply certificates to the API server and the default ingress controller', 'running');
      await oc(`oc patch apiserver cluster --type=merge -p '{"spec":{"servingCerts":{"namedCertificates":[{"names":["api.${apex}"],"servingCertificate":{"name":"api-cert-secret"}}]}}}'
oc -n openshift-ingress-operator patch ingresscontroller default --type=merge -p '{"spec":{"defaultCertificate":{"name":"ingress-tls-secret"}}}'`);
      log('  APIServer and IngressController updated; waiting for the operators to roll the new certificates out...\n');
      // Give the kube-apiserver operator a moment to notice the change (Progressing=True) but do not require it:
      // nothing changes when the certificate was already applied (a rerun), and a rollout may already be in flight.
      await waitFor('the kube-apiserver operator to pick up the change', `oc get co kube-apiserver -o jsonpath='{.status.conditions[?(@.type=="Progressing")].status}' 2>/dev/null`, /True/, 90).catch(() => {});
      // Done when every node runs the latest revision AND the operator reports it is no longer progressing.
      await waitFor('the kube-apiserver rollout of the new certificate',
        `oc get kubeapiserver cluster -o jsonpath='{.status.latestAvailableRevision}{" "}{range .status.nodeStatuses[*]}{.currentRevision}{" "}{end}' 2>/dev/null | awk '{ok=1; for(i=2;i<=NF;i++) if($i!=$1) ok=0; print ok?"ROLLED":"WAIT"}'; oc get co kube-apiserver -o jsonpath='{.status.conditions[?(@.type=="Progressing")].status}' 2>/dev/null`,
        /ROLLED\s*False/, 1800, `oc get co kube-apiserver --no-headers 2>&1 | cut -c1-140`);
      await waitFor('cluster operators to settle', `oc get co --no-headers 2>/dev/null | awk '$3!="True"||$4!="False"||$5!="False"' | wc -l`, /^0$/, 1800,
        `oc get co --no-headers 2>/dev/null | awk '$3!="True"||$4!="False"||$5!="False"{print $1}' | tr '\\n' ' '`);
      step('Apply certificates to the API server and the default ingress controller', 'done');

      step('Verify the console and API certificates', 'running');
      // retry until both endpoints verify against the public CA store (the API server may still be rolling out)
      const chk = `c=$(curl -s -o /dev/null -w '%{ssl_verify_result}' -m 20 https://console-openshift-console.apps.${apex}/ || echo x); a=$(curl -s -o /dev/null -w '%{ssl_verify_result}' -m 20 https://api.${apex}:6443/readyz || echo x); echo "console=$c api=$a"`;
      await waitFor('the console and API certificates to verify against public CAs', chk, /console=0 api=0/, 900);
      const v = await oc(`curl -s -o /dev/null -w 'console: verify=%{ssl_verify_result} http=%{http_code}\\n' -m 20 https://console-openshift-console.apps.${apex}/
curl -s -o /dev/null -w 'api:     verify=%{ssl_verify_result} http=%{http_code}\\n' -m 20 https://api.${apex}:6443/readyz
echo | openssl s_client -connect console-openshift-console.apps.${apex}:443 -servername console-openshift-console.apps.${apex} 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null
# a kubeconfig without the embedded internal CA, for people: it validates against public CAs (the Let's Encrypt API certificate)
cp ${kubeconfig} ${kubeconfig}.letsencrypt && sed -i '/certificate-authority-data:/d' ${kubeconfig}.letsencrypt && echo "kubeconfig for public-CA trust: ${kubeconfig}.letsencrypt"`);
      log(v.stdout.split('\n').map(l => '  ' + l).join('\n') + '\n');
      step('Verify the console and API certificates', 'done');

      // Keep one A record per node in the DNS zone, continuously (CronJob inside the cluster).
      step('Install the DNS node-record sync (every 5 min)', 'running');
      if (provider !== 'consumer') {
        log('  Skipped: the node-record sync is implemented for IONOS consumer DNS only (Cloud DNS is tested separately).\n');
      } else {
        const cliImage = (await oc(`oc adm release info --image-for=cli 2>/dev/null`)).stdout.trim();
        if (!/^[A-Za-z0-9._:\/@-]+$/.test(cliImage)) throw new Error('could not determine the cluster CLI image for the DNS sync job');
        await apply(dnsSyncYaml({ apex, zone: b.dnsDomain || baseDomain, keyPrefix: b.dnsApiKeyPrefix, keySecret: b.dnsApiKeySecret, image: cliImage }));
        await oc(`oc -n ionos-dns-sync delete job ionos-dns-sync-now --ignore-not-found >/dev/null 2>&1; oc -n ionos-dns-sync create job ionos-dns-sync-now --from=cronjob/ionos-dns-sync`);
        await waitFor('the first DNS sync run', `oc -n ionos-dns-sync get job ionos-dns-sync-now -o jsonpath='{.status.succeeded}{"/"}{.status.failed}' 2>/dev/null`, /^(1\/|\/1|1\/\d)/, 300);
        const synced = await oc(`oc -n ionos-dns-sync logs job/ionos-dns-sync-now 2>&1 | tail -25`);
        log(synced.stdout.split('\n').map(l => '  ' + l).join('\n') + '\n');
        if (/Traceback|refusing|IONOS DNS API|not found in the IONOS/.test(synced.stdout)) throw new Error('the DNS sync run reported an error (see the log above)');
      }
      step('Install the DNS node-record sync (every 5 min)', 'done');

      clusterInstallState.set(clusterName, { ...(clusterInstallState.get(clusterName) || saved), certsConfigured: true, certProvider: provider });
      done('TLS certificates configured', { apex, provider, staging, issuer: ISSUER_NAME, consoleUrl: `https://console-openshift-console.apps.${apex}` });
    } catch (e) {
      fail(`TLS configuration failed: ${e.message}`);
    } finally {
      if (conn) try { conn.end(); } catch (_) {}
    }
  });
}

module.exports = {
  CERT_WEBHOOK_IMAGE_DEFAULT, ensureClusterDns, clusterDnsRecords,
  operatorYaml, consumerWebhookYaml, cloudWebhookSecretYaml, clusterIssuerYaml, certificatesYaml,
  register,
};
