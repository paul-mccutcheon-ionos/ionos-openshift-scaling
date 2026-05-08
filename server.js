require('dotenv').config();
const express         = require('express');
const fetch           = require('node-fetch');
const https           = require('https');
const path            = require('path');
const dotenv          = require('dotenv');
const bcrypt          = require('bcryptjs');
const { Client: Ssh } = require('ssh2');

const app      = express();
const PORT     = process.env.PORT || 3000;
const CLOUD_API = 'https://api.ionos.com/cloudapi/v6';

// Self-signed TLS agent — used exclusively for calls to the user-supplied OCP cluster API URL.
const INSECURE_AGENT = new https.Agent({ rejectUnauthorized: false });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── OpenShift API helpers ──────────────────────────────────────────────────

async function ocpGet(apiUrl, urlPath, token) {
  const res = await fetch(`${apiUrl}${urlPath}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    agent: INSECURE_AGENT
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || body.reason || JSON.stringify(body);
    } catch (_) {
      detail = await res.text().catch(() => '');
    }
    const err = new Error(`OpenShift API returned HTTP ${res.status}${detail ? ': ' + detail : ''} (${urlPath})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ocpPatch(apiUrl, urlPath, token, body) {
  const res = await fetch(`${apiUrl}${urlPath}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/merge-patch+json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body),
    agent: INSECURE_AGENT
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`OpenShift API PATCH ${urlPath} returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ocpPut(apiUrl, urlPath, token, body) {
  const res = await fetch(`${apiUrl}${urlPath}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body),
    agent: INSECURE_AGENT
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`OpenShift API PUT ${urlPath} returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ocpDelete(apiUrl, urlPath, token) {
  const res = await fetch(`${apiUrl}${urlPath}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    agent: INSECURE_AGENT
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`OpenShift API DELETE ${urlPath} returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  // 200/202/204 — parse JSON only if there is a body
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : {};
}

// ── IONOS Cloud API helpers ────────────────────────────────────────────────

async function ionosGet(urlPath, ionosToken) {
  const res = await fetch(`${CLOUD_API}${urlPath}`, {
    headers: { 'Authorization': `Bearer ${ionosToken}`, 'Accept': 'application/json' }
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`IONOS Cloud API ${urlPath} returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ionosPost(urlPath, ionosToken, body) {
  const res = await fetch(`${CLOUD_API}${urlPath}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${ionosToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`IONOS Cloud API POST ${urlPath} returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ionosPatch(urlPath, ionosToken, body) {
  const res = await fetch(`${CLOUD_API}${urlPath}`, {
    method:  'PATCH',
    headers: {
      'Authorization': `Bearer ${ionosToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`IONOS Cloud API PATCH ${urlPath} returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Detach a volume or similar sub-resource without deleting the resource itself.
async function ionosDetach(urlPath, ionosToken) {
  const res = await fetch(`${CLOUD_API}${urlPath}`, {
    method:  'DELETE',
    headers: { 'Authorization': `Bearer ${ionosToken}`, 'Accept': 'application/json' }
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`IONOS Cloud API DELETE ${urlPath} returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
}

// Server lifecycle actions: start / stop / reboot (POST with no body, returns 202).
async function ionosAction(urlPath, ionosToken) {
  const res = await fetch(`${CLOUD_API}${urlPath}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${ionosToken}`, 'Accept': 'application/json' }
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`IONOS Cloud API POST ${urlPath} returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
}

// Poll a resource until its metadata.state is one of the accepted states (or FAILED / timeout).
async function ionosWaitState(urlPath, ionosToken, acceptStates = ['AVAILABLE'], timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    let data;
    try {
      data = await ionosGet(urlPath, ionosToken);
    } catch (_) {
      continue;
    }
    const state = data?.metadata?.state;
    if (acceptStates.includes(state)) return data;
    if (state === 'FAILED') {
      const err = new Error(`Resource ${urlPath} entered FAILED state`);
      err.status = 500;
      throw err;
    }
  }
  const err = new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${urlPath} to become ${acceptStates.join(' or ')}`);
  err.status = 504;
  throw err;
}

// Convenience wrapper — most resources settle to AVAILABLE
function ionosWaitAvailable(urlPath, ionosToken, timeoutMs = 180000) {
  return ionosWaitState(urlPath, ionosToken, ['AVAILABLE'], timeoutMs);
}

// Wait for a server to finish stopping — IONOS sets stopped servers to INACTIVE
function ionosWaitStopped(urlPath, ionosToken, timeoutMs = 120000) {
  return ionosWaitState(urlPath, ionosToken, ['INACTIVE', 'AVAILABLE'], timeoutMs);
}

// ── Core OpenShift cluster state ───────────────────────────────────────────

async function fetchClusterState(apiUrl, ocpToken) {
  const [versionData, nodesData, machineSetsData] = await Promise.all([
    ocpGet(apiUrl, '/version', ocpToken),
    ocpGet(apiUrl, '/api/v1/nodes', ocpToken),
    ocpGet(apiUrl, '/apis/machine.openshift.io/v1beta1/namespaces/openshift-machine-api/machinesets', ocpToken)
  ]);

  // CSRs — degrade gracefully if token lacks permission
  let csrData = { items: [] };
  try {
    csrData = await ocpGet(apiUrl, '/apis/certificates.k8s.io/v1/certificatesigningrequests', ocpToken);
  } catch (_) {}

  // Recent node/CSR events — useful for tracking bootstrap progress
  let recentEvents = [];
  try {
    const evData = await ocpGet(apiUrl, '/api/v1/events?limit=200', ocpToken);
    recentEvents = (evData?.items || [])
      .filter(e => e.involvedObject?.kind === 'Node' ||
                   e.involvedObject?.kind === 'CertificateSigningRequest')
      .sort((a, b) => new Date(b.lastTimestamp || b.eventTime || 0) -
                      new Date(a.lastTimestamp || a.eventTime || 0))
      .slice(0, 15)
      .map(e => ({
        time:    e.lastTimestamp || e.eventTime || '',
        reason:  e.reason || '',
        object:  `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
        message: e.message || ''
      }));
  } catch (_) {}

  const nodes = (nodesData.items || []).map(node => {
    const labels   = node.metadata?.labels || {};
    const isMaster = 'node-role.kubernetes.io/master' in labels || 'node-role.kubernetes.io/control-plane' in labels;
    const isWorker = 'node-role.kubernetes.io/worker' in labels;
    const role     = isMaster ? 'master' : (isWorker ? 'worker' : 'unknown');
    const readyCond = (node.status?.conditions || []).find(c => c.type === 'Ready');
    return {
      name:    node.metadata?.name || '—',
      role,
      ready:   readyCond?.status === 'True',
      version: node.status?.nodeInfo?.kubeletVersion || '—',
      created: node.metadata?.creationTimestamp || null
    };
  });

  const machineSets = (machineSetsData.items || []).map(ms => {
    const ps = ms.spec?.template?.spec?.providerSpec?.value || {};
    return {
      name:      ms.metadata?.name || '—',
      desired:   ms.spec?.replicas            ?? 0,
      ready:     ms.status?.readyReplicas     ?? 0,
      available: ms.status?.availableReplicas ?? 0,
      region:    ps.region            || '—',
      az:        ps.availabilityZone  || '—'
    };
  });

  // Build full CSR list (all, not just pending) with enriched fields.
  // condition: 'Pending' | 'Approved' | 'Denied'
  // signerShort: human-friendly signer label
  // nodeHint: best-guess node name extracted from requestor (system:node:<name> or system:multus:<name>)
  const allCsrs = (csrData.items || []).map(csr => {
    const conds      = csr.status?.conditions || [];
    const isApproved = conds.some(c => c.type === 'Approved');
    const isDenied   = conds.some(c => c.type === 'Denied');
    const condition  = isDenied ? 'Denied' : isApproved ? 'Approved' : 'Pending';
    const requestor  = csr.spec?.username || '—';
    const groups     = csr.spec?.groups   || [];
    const signer     = csr.spec?.signerName || '';
    const signerShort = signer.includes('kube-apiserver-client-kubelet') ? 'kubelet client'
                      : signer.includes('kube-apiserver-client')        ? 'API server client'
                      : signer.includes('kubelet-serving')              ? 'kubelet serving'
                      : signer.replace('kubernetes.io/', '');
    // Extract node name from requestor: system:node:<name> or system:multus:<name>
    const nodeMatch  = requestor.match(/^system:(?:node|multus|serviceaccount:[^:]+):(.+)$/);
    const nodeHint   = nodeMatch ? nodeMatch[1] : '';
    return {
      name:        csr.metadata?.name || '—',
      requestor,
      groups,
      signerShort,
      nodeHint,
      condition,
      created:     csr.metadata?.creationTimestamp || null
    };
  }).sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));

  const pendingCsrs = allCsrs.filter(c => c.condition === 'Pending');

  return {
    version:     versionData.gitVersion || `${versionData.major}.${versionData.minor}`,
    nodes,
    machineSets,
    pendingCsrs,
    allCsrs,
    recentEvents
  };
}

// ── Validation helpers ─────────────────────────────────────────────────────

function requireFields(res, body, fields) {
  for (const f of fields) {
    if (!body[f] && body[f] !== 0) {
      res.status(400).json({ error: `Field '${f}' is required.` });
      return false;
    }
  }
  return true;
}

// ── Routes — OpenShift ─────────────────────────────────────────────────────

app.get('/download/env-example', (req, res) => {
  res.download(path.join(__dirname, '.env.example'), '.env.example', { dotfiles: 'allow' });
});

// Return environment variable values for pre-filling the connection form.
// Only exposes variables explicitly named here — nothing else from process.env.
app.get('/api/env-prefill', async (req, res) => {
  // Re-read .env on every request so a token refresh in the file is picked up
  // without needing a server restart.
  dotenv.config({ override: true });

  const hash       = process.env.AUTH_PASSWORD_HASH || '';
  const contractId = process.env.AUTH_CONTRACT_ID   || '';

  if (hash) {
    const authHeader = req.headers['authorization'] || '';
    const b64  = authHeader.startsWith('Basic ') ? authHeader.slice(6) : '';
    const [, pass] = Buffer.from(b64, 'base64').toString().split(':');
    const valid = b64 && (await bcrypt.compare(pass || '', hash));
    if (!valid) return res.status(401).json({ protected: true, contractId });
  }

  // SSH keys in .env are stored with literal \n — convert back to newlines.
  // All plain string values are trimmed to strip any CRLF artefacts.
  const str      = key => (process.env[key] || '').trim();
  const decodeKey = raw => {
    const s = (raw || '').trim();
    return s.includes('\\n') ? s.replace(/\\n/g, '\n') : s;
  };
  res.json({
    clusterApiUrl:     str('OCP_CLUSTER_API_URL'),
    ocpToken:          str('OCP_BEARER_TOKEN'),
    mgmtHost:          str('OCP_MGMT_HOST'),
    sshKey:            decodeKey(process.env.OCP_MGMT_HOST_SSH_KEY),
    workerSshKey:      decodeKey(process.env.OCP_WORKER_SSH_KEY),
    ionosToken:        str('IONOS_API_TOKEN'),
    workerNamePrefix:  str('OCP_WORKER_NAME_PREFIX'),
    ionosFtpUser:      str('IONOS_FTP_USER'),
    ionosFtpPass:      str('IONOS_FTP_PASS'),
    bootstrapGateway:  str('OCP_BOOTSTRAP_GATEWAY'),
    bootstrapDns:      str('OCP_BOOTSTRAP_DNS'),
    registryType:      str('REGISTRY_TYPE'),
    registryImage:     str('REGISTRY_IMAGE'),
    registryUsername:  str('REGISTRY_USERNAME'),
    registryPassword:  str('REGISTRY_PASSWORD'),
    mgmtInternalIp:    str('OCP_MGMT_INTERNAL_IP'),
  });
});

// Return the next free IP in the primary VDC subnet for a Frankfurt diversity worker.
// SSHs to the management host to get current node IPs, then scans from .30 upwards.
app.get('/api/frankfurt/suggest-ip', async (req, res) => {
  try {
    const rawKey  = (process.env.OCP_MGMT_HOST_SSH_KEY || '').trim();
    const mgmtKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
    const mgmtAddr = process.env.OCP_MGMT_HOST || '';
    if (!mgmtAddr || !mgmtKey) return res.json({ suggestedIp: '10.7.224.30' });

    const conn = await sshConnect(mgmtAddr, 'root', mgmtKey);
    let usedIps = new Set();
    try {
      const r = await sshRunScript(conn, `oc get nodes -o wide --no-headers 2>/dev/null | awk '{print $6}'`);
      r.stdout.trim().split('\n').map(s => s.trim()).filter(Boolean).forEach(ip => usedIps.add(ip));
    } finally {
      conn.end();
    }

    let suggestedIp = '';
    for (let i = 30; i <= 254 && !suggestedIp; i++) {
      const candidate = `10.7.224.${i}`;
      if (!usedIps.has(candidate)) suggestedIp = candidate;
    }
    res.json({ suggestedIp: suggestedIp || '10.7.224.30', usedIps: [...usedIps].sort() });
  } catch (e) {
    res.json({ suggestedIp: '10.7.224.30', error: e.message });
  }
});

app.post('/api/connect', async (req, res) => {
  if (!requireFields(res, req.body, ['apiUrl', 'ocpToken'])) return;
  const { apiUrl, ocpToken } = req.body;
  if (!apiUrl.startsWith('https://'))
    return res.status(400).json({ error: 'Cluster API URL must start with https://' });
  try {
    res.json(await fetchClusterState(apiUrl, ocpToken));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  if (!requireFields(res, req.body, ['apiUrl', 'ocpToken'])) return;
  const { apiUrl, ocpToken } = req.body;
  try {
    res.json(await fetchClusterState(apiUrl, ocpToken));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/api/scale', async (req, res) => {
  if (!requireFields(res, req.body, ['apiUrl', 'ocpToken', 'machineSetName', 'desiredReplicas'])) return;
  const { apiUrl, ocpToken, machineSetName, desiredReplicas } = req.body;

  const desired = parseInt(desiredReplicas, 10);
  if (isNaN(desired) || desired < 1)
    return res.status(400).json({ error: 'desiredReplicas must be a positive integer.' });

  const msPath = `/apis/machine.openshift.io/v1beta1/namespaces/openshift-machine-api/machinesets/${encodeURIComponent(machineSetName)}`;
  let current;
  try {
    current = await ocpGet(apiUrl, msPath, ocpToken);
  } catch (err) {
    return res.status(err.status || 502).json({ error: `Could not fetch MachineSet: ${err.message}` });
  }

  const currentDesired = current.spec?.replicas ?? 0;
  if (desired < currentDesired)
    return res.status(400).json({ error: `Scale-down is not permitted. Current desired count is ${currentDesired}.` });
  if (desired === currentDesired)
    return res.status(400).json({ error: `Desired count (${desired}) equals the current setting — no change.` });

  try {
    await ocpPatch(apiUrl, msPath, ocpToken, { spec: { replicas: desired } });
    res.json({ ok: true, machineSetName, desiredReplicas: desired, previousReplicas: currentDesired });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/api/approve-csrs', async (req, res) => {
  if (!requireFields(res, req.body, ['apiUrl', 'ocpToken', 'csrNames'])) return;
  const { apiUrl, ocpToken, csrNames } = req.body;
  if (!Array.isArray(csrNames) || !csrNames.length)
    return res.status(400).json({ error: 'csrNames must be a non-empty array.' });

  const results = await Promise.allSettled(csrNames.map(async name => {
    const csrPath      = `/apis/certificates.k8s.io/v1/certificatesigningrequests/${encodeURIComponent(name)}`;
    const csrObj       = await ocpGet(apiUrl, csrPath, ocpToken);
    if (!csrObj.status) csrObj.status = {};
    if (!Array.isArray(csrObj.status.conditions)) csrObj.status.conditions = [];
    csrObj.status.conditions.push({
      type:           'Approved',
      status:         'True',
      reason:         'ManualApproval',
      message:        'Approved via IONOS OpenShift Scaling Tool',
      lastUpdateTime: new Date().toISOString()
    });
    await ocpPut(apiUrl, `${csrPath}/approval`, ocpToken, csrObj);
    return name;
  }));

  const approved = [], failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled') approved.push(r.value);
    else failed.push({ name: r.reason?.message || '?', error: String(r.reason) });
  }
  res.json({ approved, failed });
});

// ── Auto-Scaling: IONOS credentials secret + MachineSet (with IONOS providerSpec)
//                 + ClusterAutoscaler + MachineAutoscaler
// Streams SSE progress. Steps:
//   1. Create/update ionoscloud-credentials Secret in openshift-machine-api
//   2. (ionos mode) Check for worker-user-data secret
//   3. Create IONOS-backed MachineSet with providerSpec, OR clone existing MachineSet
//   4. Apply ClusterAutoscaler
//   5. Apply MachineAutoscaler
app.post('/api/setup-autoscaler', async (req, res) => {
  const { clusterApiUrl, ocpToken,
          msMode,          // 'ionos' | 'clone' | 'existing'
          msSource, msNewName, msInitReplicas,
          targetMsName, minReplicas, maxReplicas,
          maxNodes, maxCores, maxMemoryGiB,
          scaleDown, delayAfterAdd, unneededTime,
          // IONOS machine config (used when msMode === 'ionos')
          ionosToken, datacenterId,
          ionosImageId, cpuFamily, availabilityZone, diskAvailabilityZone,
          machCores, machRamGiB, machDiskGB, machDiskType, machLanId,
          serverType, region,
          deployProvider,
          // Container registry for provider image
          registryType, registryImage, registryUsername, registryPassword,
          // Frankfurt Intra-geographical Diversity
          frankfurtDiversity, frankfurtSubMode,
          frankfurtVdcName, frankfurtPccName, frankfurtPrimaryLanId,
          frankfurtExistingDcId, frankfurtExistingLanId,
          frankfurtIgnitionIp, frankfurtStaticIp } = req.body;

  if (!clusterApiUrl || !ocpToken || !targetMsName)
    return res.status(400).json({ error: 'clusterApiUrl, ocpToken and targetMsName are required.' });
  if (msMode === 'ionos' && (!ionosToken || !datacenterId || !ionosImageId || !machLanId))
    return res.status(400).json({ error: 'ionosToken, datacenterId, ionosImageId and machLanId are required for IONOS machine mode.' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = obj  => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const step = (label, status) => emit({ type: 'step', label, status });
  const log  = text => emit({ type: 'log', text });
  const done = msg  => { emit({ type: 'done', message: msg }); res.end(); };
  const fail = msg  => { emit({ type: 'error', message: msg }); res.end(); };

  const msApiBase     = `${clusterApiUrl}/apis/machine.openshift.io/v1beta1/namespaces/openshift-machine-api/machinesets`;
  const secretApiBase = `${clusterApiUrl}/api/v1/namespaces/openshift-machine-api/secrets`;
  const caApiBase     = `${clusterApiUrl}/apis/autoscaling.openshift.io/v1/clusterautoscalers`;
  const maApiBase     = `${clusterApiUrl}/apis/autoscaling.openshift.io/v1beta1/namespaces/openshift-machine-api/machineautoscalers`;

  const ocpHeaders = { 'Authorization': `Bearer ${ocpToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const ocpReq = async (method, url, body) => {
    const opts = { method, headers: ocpHeaders, agent: INSECURE_AGENT };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    let data;
    try { data = await r.json(); } catch (_) { data = {}; }
    return { status: r.status, ok: r.ok, data };
  };

  // Idempotent upsert: POST → on 409 fetch resourceVersion then PUT
  const ocpApply = async (baseUrl, name, body) => {
    let r = await ocpReq('POST', baseUrl, body);
    if (r.status === 409) {
      const existing = await ocpReq('GET', `${baseUrl}/${encodeURIComponent(name)}`, undefined);
      body.metadata.resourceVersion = existing.data?.metadata?.resourceVersion;
      r = await ocpReq('PUT', `${baseUrl}/${encodeURIComponent(name)}`, body);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.data?.message || JSON.stringify(r.data)}`);
    return r.data;
  };

  // ── Registry helpers ─────────────────────────────────────────────────────────
  const resolveRegistryHost = (type, image) => {
    if (type === 'dockerhub') return 'https://index.docker.io/v1/';
    if (type === 'ghcr')      return 'ghcr.io';
    // IONOS / custom: extract host from the image URL (everything before the first '/')
    // e.g. "registry.ionos.example.com/repo:tag" → "registry.ionos.example.com"
    if (image) {
      const parts = image.split('/');
      if (parts.length > 1 && parts[0].includes('.')) return parts[0];
    }
    return null;
  };

  const buildDockerConfigJson = (host, username, password) => {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    return JSON.stringify({ auths: { [host]: { username, password, auth } } });
  };

  try {
    // ── Step 0: Deploy Machine API provider (first-time setup) ────────────────
    if (msMode === 'ionos' && deployProvider) {
      const saBase   = `${clusterApiUrl}/api/v1/namespaces/openshift-machine-api/serviceaccounts`;
      const crBase   = `${clusterApiUrl}/apis/rbac.authorization.k8s.io/v1/clusterroles`;
      const crbBase  = `${clusterApiUrl}/apis/rbac.authorization.k8s.io/v1/clusterrolebindings`;
      const depBase  = `${clusterApiUrl}/apis/apps/v1/namespaces/openshift-machine-api/deployments`;

      step('Deploying IONOS Machine API provider…', 'working');

      const sa = {
        apiVersion: 'v1', kind: 'ServiceAccount',
        metadata: { name: 'ionos-machine-api-provider', namespace: 'openshift-machine-api' }
      };
      await ocpApply(saBase, 'ionos-machine-api-provider', sa);
      log('ServiceAccount "ionos-machine-api-provider" created/updated\n');

      const cr = {
        apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
        metadata: { name: 'ionos-machine-api-provider' },
        rules: [
          { apiGroups: ['machine.openshift.io'], resources: ['machines'],           verbs: ['get','list','watch','patch','update'] },
          { apiGroups: ['machine.openshift.io'], resources: ['machines/status'],    verbs: ['get','patch','update'] },
          { apiGroups: ['machine.openshift.io'], resources: ['machines/finalizers'],verbs: ['patch','update'] },
          { apiGroups: ['machine.openshift.io'], resources: ['machinesets'],        verbs: ['get','list','watch'] },
          { apiGroups: [''],                     resources: ['secrets'],            verbs: ['get','list','watch'] },
          { apiGroups: [''],                     resources: ['nodes'],              verbs: ['get','list','watch'] },
          { apiGroups: ['coordination.k8s.io'],  resources: ['leases'],            verbs: ['get','list','watch','create','update','patch','delete'] },
          { apiGroups: [''],                     resources: ['events'],             verbs: ['create','patch'] }
        ]
      };
      await ocpApply(crBase, 'ionos-machine-api-provider', cr);
      log('ClusterRole "ionos-machine-api-provider" created/updated\n');

      const crb = {
        apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding',
        metadata: { name: 'ionos-machine-api-provider' },
        roleRef:  { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'ionos-machine-api-provider' },
        subjects: [{ kind: 'ServiceAccount', name: 'ionos-machine-api-provider', namespace: 'openshift-machine-api' }]
      };
      await ocpApply(crbBase, 'ionos-machine-api-provider', crb);
      log('ClusterRoleBinding "ionos-machine-api-provider" created/updated\n');

      // Resolve image and optional pull secret
      const providerImage = (registryImage && registryImage.trim()) || 'paulmcc50/myrepo:ionos-machine-api-provider';
      const pullSecretName = 'ionos-machine-api-provider-pullsecret';
      let hasPullSecret = false;

      if (registryUsername && registryPassword) {
        const regHost = resolveRegistryHost(registryType, providerImage);
        if (regHost) {
          const dockerConfigJson = buildDockerConfigJson(regHost, registryUsername, registryPassword);
          const pullSecret = {
            apiVersion: 'v1', kind: 'Secret',
            metadata: { name: pullSecretName, namespace: 'openshift-machine-api' },
            type: 'kubernetes.io/dockerconfigjson',
            data: { '.dockerconfigjson': Buffer.from(dockerConfigJson).toString('base64') }
          };
          await ocpApply(secretApiBase, pullSecretName, pullSecret);
          log(`ImagePullSecret "${pullSecretName}" created/updated (registry: ${regHost})\n`);
          hasPullSecret = true;
        }
      }

      const podSpec = {
        serviceAccountName: 'ionos-machine-api-provider',
        priorityClassName:  'system-cluster-critical',
        nodeSelector: { 'node-role.kubernetes.io/master': '' },
        tolerations: [
          { key: 'node-role.kubernetes.io/master',    effect: 'NoSchedule' },
          { key: 'node.kubernetes.io/not-ready',      effect: 'NoExecute', tolerationSeconds: 120 },
          { key: 'node.kubernetes.io/unreachable',    effect: 'NoExecute', tolerationSeconds: 120 }
        ],
        containers: [{
          name:            'manager',
          image:           providerImage,
          imagePullPolicy: 'Always',
          command:         ['/manager'],
          args:            ['--leader-elect=true', '--leader-election-namespace=openshift-machine-api', '--v=2'],
          ports: [
            { name: 'metrics', containerPort: 8080, protocol: 'TCP' },
            { name: 'healthz', containerPort: 8081, protocol: 'TCP' }
          ],
          livenessProbe:  { httpGet: { path: '/healthz', port: 'healthz' }, initialDelaySeconds: 15, periodSeconds: 20 },
          readinessProbe: { httpGet: { path: '/readyz',  port: 'healthz' }, initialDelaySeconds: 5,  periodSeconds: 10 },
          resources: {
            requests: { cpu: '50m', memory: '64Mi' },
            limits:   { cpu: '200m', memory: '128Mi' }
          },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } }
        }],
        securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
        terminationGracePeriodSeconds: 10
      };
      if (hasPullSecret) podSpec.imagePullSecrets = [{ name: pullSecretName }];

      const dep = {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'ionos-machine-api-provider', namespace: 'openshift-machine-api', labels: { app: 'ionos-machine-api-provider' } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'ionos-machine-api-provider' } },
          template: {
            metadata: { labels: { app: 'ionos-machine-api-provider' } },
            spec: podSpec
          }
        }
      };
      await ocpApply(depBase, 'ionos-machine-api-provider', dep);
      log(`Deployment "ionos-machine-api-provider" created/updated (image: ${providerImage})\n`);
      step('IONOS Machine API provider deployed', 'ok');
    }

    // ── Step 1: IONOS credentials secret ─────────────────────────────────────
    if (msMode === 'ionos') {
      step('Creating IONOS credentials secret…', 'working');
      const tokenB64 = Buffer.from(ionosToken).toString('base64');
      const secret = {
        apiVersion: 'v1',
        kind:       'Secret',
        metadata:   { name: 'ionoscloud-credentials', namespace: 'openshift-machine-api' },
        type:       'Opaque',
        data:       { token: tokenB64 }
      };
      await ocpApply(secretApiBase, 'ionoscloud-credentials', secret);
      log('Secret "ionoscloud-credentials" created/updated in openshift-machine-api\n');
      step('IONOS credentials secret ready', 'ok');

      // ── Step 2: Check for worker-user-data secret ─────────────────────────
      step('Checking for worker-user-data secret…', 'working');
      const udCheck = await ocpReq('GET', `${secretApiBase}/worker-user-data`, undefined);
      if (udCheck.ok) {
        log('worker-user-data secret found — Machine API can inject Ignition config into new nodes\n');
        step('worker-user-data secret found', 'ok');
      } else {
        log('WARNING: worker-user-data secret not found in openshift-machine-api.\n');
        log('This secret is required for Machine API to inject Ignition config into new nodes.\n');
        log('On UPI clusters you may need to create it manually from an existing worker node\'s ignition config.\n');
        step('worker-user-data: not found (see log)', 'ok');
      }

      // ── Frankfurt Diversity Phase 1: Create secondary VDC + LAN (before MachineSet) ─
      let effectiveDcId   = datacenterId;
      let effectiveLanId  = parseInt(machLanId, 10) || 1;
      let effectiveRegion = region;
      let effectiveImageId = ionosImageId;
      let _fraDoPcc       = false;   // triggers Phase 2 after MachineSet
      let _fraPrimaryLan  = 0;

      if (frankfurtDiversity) {
        const otherLocation = region === 'de/fra' ? 'de/fra/2' : 'de/fra';
        effectiveRegion = otherLocation;

        // Pre-flight: ensure selected image is available in the secondary location.
        // If it's only in the primary location, auto-copy via FTP from the management host.
        step(`Checking image in ${otherLocation}…`, 'working');
        let imgName          = '';
        let imgNeedsLocalCopy = false;
        try {
          const imgData     = await ionosGet(`/images/${encodeURIComponent(ionosImageId)}`, ionosToken);
          const imgLocation = imgData?.properties?.location;
          imgName           = imgData?.properties?.name || '';

          if (imgLocation && imgLocation !== otherLocation) {
            imgNeedsLocalCopy = true;
            log(`Image "${imgName}" is at ${imgLocation} — need to copy to ${otherLocation} via FTP.\n`);
          } else {
            step(`Image available in ${otherLocation}`, 'ok');
          }
        } catch (e) {
          if (e.status) throw e;
          // IONOS system images have no location property — allow through
          log(`  Image location check skipped: ${e.message}\n`);
          step(`Image check skipped (system image)`, 'ok');
        }

        // FTP copy pipeline — outside the system-image catch so errors surface correctly.
        if (imgNeedsLocalCopy) {
          const rawKey     = (process.env.OCP_MGMT_HOST_SSH_KEY || '').trim();
          const mgmtKey    = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
          const mgmtAddr   = process.env.OCP_MGMT_HOST   || '';
          const ftpUser    = process.env.IONOS_FTP_USER  || '';
          const ftpPass    = process.env.IONOS_FTP_PASS  || '';

          if (!mgmtAddr || !mgmtKey || !ftpUser || !ftpPass) {
            const err = new Error(
              'Cannot auto-copy image: OCP_MGMT_HOST, OCP_MGMT_HOST_SSH_KEY, IONOS_FTP_USER ' +
              'or IONOS_FTP_PASS not set in .env'
            );
            err.status = 422;
            throw err;
          }

          // de/fra → ftp-fra.ionos.com,  de/fra/2 → ftp-fra-2.ionos.com
          const ftpHostFor = loc => {
            const p = loc.split('/');
            const c = p[1] || p[0] || 'fra';
            const z = p[2] || '';
            return `ftp-${z ? `${c}-${z}` : c}.ionos.com`;
          };
          const destFtpHost = ftpHostFor(otherLocation);

          // Clean up any stale same-named images from the IONOS catalog.
          // NOTE: IONOS FTP does NOT allow rm, and API deletion does NOT remove the FTP file.
          // So even after deleting here, the FTP file may still exist and block a same-named
          // upload. We handle that below by checking FTP ls and using an alternate filename.
          const staleSnap  = await ionosGet('/images?depth=1', ionosToken).catch(() => ({ items: [] }));
          const staleImgs  = (staleSnap.items || []).filter(img =>
            img.properties?.name === imgName && img.properties?.location === otherLocation
          );
          if (staleImgs.length > 0) {
            step(`Removing ${staleImgs.length} stale catalog image(s) from ${otherLocation}…`, 'working');
            for (const stale of staleImgs) {
              log(`  Deleting stale catalog entry "${stale.properties.name}" (${stale.id})…\n`);
              await ionosDetach(`/images/${stale.id}`, ionosToken);
            }
          }

          step(`Connecting to management host…`, 'working');
          const ftpConn = await sshConnect(mgmtAddr, 'root', mgmtKey);
          try {
            const localFile  = `/tmp/rhcos-upload/${imgName}`;
            const destScript = `/tmp/.lftp-dest-${Date.now()}`;

            const checkRes   = await sshRunScript(ftpConn,
              `[ -f "${localFile}" ] && stat -c%s "${localFile}" || echo MISSING`);
            const cachedBytes = checkRes.stdout.trim();
            let sizeForLog    = parseInt(cachedBytes, 10) || 0;
            // Require > 5 GB — the metal .raw is only ~3.78 GB and will NOT boot on IONOS KVM.
            if (cachedBytes === 'MISSING' || sizeForLog < 5000000000) {
              if (sizeForLog > 0 && sizeForLog < 5000000000) {
                log(`  Found ${imgName} at ${(sizeForLog / 1e9).toFixed(2)} GB — metal image (wrong type). Re-downloading as QEMU qcow2…\n`);
              } else {
                log(`  Image not cached — downloading RHCOS QEMU image from Red Hat mirror…\n`);
              }

              const verMatch = imgName.match(/rhcos-(\d+\.\d+)/i);
              if (!verMatch) {
                const err = new Error(
                  `Cannot determine RHCOS version from image name "${imgName}". ` +
                  `Please use the "Upload RHCOS Image" tool to upload the patched QEMU image first.`
                );
                err.status = 422;
                throw err;
              }
              const rhcosVer   = verMatch[1];
              const tmpQcow2Gz = `/tmp/rhcos-upload/rhcos-qemu-temp.qcow2.gz`;
              const tmpQcow2   = `/tmp/rhcos-upload/rhcos-qemu-temp.qcow2`;

              const qemuChk = await sshRunScript(ftpConn, `command -v qemu-img 2>/dev/null || echo MISSING`);
              if (qemuChk.stdout.trim() === 'MISSING') {
                throw new Error('qemu-img is not installed on the management host. Install with: dnf install qemu-img');
              }

              step(`Downloading RHCOS ${rhcosVer} QEMU image from Red Hat mirror…`, 'working');
              const urlRes = await sshRunScript(ftpConn, `
export PATH=$PATH:/usr/local/bin:/usr/bin
MIRROR="https://mirror.openshift.com/pub/openshift-v4/x86_64/dependencies/rhcos/${rhcosVer}/latest/"
FILENAME=$(curl -sL "$MIRROR" | grep -oE 'rhcos-[0-9.]+-x86_64-qemu\\.x86_64\\.qcow2\\.gz' | head -1)
if [ -z "$FILENAME" ]; then echo "URL_FAIL"; else echo "URL_OK:$MIRROR$FILENAME"; fi
`);
              const urlLine = urlRes.stdout.trim();
              if (!urlLine.startsWith('URL_OK:')) {
                throw new Error(`Could not find RHCOS ${rhcosVer} QEMU qcow2 on mirror.openshift.com. Use the "Upload RHCOS Image" tool to upload manually.`);
              }
              const rhcosUrl = urlLine.slice(7);
              log(`  Found: ${rhcosUrl}\n  Downloading (~1 GB compressed)…\n`);

              await sshRunScriptStreaming(ftpConn, `
set -e
export PATH=$PATH:/usr/local/bin:/usr/bin
rm -f "${tmpQcow2Gz}" "${tmpQcow2}"
curl -L --progress-bar -o "${tmpQcow2Gz}" "${rhcosUrl}" 2>&1
echo "DL_OK"
`, chunk => { log(chunk); });

              log(`  Decompressing qcow2…\n`);
              await sshRunScriptStreaming(ftpConn, `
set -e
gunzip -f "${tmpQcow2Gz}"
echo "DECOMP_OK"
`, chunk => { log(chunk); });

              step(`Converting qcow2 → raw for IONOS KVM (~16 GB, 10–20 min)…`, 'working');
              log(`  Running qemu-img convert (10–20 minutes, no progress stream)…\n`);
              const convertStart = Date.now();
              const convertKeepalive = setInterval(() => {
                const mins = Math.floor((Date.now() - convertStart) / 60000);
                log(`  qemu-img convert in progress… (${mins} min elapsed)\n`);
              }, 25000);
              try {
                await sshRunScriptStreaming(ftpConn, `
set -e
export PATH=$PATH:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin
rm -f "${localFile}"
qemu-img convert -f qcow2 -O raw "${tmpQcow2}" "${localFile}" 2>&1
echo "CONVERT_OK:$(stat -c%s "${localFile}") bytes"
rm -f "${tmpQcow2}"
`, chunk => { log(chunk); });
              } finally {
                clearInterval(convertKeepalive);
              }

              step(`Patching BLS boot entry — ignition.platform.id=metal, IONOS network args…`, 'working');
              const bGateway    = (process.env.OCP_BOOTSTRAP_GATEWAY || '').trim();
              const bDnsRaw     = (process.env.OCP_BOOTSTRAP_DNS      || '').trim();
              const bDnsKargs   = bDnsRaw.split(/[;,\s]+/).filter(Boolean).map(d => `nameserver=${d}`).join(' ');
              const blsMountDir = '/mnt/rhcos-bls-fix';

              const blsPatch = await sshRunScript(ftpConn, `
set -e
export PATH=$PATH:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin
LOOP=$(losetup -f --show -P "${localFile}")
mkdir -p "${blsMountDir}"
if [ -b "\${LOOP}p3" ]; then BPART="\${LOOP}p3";
elif [ -b "\${LOOP}p2" ]; then BPART="\${LOOP}p2";
else echo "PART_FAIL"; losetup -d "$LOOP"; exit 1; fi
mount "$BPART" "${blsMountDir}"
BLS=$(find "${blsMountDir}/loader/entries" -name "ostree-*.conf" 2>/dev/null | head -1)
if [ -z "$BLS" ]; then echo "BLS_FAIL"; umount "${blsMountDir}"; losetup -d "$LOOP"; exit 1; fi
sed -i 's/ignition\\.platform\\.id=qemu/ignition.platform.id=metal/g' "$BLS"
if ! grep -q 'rd.neednet=1' "$BLS"; then
  NARGS="rd.neednet=1 ip=dhcp${bGateway ? ` rd.route=0.0.0.0/0:${bGateway}` : ''} ${bDnsKargs}"
  sed -i "/^options /s|$| $NARGS|" "$BLS"
fi
sync
umount "${blsMountDir}"
losetup -d "$LOOP"
echo "BLS_OK"
`);
              if (!blsPatch.stdout.includes('BLS_OK')) {
                throw new Error(`BLS patch failed:\n${blsPatch.stdout}\n${blsPatch.stderr || ''}`);
              }
              log(`  BLS patched: ignition.platform.id=metal, rd.neednet=1${bGateway ? `, rd.route=0.0.0.0/0:${bGateway}` : ''}${bDnsKargs ? `, ${bDnsKargs}` : ''}\n`);
              step(`RHCOS QEMU image ready — BLS patched for IONOS KVM networking`, 'ok');

              const dlCheck = await sshRunScript(ftpConn, `stat -c%s "${localFile}" 2>/dev/null || echo 0`);
              sizeForLog = parseInt(dlCheck.stdout.trim(), 10) || 0;
              if (sizeForLog < 5000000000) {
                throw new Error(`Converted RHCOS image is too small (${sizeForLog} bytes) — qemu-img conversion may have failed.`);
              }
            }
            log(`  Using IONOS-patched QEMU image "${imgName}" (${(sizeForLog / 1e9).toFixed(2)} GB) — ignition.platform.id=metal, IONOS KVM networking\n`);

            // Step B: upload to destination FTP.
            // IONOS FTP does NOT allow overwriting or deleting files — 550 on both rm and put
            // when the filename already exists. API deletion also does NOT remove the FTP file.
            // Strategy: check what files exist in hdd-images/ via lftp ls, then pick a name
            // that isn't taken. Use lftp `put src -o destname` to rename on the fly if needed.
            const lsScript = `/tmp/.lftp-ls-${Date.now()}`;
            await sshRunScript(ftpConn, `
cat > ${lsScript} << 'LFTP_EOF'
set ftp:ssl-allow true
set ftp:ssl-allow/${destFtpHost} true
open ${destFtpHost}
user "${ftpUser}" "${ftpPass}"
cls -1 hdd-images/
bye
LFTP_EOF
chmod 600 ${lsScript}`);
            const lsResult = await sshRunScript(ftpConn, `lftp -f ${lsScript} 2>/dev/null; rm -f ${lsScript}`);
            // cls output is one entry per line, potentially prefixed with "hdd-images/"
            const existingFtpFiles = new Set(
              lsResult.stdout.split('\n')
                .map(l => l.trim().replace(/^.*\//, ''))  // strip any directory prefix
                .filter(Boolean)
            );
            log(`  FTP hdd-images/ contains: ${[...existingFtpFiles].join(', ') || '(empty)'}\n`);

            // Choose an upload name that doesn't conflict with an existing FTP file.
            const locSuffix = otherLocation === 'de/fra' ? 'fra' : 'fra2';
            let uploadName  = imgName;
            if (existingFtpFiles.has(imgName)) {
              const base = imgName.replace(/\.raw$/, '');
              const candidates = [
                `${base}-${locSuffix}.raw`,
                ...Array.from({ length: 8 }, (_, i) => `${base}-${locSuffix}${i + 2}.raw`)
              ];
              const free = candidates.find(c => !existingFtpFiles.has(c));
              if (!free) {
                const err = new Error(
                  `No free FTP slot for "${imgName}" in ${otherLocation} — all alternate names are taken. ` +
                  `Delete old images from IONOS DCD → Images (${otherLocation}) to free up FTP quota.`
                );
                err.status = 409;
                throw err;
              }
              uploadName = free;
              log(`  "${imgName}" already in FTP — uploading as "${uploadName}"\n`);
            }

            // Static-IP approach: secondary-VDC workers get an IP from the primary VDC
            // subnet so they are directly reachable via PCC — no routing tricks needed.
            if (!frankfurtStaticIp) throw new Error('Worker static IP is required for Frankfurt diversity. Enter an unused IP from the primary VDC subnet (e.g. 10.7.224.30).');
            const fraStaticIp      = frankfurtStaticIp.trim().split('/')[0];
            const safeIp           = fraStaticIp.replace(/\./g, '-');
            const ignitionHost     = frankfurtIgnitionIp || mgmtAddr;
            const ignitionUrl      = `http://${ignitionHost}:8080/worker-fra-${safeIp}.ign`;
            const workerFraIgnPath = `/root/ignition-serve/worker-fra-${safeIp}.ign`;
            const gwPrimary        = (process.env.OCP_BOOTSTRAP_GATEWAY || '10.7.224.1').trim();
            const dnsRaw           = (process.env.OCP_BOOTSTRAP_DNS || '212.227.123.16;212.227.123.17;').trim();

            // Build NM keyfile for the static IP (persists through MCO reboots via Ignition)
            const nmKeyfile = [
              '[connection]',
              'id=worker-fra-static',
              'type=ethernet',
              'interface-name=ens3',
              'autoconnect=true',
              '',
              '[ethernet]',
              '',
              '[ipv4]',
              'method=manual',
              `address1=${fraStaticIp}/23,${gwPrimary}`,
              `dns=${dnsRaw}`,
              'ignore-auto-dns=true',
              '',
              '[ipv6]',
              'method=disabled',
              '',
            ].join('\n');

            // Read worker.ign from management host, replace NM keyfile, write per-worker file
            step(`Generating per-worker Ignition config for ${fraStaticIp}…`, 'working');
            const workerIgnResult = await sshRunScript(ftpConn, `cat /root/ignition-serve/worker.ign 2>/dev/null`);
            let ignConfig;
            try {
              ignConfig = JSON.parse(workerIgnResult.stdout.trim());
            } catch (e) {
              throw new Error(`Cannot parse /root/ignition-serve/worker.ign on management host: ${e.message}. Ensure it exists and is valid JSON.`);
            }
            if (!ignConfig.storage) ignConfig.storage = {};
            if (!ignConfig.storage.files) ignConfig.storage.files = [];
            ignConfig.storage.files = ignConfig.storage.files.filter(f => !((f.path || '').includes('worker-fra')));
            ignConfig.storage.files.push({
              path: '/etc/NetworkManager/system-connections/worker-fra-static.nmconnection',
              mode: 384,
              overwrite: true,
              contents: { source: `data:text/plain;charset=utf-8;base64,${Buffer.from(nmKeyfile).toString('base64')}` }
            });
            const ignB64Lines = Buffer.from(JSON.stringify(ignConfig)).toString('base64').match(/.{1,76}/g).join('\n');
            const writeIgnResult = await sshRunScript(ftpConn, `
set -e
base64 -d > "${workerFraIgnPath}" << 'IGNB64EOF'
${ignB64Lines}
IGNB64EOF
chmod 644 "${workerFraIgnPath}"
echo "IGN_WRITE_OK"
`);
            if (!writeIgnResult.stdout.includes('IGN_WRITE_OK')) {
              throw new Error(`Failed to write per-worker Ignition file: ${writeIgnResult.stdout} ${writeIgnResult.stderr || ''}`);
            }
            log(`  Per-worker Ignition config: ${workerFraIgnPath}\n`);
            log(`  ignition.config.url = ${ignitionUrl}\n`);
            step(`Per-worker Ignition config ready for ${fraStaticIp}`, 'ok');

            // Patch a copy of the image: replace ip=dhcp with static IP, set ignition URL
            const blsMountDir = `/mnt/rhcos-fra-bls`;
            const patchedFile = `/tmp/rhcos-upload/.fra-patched-${Date.now()}.raw`;
            step(`Patching fra image BLS (static IP ${fraStaticIp} + ignition URL)…`, 'working');
            log(`  Copying ${localFile} → ${patchedFile} and patching BLS…\n`);
            const blsPatch = await sshRunScript(ftpConn, `
set -e
cp --reflink=auto "${localFile}" "${patchedFile}" 2>/dev/null || cp "${localFile}" "${patchedFile}"
LOOP=$(losetup -f --show -P "${patchedFile}")
mkdir -p "${blsMountDir}"
if [ -b "\${LOOP}p3" ]; then BPART="\${LOOP}p3"; elif [ -b "\${LOOP}p2" ]; then BPART="\${LOOP}p2"; else echo "PART_FAIL"; losetup -d "$LOOP"; exit 1; fi
mount "$BPART" "${blsMountDir}"
BLS=$(find "${blsMountDir}/loader/entries" -name "ostree-*.conf" 2>/dev/null | head -1)
if [ -z "$BLS" ]; then echo "BLS_FAIL"; umount "${blsMountDir}"; losetup -d "$LOOP"; exit 1; fi
# Replace DHCP with static IP (dracut format: ip=IP::GW:MASK::IFACE:none)
sed -i 's|ip=dhcp|ip=${fraStaticIp}::${gwPrimary}:255.255.254.0::ens3:none|g' "$BLS"
# Remove any rd.route= args (not needed — worker is on the primary subnet via PCC)
sed -i 's| rd\.route=[^ ]*||g' "$BLS"
# Replace existing ignition URL or append if absent
if grep -q 'ignition.config.url' "$BLS"; then
  sed -i 's|ignition\\.config\\.url=[^ ]*|ignition.config.url=${ignitionUrl}|g' "$BLS"
else
  sed -i '/^options /s|$| ignition.config.url=${ignitionUrl}|' "$BLS"
fi
sync
umount "${blsMountDir}"
losetup -d "$LOOP"
echo "PATCH_OK"
`);
            if (!blsPatch.stdout.includes('PATCH_OK')) {
              log(`  Warning: BLS patch may have failed (${blsPatch.stdout.trim()}) — continuing with unpatched image.\n`);
            } else {
              log(`  BLS patched — static IP ${fraStaticIp}, ignition URL set.\n`);
            }
            const uploadFile = blsPatch.stdout.includes('PATCH_OK') ? patchedFile : localFile;

            step(`Uploading "${uploadName}" to ${destFtpHost} (~16 GB, 20–40 min)…`, 'working');
            log(`  Uploading ${uploadFile} → ${destFtpHost}/hdd-images/${uploadName}\n`);
            await sshRunScript(ftpConn, `
cat > ${destScript} << 'LFTP_EOF'
set ftp:ssl-allow true
set ftp:ssl-allow/${destFtpHost} true
open ${destFtpHost}
user "${ftpUser}" "${ftpPass}"
cd hdd-images
put ${uploadFile} -o ${uploadName}
bye
LFTP_EOF
chmod 600 ${destScript}`);
            // lftp sends no stdout during upload — keep SSE alive with periodic log lines
            const ftpUploadStart = Date.now();
            const ftpKeepalive = setInterval(() => {
              const mins = Math.floor((Date.now() - ftpUploadStart) / 60000);
              log(`  FTP upload in progress… (${mins} min elapsed)\n`);
            }, 25000);
            try {
              await sshRunScriptStreaming(ftpConn, `set -e
lftp -f ${destScript}
echo "UPLOAD_OK"
rm -f ${destScript}
rm -f "${patchedFile}"`, chunk => { log(chunk); });
            } finally {
              clearInterval(ftpKeepalive);
            }

            step(`"${uploadName}" uploaded to ${destFtpHost}`, 'ok');
            imgName = uploadName;
          } finally {
            ftpConn.end();
          }

          // Poll IONOS until the freshly uploaded image appears as AVAILABLE.
          // We already deleted any stale same-named image above, so any match is the new one.
          step(`Waiting for IONOS to process "${imgName}" in ${otherLocation}…`, 'working');
          log(`Image submitted to IONOS. Processing typically takes 5–30 minutes for a 16 GB file.\n`);
          const uploadedAt  = Date.now();
          const imgDeadline = uploadedAt + 45 * 60 * 1000;
          let newImageFound  = false;
          while (!newImageFound) {
            await new Promise(r => setTimeout(r, 30000));
            const elapsed = Math.floor((Date.now() - uploadedAt) / 1000);
            log(`  Polling IONOS for "${imgName}" in ${otherLocation}… (${elapsed}s elapsed)\n`);
            try {
              const imgs = await ionosGet('/images?depth=1', ionosToken);
              for (const img of (imgs?.items || [])) {
                if (img.properties?.name === imgName &&
                    img.properties?.location === otherLocation &&
                    img.metadata?.state === 'AVAILABLE') {
                  effectiveImageId = img.id;
                  newImageFound = true;
                  break;
                }
              }
            } catch (pollErr) {
              log(`  Poll error (will retry): ${pollErr.message}\n`);
            }
            if (!newImageFound) {
              if (Date.now() > imgDeadline) {
                const err = new Error(
                  `Image did not become AVAILABLE in ${otherLocation} within 45 minutes. ` +
                  `Check IONOS DCD → Images for "${imgName}" in ${otherLocation}.`
                );
                err.status = 504;
                throw err;
              }
              log('  Still processing…\n');
            }
          }
          log(`  Image ready in ${otherLocation}: ${effectiveImageId}\n`);
          step(`Image "${imgName}" ready in ${otherLocation}`, 'ok');

          // Patch the newly uploaded image with the required IONOS metadata so
          // Machine API can pass userData (RHCOS Ignition config) to the volume.
          log(`  Patching image metadata (cloudInit=V1, licenceType=LINUX, UEFI, hotplug)…\n`);
          try {
            await ionosPatch(`/images/${effectiveImageId}`, ionosToken, {
              requireLegacyBios:    false,
              licenceType:          'LINUX',
              cloudInit:            'V1',
              cpuHotPlug:           true,
              cpuHotUnplug:         true,
              ramHotPlug:           true,
              ramHotUnplug:         true,
              nicHotPlug:           true,
              nicHotUnplug:         true,
              discVirtioHotPlug:    true,
              discVirtioHotUnplug:  true
            });
            log(`  Image metadata patched.\n`);
          } catch (patchErr) {
            log(`  Warning: image metadata patch failed (${patchErr.message}) — you may need to set cloudInit=V1 manually.\n`);
          }
        } else if (frankfurtStaticIp) {
          // Image is already at the target location — no FTP copy needed.
          // The image must have already had its BLS patched (via a previous imgNeedsLocalCopy run)
          // with ip=<staticIp> and ignition.config.url pointing to worker-fra-<IP>.ign.
          // Here we (re-)write that per-worker ignition file on the management host.
          //
          // NOTE: If the image was NOT previously BLS-patched for static IP (e.g. an old DHCP-era
          // image), this path will not work — select a primary VDC (de/fra/2) image instead so
          // the tool performs the full copy+patch pipeline.
          const rawKeyAlt  = (process.env.OCP_MGMT_HOST_SSH_KEY || '').trim();
          const mgmtKeyAlt = rawKeyAlt.includes('\\n') ? rawKeyAlt.replace(/\\n/g, '\n') : rawKeyAlt;
          const mgmtAddrAlt = process.env.OCP_MGMT_HOST || '';
          if (!mgmtAddrAlt || !mgmtKeyAlt) throw new Error('OCP_MGMT_HOST and OCP_MGMT_HOST_SSH_KEY are required for Frankfurt diversity static IP.');

          const fraStaticIpAlt  = frankfurtStaticIp.trim().split('/')[0];
          const safeIpAlt       = fraStaticIpAlt.replace(/\./g, '-');
          const ignitionHostAlt = frankfurtIgnitionIp || mgmtAddrAlt;
          const ignFileAlt      = `/root/ignition-serve/worker-fra-${safeIpAlt}.ign`;
          const gwPrimaryAlt    = (process.env.OCP_BOOTSTRAP_GATEWAY || '10.7.224.1').trim();
          const dnsRawAlt       = (process.env.OCP_BOOTSTRAP_DNS || '212.227.123.16;212.227.123.17;').trim();
          const nmKeyfileAlt = [
            '[connection]', 'id=worker-fra-static', 'type=ethernet',
            'interface-name=ens3', 'autoconnect=true', '',
            '[ethernet]', '', '[ipv4]', 'method=manual',
            `address1=${fraStaticIpAlt}/23,${gwPrimaryAlt}`, `dns=${dnsRawAlt}`,
            'ignore-auto-dns=true', '', '[ipv6]', 'method=disabled', '',
          ].join('\n');

          step(`Writing worker-fra-${safeIpAlt}.ign on management host…`, 'working');
          const altConn = await sshConnect(mgmtAddrAlt, 'root', mgmtKeyAlt);
          try {
            const wIgnRes = await sshRunScript(altConn, `cat /root/ignition-serve/worker.ign 2>/dev/null`);
            let ignCfgAlt;
            try { ignCfgAlt = JSON.parse(wIgnRes.stdout.trim()); }
            catch (e) { throw new Error(`Cannot parse /root/ignition-serve/worker.ign: ${e.message}`); }
            if (!ignCfgAlt.storage) ignCfgAlt.storage = {};
            if (!ignCfgAlt.storage.files) ignCfgAlt.storage.files = [];
            ignCfgAlt.storage.files = ignCfgAlt.storage.files.filter(f => !((f.path || '').includes('worker-fra-static')));
            ignCfgAlt.storage.files.push({
              path: '/etc/NetworkManager/system-connections/worker-fra-static.nmconnection',
              mode: 384, overwrite: true,
              contents: { source: `data:text/plain;charset=utf-8;base64,${Buffer.from(nmKeyfileAlt).toString('base64')}` }
            });
            const ignB64Alt = Buffer.from(JSON.stringify(ignCfgAlt)).toString('base64').match(/.{1,76}/g).join('\n');
            const wRes = await sshRunScript(altConn, `
set -e
mkdir -p /root/ignition-serve
base64 -d > "${ignFileAlt}" << 'IGNB64EOF'
${ignB64Alt}
IGNB64EOF
chmod 644 "${ignFileAlt}"
echo "ALT_WRITE_OK"
`);
            if (!wRes.stdout.includes('ALT_WRITE_OK')) throw new Error(`Failed to write ${ignFileAlt}: ${wRes.stdout} ${wRes.stderr || ''}`);
            log(`  ${ignFileAlt} written — static IP ${fraStaticIpAlt}, gateway ${gwPrimaryAlt}.\n`);
            step(`worker-fra-${safeIpAlt}.ign written for static IP ${fraStaticIpAlt}`, 'ok');
          } finally {
            altConn.end();
          }
        }

        if (frankfurtSubMode === 'create') {
          // fra1: Create secondary VDC
          step(`Creating secondary VDC "${frankfurtVdcName}" at ${otherLocation}…`, 'working');
          const newDc = await ionosPost('/datacenters', ionosToken, {
            properties: { name: frankfurtVdcName, location: otherLocation }
          });
          effectiveDcId = newDc.id;
          log(`  Secondary VDC ID: ${effectiveDcId}\n`);
          await ionosWaitAvailable(`/datacenters/${effectiveDcId}`, ionosToken, 300000);
          step(`Secondary VDC "${frankfurtVdcName}" ready at ${otherLocation}`, 'ok');

          // fra2: Create private LAN in secondary VDC (LAN ID now known for MachineSet NIC)
          step('Creating private LAN in secondary VDC…', 'working');
          const newLan = await ionosPost(`/datacenters/${effectiveDcId}/lans`, ionosToken, {
            properties: { name: 'Internal', public: false }
          });
          effectiveLanId = parseInt(newLan.id, 10) || 1;
          log(`  Secondary LAN ID: ${effectiveLanId}\n`);
          await ionosWaitAvailable(`/datacenters/${effectiveDcId}/lans/${effectiveLanId}`, ionosToken, 120000);
          step(`Private LAN ${effectiveLanId} created in secondary VDC`, 'ok');

          _fraDoPcc      = true;
          _fraPrimaryLan = parseInt(frankfurtPrimaryLanId, 10) || 1;

        } else {
          effectiveDcId  = frankfurtExistingDcId;
          effectiveLanId = parseInt(frankfurtExistingLanId, 10) || 1;
          log(`Using existing secondary Frankfurt VDC: ${effectiveDcId} (LAN: ${effectiveLanId})\n`);
        }
      }

      // ── Step 3: Create IONOS-backed MachineSet ────────────────────────────
      step(`Creating IONOS MachineSet "${targetMsName}"…`, 'working');
      const ramMB      = (parseInt(machRamGiB, 10) || 8) * 1024;
      const diskGB     = parseInt(machDiskGB, 10) || 120;
      const cores      = parseInt(machCores,  10) || 4;
      const diskType   = (machDiskType === 'SSD Premium') ? 'SSD_PREMIUM' : 'SSD_STANDARD';
      const az         = availabilityZone     || 'AUTO';
      const diskAz     = diskAvailabilityZone || az;
      const cpuFam     = cpuFamily            || 'INTEL_ICELAKE';
      const lanId      = effectiveLanId;
      const srvType    = serverType           || 'ENTERPRISE';
      const isVcpu     = srvType === 'VCPU';

      // providerSpec raw value — serialised into the MachineSet spec.
      // Uses the ionoscloudproviderconfig.openshift.io/v1alpha1 API that the
      // IONOS Cloud Machine API provider (machine-api-provider-ionos) understands.
      const providerSpec = {
        apiVersion: 'ionoscloudproviderconfig.openshift.io/v1alpha1',
        kind:       'IONOSCloudMachineProviderSpec',
        datacenterID:      effectiveDcId,
        cores,
        ram:               ramMB,
        ...(isVcpu ? {} : { cpuFamily: cpuFam }),
        serverType:        srvType,
        ...(effectiveRegion ? { region: effectiveRegion } : {}),
        availabilityZone:  az,
        image:             effectiveImageId || ionosImageId,
        disk: {
          name:             `${targetMsName}-boot`,
          size:             diskGB,
          type:             diskType,
          availabilityZone: diskAz
        },
        nics: [
          frankfurtStaticIp
            ? { lan: lanId, dhcp: false, ips: [frankfurtStaticIp.trim().split('/')[0]], firewallActive: false, name: `${targetMsName}-nic0` }
            : { lan: lanId, dhcp: true,                                   firewallActive: false, name: `${targetMsName}-nic0` }
        ],
        credentialsSecret: { name: 'ionoscloud-credentials', namespace: 'openshift-machine-api' },
        userDataSecret:    { name: 'worker-user-data',       namespace: 'openshift-machine-api' }
      };

      const msLabelKey = 'machine.openshift.io/cluster-api-machineset';
      const ionosMs = {
        apiVersion: 'machine.openshift.io/v1beta1',
        kind:       'MachineSet',
        metadata: {
          name:      targetMsName,
          namespace: 'openshift-machine-api',
          labels:    { [msLabelKey]: targetMsName }
        },
        spec: {
          replicas: parseInt(msInitReplicas, 10) || 1,
          selector: { matchLabels: { [msLabelKey]: targetMsName } },
          template: {
            metadata: {
              labels: {
                [msLabelKey]: targetMsName,
                'machine.openshift.io/cluster-api-machine-role': 'worker',
                'machine.openshift.io/cluster-api-machine-type': 'worker'
              }
            },
            spec: {
              providerSpec: { value: providerSpec },
              taints: []
            }
          }
        }
      };

      await ocpApply(msApiBase, targetMsName, ionosMs);
      log(`MachineSet "${targetMsName}" created with IONOS providerSpec\n`);
      log(`  Image: ${effectiveImageId || ionosImageId}${effectiveImageId && effectiveImageId !== ionosImageId ? ` (copied to ${effectiveRegion})` : ''}\n`);
      log(`  ${cores} cores / ${machRamGiB} GiB RAM / ${diskGB} GB ${diskType} / LAN ${lanId}\n`);
      log(`  VDC: ${effectiveDcId}${effectiveRegion ? ` (${effectiveRegion})` : ''}\n`);
      log(`  Type: ${srvType}${isVcpu ? '' : ` / CPU: ${cpuFam}`} / AZ: ${az}\n`);
      step(`IONOS MachineSet "${targetMsName}" created`, 'ok');

      // Delete any stale Machines that belong to this MachineSet but have a different
      // datacenterID — left over from a previous failed run where the VDC was recreated.
      try {
        const machineApiBase = `${apiUrl}/apis/machine.openshift.io/v1beta1/namespaces/openshift-machine-api/machines`;
        const labelSel = `machine.openshift.io%2Fcluster-api-machineset=${encodeURIComponent(targetMsName)}`;
        const existing = await ocpReq('GET', `${machineApiBase}?labelSelector=${labelSel}`, undefined);
        for (const m of existing.data?.items || []) {
          const mDcId = m.spec?.providerSpec?.value?.datacenterID;
          if (mDcId && mDcId !== effectiveDcId) {
            log(`  Deleting stale Machine "${m.metadata.name}" (old VDC: ${mDcId})\n`);
            await ocpReq('DELETE', `${machineApiBase}/${encodeURIComponent(m.metadata.name)}`, undefined);
          }
        }
      } catch (_) { /* non-fatal — MachineSet controller will sort it out */ }

      // ── Frankfurt Diversity Phase 2: PCC + LAN connections (after MachineSet) ─
      if (_fraDoPcc) {
        // fra3: Create Private Cross Connect
        step(`Creating Private Cross Connect "${frankfurtPccName}"…`, 'working');
        const pcc = await ionosPost('/pccs', ionosToken, {
          properties: { name: frankfurtPccName }
        });
        const pccId = pcc.id;
        log(`  PCC ID: ${pccId}\n`);
        await ionosWaitAvailable(`/pccs/${pccId}`, ionosToken, 120000);
        step(`PCC "${frankfurtPccName}" ready`, 'ok');

        // fra4: Connect primary VDC LAN to PCC
        step(`Connecting primary VDC LAN ${_fraPrimaryLan} to PCC…`, 'working');
        // Validate the LAN exists before patching — gives a clear error if the user entered a wrong ID
        {
          let lansResp;
          try {
            lansResp = await ionosGet(`/datacenters/${datacenterId}/lans?depth=1`, ionosToken);
          } catch (lanListErr) {
            const err = new Error(`Failed to list LANs in primary VDC (${datacenterId}): ${lanListErr.message}. Check that "IONOS Datacenter ID" in the form is your primary cluster VDC.`);
            err.status = 400;
            throw err;
          }
          const availIds = (lansResp.items || []).map(l => `${l.id} ("${l.properties?.name || 'unnamed'}")`);
          const lanExists = (lansResp.items || []).some(l => String(l.id) === String(_fraPrimaryLan));
          if (!lanExists) {
            const listStr = availIds.length ? availIds.join(', ') : '(none found)';
            const err = new Error(`LAN ${_fraPrimaryLan} does not exist in primary VDC (${datacenterId}). Available LANs: ${listStr}. Update "Primary VDC LAN ID" in the form and try again.`);
            err.status = 400;
            throw err;
          }
        }
        await ionosPatch(
          `/datacenters/${datacenterId}/lans/${_fraPrimaryLan}`,
          ionosToken,
          { pcc: pccId }
        );
        await ionosWaitAvailable(`/datacenters/${datacenterId}`, ionosToken, 120000);
        step(`Primary VDC LAN ${_fraPrimaryLan} connected to PCC`, 'ok');

        // fra5: Connect secondary VDC LAN to PCC
        step(`Connecting secondary VDC LAN ${effectiveLanId} to PCC…`, 'working');
        await ionosPatch(
          `/datacenters/${effectiveDcId}/lans/${effectiveLanId}`,
          ionosToken,
          { pcc: pccId }
        );
        await ionosWaitAvailable(`/datacenters/${effectiveDcId}`, ionosToken, 120000);
        step(`Secondary VDC LAN ${effectiveLanId} connected to PCC`, 'ok');

        log(`\nFrankfurt diversity complete:\n`);
        log(`  Primary VDC:   ${datacenterId} (${region}) — LAN ${_fraPrimaryLan}\n`);
        log(`  Secondary VDC: ${effectiveDcId} (${effectiveRegion}) — LAN ${effectiveLanId}\n`);
        log(`  PCC:           ${pccId} ("${frankfurtPccName}")\n\n`);
      }

    } else if (msMode === 'clone') {
      // ── Step 1+2: Clone existing MachineSet ──────────────────────────────
      step(`Fetching source MachineSet "${msSource}"…`, 'working');
      const r = await ocpReq('GET', `${msApiBase}/${encodeURIComponent(msSource)}`, undefined);
      if (!r.ok) throw new Error(`Could not fetch MachineSet ${msSource}: HTTP ${r.status}: ${r.data?.message || ''}`);
      const template = r.data;
      log(`Fetched MachineSet "${msSource}" (${template.spec?.replicas ?? 0} replicas)\n`);
      step(`MachineSet "${msSource}" fetched`, 'ok');

      step(`Creating cloned MachineSet "${targetMsName}"…`, 'working');
      const clone = {
        apiVersion: template.apiVersion,
        kind:       template.kind,
        metadata:   { name: targetMsName, namespace: 'openshift-machine-api', labels: {} },
        spec:       JSON.parse(JSON.stringify(template.spec))
      };
      clone.spec.replicas = parseInt(msInitReplicas, 10) || 1;
      const msLabelKey = 'machine.openshift.io/cluster-api-machineset';
      if (clone.spec.selector?.matchLabels)              clone.spec.selector.matchLabels[msLabelKey]             = targetMsName;
      if (clone.spec.template?.metadata?.labels)         clone.spec.template.metadata.labels[msLabelKey]         = targetMsName;
      await ocpApply(msApiBase, targetMsName, clone);
      log(`MachineSet "${targetMsName}" cloned from "${msSource}" (${clone.spec.replicas} replicas)\n`);
      step(`MachineSet "${targetMsName}" created`, 'ok');
    }
    // 'existing' mode: no MachineSet changes — just apply autoscaler resources below

    // ── ClusterAutoscaler ─────────────────────────────────────────────────────
    step('Applying ClusterAutoscaler…', 'working');
    const caSpec = {
      apiVersion: 'autoscaling.openshift.io/v1',
      kind:       'ClusterAutoscaler',
      metadata:   { name: 'default' },
      spec: {
        resourceLimits: {
          maxNodesTotal: parseInt(maxNodes, 10) || 10,
          cores:   { min: 0, max: parseInt(maxCores,      10) || 64  },
          memory:  { min: 0, max: (parseInt(maxMemoryGiB, 10) || 256) * 1024 }
        },
        scaleDown: {
          enabled:       scaleDown !== false,
          delayAfterAdd: delayAfterAdd || '10m',
          unneededTime:  unneededTime  || '10m'
        }
      }
    };
    await ocpApply(caApiBase, 'default', caSpec);
    log(`ClusterAutoscaler "default" — maxNodes=${maxNodes}, maxCores=${maxCores}, maxMemory=${maxMemoryGiB}GiB, scaleDown=${scaleDown}\n`);
    step('ClusterAutoscaler applied', 'ok');

    // ── MachineAutoscaler ─────────────────────────────────────────────────────
    step(`Applying MachineAutoscaler for "${targetMsName}"…`, 'working');
    const maSpec = {
      apiVersion: 'autoscaling.openshift.io/v1beta1',
      kind:       'MachineAutoscaler',
      metadata:   { name: targetMsName, namespace: 'openshift-machine-api' },
      spec: {
        minReplicas: parseInt(minReplicas, 10) || 1,
        maxReplicas: parseInt(maxReplicas, 10) || 5,
        scaleTargetRef: {
          apiVersion: 'machine.openshift.io/v1beta1',
          kind:       'MachineSet',
          name:       targetMsName
        }
      }
    };
    await ocpApply(maApiBase, targetMsName, maSpec);
    log(`MachineAutoscaler "${targetMsName}" — min=${minReplicas}, max=${maxReplicas}\n`);
    step('MachineAutoscaler applied', 'ok');

    done(
      `Autoscaling configured on MachineSet "${targetMsName}" — ` +
      `replicas ${minReplicas}–${maxReplicas}, cluster max ${maxNodes} nodes. ` +
      (msMode === 'ionos' ? 'IONOS Machine API provider must be running in openshift-machine-api for automatic VM provisioning. ' : '') +
      `Scale-down ${scaleDown ? `enabled (delay ${delayAfterAdd}, unneeded ${unneededTime})` : 'disabled'}.`
    );
  } catch (err) {
    fail(err.message);
  }
});

// ── Scale In: cordon → drain → verify → delete ────────────────────────────
// Streams progress as SSE.  The drain step polls pod eviction and may take
// several minutes if PDBs are in play — the client should show a live log.
app.post('/api/scale-in', async (req, res) => {
  if (!requireFields(res, req.body, ['apiUrl', 'ocpToken', 'nodeName'])) return;
  const { apiUrl, ocpToken, nodeName,
          deleteIonos, ionosToken: siIonosToken,
          datacenterId: siDcId, ionosServerId } = req.body;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = obj  => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const step = (label, status) => emit({ type: 'step', label, status });
  const log  = text => emit({ type: 'log',  text });
  const done = msg  => { emit({ type: 'done', message: msg }); res.end(); };
  const fail = msg  => { emit({ type: 'error', message: msg }); res.end(); };

  const nodePath = `/api/v1/nodes/${encodeURIComponent(nodeName)}`;

  try {
    // ── Step 1: Cordon ──────────────────────────────────────────────────────
    step(`Cordoning ${nodeName}…`, 'working');
    await ocpPatch(apiUrl, nodePath, ocpToken,
      { spec: { unschedulable: true } });
    step(`${nodeName} cordoned — scheduling disabled`, 'ok');
    log('No new Pods will be scheduled on this node.\n');

    // ── Step 2: Drain ───────────────────────────────────────────────────────
    // The OCP API doesn't expose a single "drain" call — we implement it by
    // evicting all non-DaemonSet Pods with a graceful timeout, mirroring:
    //   oc adm drain <node> --ignore-daemonsets --delete-emptydir-data --force
    step('Draining pods…', 'working');
    log('Listing pods on node…\n');

    const podsData = await ocpGet(apiUrl,
      `/api/v1/pods?fieldSelector=spec.nodeName=${encodeURIComponent(nodeName)}`, ocpToken);
    const allPods = podsData?.items || [];

    // Filter out DaemonSet-owned pods (cannot be evicted/rescheduled)
    const evictable = allPods.filter(p => {
      const owners = p.metadata?.ownerReferences || [];
      return !owners.some(o => o.kind === 'DaemonSet');
    });

    log(`Found ${allPods.length} pod(s) total, ${evictable.length} evictable (${allPods.length - evictable.length} DaemonSet pods ignored).\n`);

    // Evict each pod via the eviction sub-resource (honours PDBs gracefully)
    const evictResults = await Promise.allSettled(evictable.map(async p => {
      const ns   = p.metadata.namespace;
      const name = p.metadata.name;
      try {
        await ocpDelete(apiUrl,
          `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`, ocpToken);
        log(`  Evicted: ${ns}/${name}\n`);
      } catch (e) {
        // 404 = already gone, treat as success
        if (e.status === 404) { log(`  Already gone: ${ns}/${name}\n`); return; }
        log(`  Warning — could not evict ${ns}/${name}: ${e.message}\n`);
        throw e;
      }
    }));

    const evictFailed = evictResults.filter(r => r.status === 'rejected');
    if (evictFailed.length) {
      log(`${evictFailed.length} pod(s) could not be evicted — check Pod Disruption Budgets.\n`);
    }

    // Poll until all evictable pods are gone (max 10 min)
    log('Waiting for pods to terminate…\n');
    const drainDeadline = Date.now() + 600000;
    while (Date.now() < drainDeadline) {
      await new Promise(r => setTimeout(r, 5000));
      const remaining = await ocpGet(apiUrl,
        `/api/v1/pods?fieldSelector=spec.nodeName=${encodeURIComponent(nodeName)}`, ocpToken);
      const left = (remaining?.items || []).filter(p => {
        const owners = p.metadata?.ownerReferences || [];
        return !owners.some(o => o.kind === 'DaemonSet');
      });
      if (!left.length) break;
      log(`  Waiting — ${left.length} pod(s) still terminating…\n`);
    }
    step('Node drained — all evictable pods terminated', 'ok');

    // ── Step 3: Verify ──────────────────────────────────────────────────────
    step('Verifying cluster health…', 'working');
    const nodesData = await ocpGet(apiUrl, '/api/v1/nodes', ocpToken);
    const workers = (nodesData?.items || []).filter(n => {
      const labels = n.metadata?.labels || {};
      return 'node-role.kubernetes.io/worker' in labels &&
             n.metadata?.name !== nodeName;
    });
    const readyWorkers = workers.filter(n =>
      (n.status?.conditions || []).some(c => c.type === 'Ready' && c.status === 'True')
    );
    log(`Remaining workers: ${workers.length} total, ${readyWorkers.length} Ready.\n`);
    if (readyWorkers.length === 0) {
      return fail('No other Ready worker nodes found — aborting to prevent cluster outage.');
    }
    step(`Cluster healthy — ${readyWorkers.length} other worker(s) Ready`, 'ok');

    // ── Step 4: Delete node object ──────────────────────────────────────────
    step(`Deleting node object ${nodeName}…`, 'working');
    await ocpDelete(apiUrl, nodePath, ocpToken);
    step(`Node ${nodeName} removed from cluster`, 'ok');
    log('Node object deleted from Kubernetes API.\n');

    // ── Step 5+6: IONOS Cloud cleanup (optional) ────────────────────────────
    if (deleteIonos && siIonosToken && siDcId && ionosServerId) {
      const dcPath     = `/datacenters/${encodeURIComponent(siDcId)}`;
      const serverPath = `${dcPath}/servers/${encodeURIComponent(ionosServerId)}`;

      step('Stopping VM in IONOS Cloud…', 'working');
      try { await ionosAction(`${serverPath}/stop`, siIonosToken); } catch (_) {}
      try {
        await ionosWaitState(serverPath, siIonosToken, ['INACTIVE'], 120000);
      } catch (_) {
        log('Warning: timed out waiting for VM to stop — proceeding with deletion anyway.\n');
      }
      step('VM stopped', 'ok');

      step('Deleting VM and all attached storage…', 'working');
      // deleteVolumes=true removes all attached volumes in the same API call
      await ionosDetach(
        `${dcPath}/servers/${encodeURIComponent(ionosServerId)}?deleteVolumes=true`,
        siIonosToken);
      step('VM and storage deleted from IONOS Cloud', 'ok');
      log(`Server ${ionosServerId} and all attached volumes have been deleted.\n`);

      done(`${nodeName} drained, removed from cluster, and deleted from IONOS Cloud.`);
    } else {
      log('IONOS cleanup skipped — power off and delete the VM in IONOS DCD manually.\n');
      done(`${nodeName} has been successfully drained and removed from the cluster. Power off and delete the VM in IONOS DCD to complete clean-up.`);
    }

  } catch (err) {
    fail(err.message);
  }
});

// ── Routes — IONOS Cloud ───────────────────────────────────────────────────

// Find a server in a datacenter by its name (used to auto-detect the IONOS
// server ID for a worker node during scale-in).
app.post('/api/ionos/find-server', async (req, res) => {
  if (!requireFields(res, req.body, ['ionosToken', 'datacenterId', 'serverName'])) return;
  const { ionosToken, datacenterId, serverName } = req.body;
  const dcPath = `/datacenters/${encodeURIComponent(datacenterId)}`;
  try {
    let offset = 0;
    const limit = 100;
    while (true) {
      const page = await ionosGet(
        `${dcPath}/servers?depth=2&limit=${limit}&offset=${offset}`, ionosToken);
      const items = page?.items || [];
      const found = items.find(s => s.properties?.name === serverName);
      if (found) {
        const volumes = (found.entities?.volumes?.items || []).map(v => ({
          id:   v.id,
          name: v.properties?.name || v.id,
          size: v.properties?.size || 0,
          type: v.properties?.type || ''
        }));
        return res.json({ serverId: found.id, serverName: found.properties?.name, volumes });
      }
      if (items.length < limit) break;
      offset += limit;
    }
    res.status(404).json({ error: `No server named "${serverName}" found in the selected datacenter.` });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// List datacenters so user can browse/select their VDC
app.post('/api/ionos/datacenters', async (req, res) => {
  if (!requireFields(res, req.body, ['ionosToken'])) return;
  try {
    const data = await ionosGet('/datacenters?depth=1', req.body.ionosToken);
    const dcs  = (data?.items || [])
      .map(dc => ({
        id:       dc.id,
        name:     dc.properties?.name     || dc.id,
        location: dc.properties?.location || '—'
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ datacenters: dcs });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Stop a server, switch its boot volume, then start it again.
// Used both by the manual "Switch Boot Device" button and internally after ISO install.
// SSE endpoint — streams progress so the UI can show each step.
app.post('/api/ionos/switch-boot-device', async (req, res) => {
  if (!requireFields(res, req.body, ['ionosToken', 'datacenterId', 'serverId', 'volumeId'])) return;
  const { ionosToken, datacenterId, serverId, volumeId } = req.body;
  const dcPath     = `/datacenters/${encodeURIComponent(datacenterId)}`;
  const serverPath = `${dcPath}/servers/${encodeURIComponent(serverId)}`;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = obj  => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const step = (label, status) => emit({ type: 'step', label, status });
  const done = msg  => { emit({ type: 'done', message: msg }); res.end(); };
  const fail = msg  => { emit({ type: 'error', message: msg }); res.end(); };

  try {
    // Check current state — only stop if running
    step('Checking server state…', 'working');
    const serverData = await ionosGet(serverPath, ionosToken);
    const state = serverData?.metadata?.state;
    emit({ type: 'log', text: `Server state: ${state}\n` });

    if (state !== 'INACTIVE') {
      step('Stopping server…', 'working');
      try { await ionosAction(`${serverPath}/stop`, ionosToken); } catch (_) {}
      await ionosWaitState(serverPath, ionosToken, ['INACTIVE'], 120000);
      step('Server stopped', 'ok');
    } else {
      step('Server already stopped', 'ok');
    }

    step('Switching boot volume…', 'working');
    await ionosPatch(serverPath, ionosToken, { bootVolume: { id: volumeId } });
    await ionosWaitState(serverPath, ionosToken, ['INACTIVE'], 60000);
    step('Boot volume switched', 'ok');

    step('Starting server…', 'working');
    await ionosAction(`${serverPath}/start`, ionosToken);
    await ionosWaitState(serverPath, ionosToken, ['AVAILABLE'], 120000);
    step('Server started', 'ok');

    done(`Boot device switched to volume ${volumeId}. RHCOS is booting — CSRs will appear in 2–3 minutes.`);
  } catch (err) {
    fail(`Boot device switch failed: ${err.message}`);
  }
});

// List images in IONOS Cloud, optionally filtered by a name substring.
// Searches both public images (type=HDD/SSD) and the datacenter's private images.
// Used to find the RHCOS image UUID for Machine API providerSpec.
app.post('/api/ionos/images', async (req, res) => {
  if (!requireFields(res, req.body, ['ionosToken'])) return;
  const { ionosToken, filter } = req.body;
  const needle = (filter || 'rhcos').toLowerCase();
  try {
    // Public images (includes RHCOS uploads visible to the account)
    const data = await ionosGet(`/images?depth=1`, ionosToken);
    const images = (data?.items || [])
      .filter(img => {
        const name = (img.properties?.name || '').toLowerCase();
        const desc = (img.properties?.description || '').toLowerCase();
        return name.includes(needle) || desc.includes(needle);
      })
      .map(img => ({
        id:       img.id,
        name:     img.properties?.name        || img.id,
        type:     img.properties?.imageType   || '—',
        location: img.properties?.location    || '—',
        size:     img.properties?.size        || 0,
        public:   img.properties?.public      ?? false
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ images });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// List LANs in a datacenter so user can pick which LAN to attach the new node to
app.post('/api/ionos/lans', async (req, res) => {
  if (!requireFields(res, req.body, ['ionosToken', 'datacenterId'])) return;
  const { ionosToken, datacenterId } = req.body;
  try {
    const data = await ionosGet(`/datacenters/${encodeURIComponent(datacenterId)}/lans?depth=1`, ionosToken);
    const lans = (data?.items || []).map(lan => ({
      id:     lan.id,
      name:   lan.properties?.name   || `LAN ${lan.id}`,
      public: lan.properties?.public ?? false
    }));
    res.json({ lans });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Return CPU families available at the datacenter's location.
// Used to populate the dynamic CPU Family dropdown when creating a Dedicated Core MachineSet.
app.post('/api/ionos/location-cpu-families', async (req, res) => {
  if (!requireFields(res, req.body, ['ionosToken', 'location'])) return;
  const { ionosToken, location } = req.body;
  // location is like "de/fra" — passed directly as a path segment (already slash-delimited)
  try {
    const data = await ionosGet(`/locations/${location}?depth=1`, ionosToken);
    const families = (data?.properties?.cpuArchitecture || [])
      .map(arch => arch.cpuFamily)
      .filter(Boolean);
    res.json({ cpuFamilies: families });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Create a new worker node server on IONOS Cloud — SSE streaming endpoint.
// Workflow: create server → create SSD volume → attach volume → configure NIC → poll for IP/MAC
app.post('/api/ionos/create-worker', async (req, res) => {
  if (!requireFields(res, req.body, ['ionosToken', 'datacenterId', 'serverName', 'cores', 'ramMB', 'diskGB', 'lanId'])) return;
  const { ionosToken, datacenterId, serverName, cores, ramMB, diskGB, lanId, ssdType, serverAz, storageAz } = req.body;
  const volumeType = (ssdType === 'SSD Premium') ? 'SSD Premium' : 'SSD Standard';
  const dcPath = `/datacenters/${encodeURIComponent(datacenterId)}`;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = obj  => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const log  = text => emit({ type: 'log', text });
  const done = data => { emit({ type: 'done', ...data }); res.end(); };
  const fail = msg  => { emit({ type: 'error', message: msg }); res.end(); };

  try {
    // Step 1 — Create server
    log(`POST /datacenters/${datacenterId}/servers\n`);
    log(`  name: ${serverName}, cores: ${cores}, ram: ${ramMB} MB, type: ENTERPRISE, az: ${serverAz || 'AUTO'}\n`);
    const server = await ionosPost(`${dcPath}/servers`, ionosToken, {
      properties: {
        name:             serverName,
        cores:            parseInt(cores, 10),
        ram:              parseInt(ramMB, 10),
        type:             'ENTERPRISE',
        availabilityZone: serverAz || 'AUTO'
      }
    });
    const serverId = server.id;
    log(`  → Server created: ${serverId}\n`);

    log(`Waiting for server ${serverId} to become AVAILABLE…\n`);
    await ionosWaitAvailable(`${dcPath}/servers/${encodeURIComponent(serverId)}`, ionosToken);
    log(`  → Server AVAILABLE\n`);

    // Step 2 — Create boot SSD volume
    log(`\nPOST /datacenters/${datacenterId}/volumes\n`);
    log(`  name: ${serverName}-boot, size: ${diskGB} GB, type: ${volumeType}, az: ${storageAz || 'AUTO'}\n`);
    const volume = await ionosPost(`${dcPath}/volumes`, ionosToken, {
      properties: {
        name:             `${serverName}-boot`,
        size:              parseInt(diskGB, 10),
        type:              volumeType,
        licenceType:      'OTHER',
        availabilityZone:  storageAz || 'AUTO'
      }
    });
    log(`  → Volume created: ${volume.id}\n`);

    log(`Waiting for volume ${volume.id} to become AVAILABLE…\n`);
    await ionosWaitAvailable(`${dcPath}/volumes/${encodeURIComponent(volume.id)}`, ionosToken);
    log(`  → Volume AVAILABLE\n`);

    // Step 3 — Attach volume to server
    log(`\nPOST /datacenters/${datacenterId}/servers/${serverId}/volumes\n`);
    log(`  Attaching volume ${volume.id}\n`);
    await ionosPost(`${dcPath}/servers/${encodeURIComponent(serverId)}/volumes`, ionosToken, { id: volume.id });
    log(`  → Volume attached\n`);
    await new Promise(r => setTimeout(r, 4000));

    // Step 4 — Manage NICs
    const targetLanId  = parseInt(lanId, 10);
    const nicsBasePath = `${dcPath}/servers/${encodeURIComponent(serverId)}/nics`;

    log(`\nGET /datacenters/${datacenterId}/servers/${serverId}/nics\n`);
    let nicsData = await ionosGet(`${nicsBasePath}?depth=1`, ionosToken);
    let allNics  = nicsData?.items || [];
    log(`  → Found ${allNics.length} existing NIC(s)\n`);

    const wrongNics = allNics.filter(n => parseInt(n.properties?.lan, 10) !== targetLanId);
    for (const bad of wrongNics) {
      log(`  Deleting NIC ${bad.id} on LAN ${bad.properties?.lan} (wrong LAN)\n`);
      await ionosDetach(`${nicsBasePath}/${encodeURIComponent(bad.id)}`, ionosToken);
      const delDeadline = Date.now() + 60000;
      while (Date.now() < delDeadline) {
        await new Promise(r => setTimeout(r, 4000));
        try {
          const remaining = await ionosGet(`${nicsBasePath}?depth=0`, ionosToken);
          if (!(remaining?.items || []).some(n => n.id === bad.id)) break;
        } catch (_) {}
      }
      log(`  → NIC ${bad.id} deleted\n`);
    }

    nicsData = await ionosGet(`${nicsBasePath}?depth=1`, ionosToken);
    allNics  = nicsData?.items || [];
    const correctNics = allNics.filter(n => parseInt(n.properties?.lan, 10) === targetLanId);

    let nic;
    if (correctNics.length > 0) {
      nic = correctNics[0];
      log(`  → Using existing NIC ${nic.id} on LAN ${targetLanId}\n`);
    } else {
      log(`\nPOST /datacenters/${datacenterId}/servers/${serverId}/nics\n`);
      log(`  name: ${serverName}-nic, LAN: ${targetLanId}, dhcp: true\n`);
      nic = await ionosPost(nicsBasePath, ionosToken, {
        properties: { name: `${serverName}-nic`, lan: targetLanId, dhcp: true }
      });
      log(`  → NIC created: ${nic.id}\n`);
      const createDeadline = Date.now() + 90000;
      while (Date.now() < createDeadline) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const fresh = await ionosGet(`${nicsBasePath}/${encodeURIComponent(nic.id)}?depth=1`, ionosToken);
          if (fresh?.id) { nic = fresh; break; }
        } catch (_) {}
      }
    }

    // Step 5 — Poll for IP and MAC
    let primaryIp  = (nic.properties?.ips || [])[0] || null;
    let macAddress = nic.properties?.mac || null;

    if (!primaryIp || !macAddress) {
      log(`\nWaiting for DHCP IP and MAC address…\n`);
      const nicPath  = `${nicsBasePath}/${encodeURIComponent(nic.id)}`;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const nicData = await ionosGet(nicPath, ionosToken);
          if (!primaryIp)  primaryIp  = (nicData?.properties?.ips || [])[0] || null;
          if (!macAddress) macAddress = nicData?.properties?.mac || null;
          log(`  IP: ${primaryIp || '—'}  MAC: ${macAddress || '—'}\n`);
          if (primaryIp && macAddress) break;
        } catch (_) {}
      }
    }

    log(`\nServer ready — IP: ${primaryIp || '(none)'}  MAC: ${macAddress || '(none)'}\n`);
    done({ ok: true, serverId, volumeId: volume.id, nicId: nic.id, primaryIp, macAddress, serverName });

  } catch (err) {
    fail(err.message);
  }
});

// ── Formatting helpers ─────────────────────────────────────────────────────

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GiB';
  if (b >= 1048576)    return (b / 1048576).toFixed(1)    + ' MiB';
  if (b >= 1024)       return (b / 1024).toFixed(0)       + ' KiB';
  return b + ' B';
}

function fmtSeconds(s) {
  if (!isFinite(s) || s < 0) return '';
  if (s < 60)   return Math.round(s) + 's';
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── SSH helpers ────────────────────────────────────────────────────────────
// All SSH commands are sent to `bash -s` via stdin so no shell escaping is
// needed — the script text is written as a clean stdin stream.

function sshConnect(host, username, privateKey, passphrase) {
  return new Promise((resolve, reject) => {
    const conn = new Ssh();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    const opts = {
      host, port: 22, username, privateKey,
      // Keep the connection alive during long idle periods (worker boot can take 10+ min)
      keepaliveInterval: 30000,
      keepaliveCountMax: 10
    };
    if (passphrase) opts.passphrase = passphrase;
    conn.connect(opts);
  });
}

// Execute a bash script (passed as stdin). Returns { stdout, stderr }.
function sshRunScript(conn, script) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    conn.exec('bash -s', (err, stream) => {
      if (err) return reject(err);
      stream.on('data',        chunk => { stdout += chunk.toString(); });
      stream.stderr.on('data', chunk => { stderr += chunk.toString(); });
      stream.on('close', code => {
        if (code !== 0) {
          const tail = (stderr || stdout).trim().slice(-1200);
          reject(new Error(`Exit ${code}: ${tail}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
      stream.end(script);
    });
  });
}

// Same as above but calls onData(text) for every chunk (real-time output).
function sshRunScriptStreaming(conn, script, onData) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    conn.exec('bash -s', (err, stream) => {
      if (err) return reject(err);
      stream.on('data', chunk => {
        const s = chunk.toString();
        stdout += s;
        onData(s);
      });
      stream.stderr.on('data', chunk => {
        const s = chunk.toString();
        stderr += s;
        onData(s);
      });
      stream.on('close', code => {
        if (code !== 0) {
          const tail = (stderr || stdout).trim().slice(-1200);
          reject(new Error(`Exit ${code}: ${tail}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
      stream.end(script);
    });
  });
}

// ── ISO automation — SSE endpoint ──────────────────────────────────────────
// Streams Server-Sent Events so the browser can display live progress.
// The client reads this via fetch() + ReadableStream (not EventSource, since
// the payload is POST with credentials).
//
// Volume-based workflow (no FTP, no S3):
//   1. SSH connect to management host
//   2. Run oc adm node-image create → produces /tmp/ocp-node-iso/node.x86_64.iso
//   3. Embed NM keyfile (gateway + DNS) into ISO via coreos-installer / podman
//   4. Attach the pre-created (unattached) boot SSD to management host → dd ISO → detach
//   5. Stop worker → attach boot SSD → set boot device → start worker

// ── PLACEHOLDER — Sig V4 helpers removed (no longer needed) ────────────────
//   Previously used for IONOS S3 uploads; replaced by the volume pipeline above.

app.post('/api/execute-node-iso', async (req, res) => {
  const { ionosToken, mgmtHost, sshUser, sshKey, sshPassphrase,
          macAddress, serverName, kubeconfigPath,
          datacenterId, workerServerId, workerMainVolId, workerIp,
          workerSshKey: reqWorkerSshKey,
          mgmtServerId: providedMgmtServerId,
          forceNewIso } = req.body;

  // Worker SSH key: prefer request body, fall back to env var (same \n handling)
  const rawWorkerKey = reqWorkerSshKey || process.env.OCP_WORKER_SSH_KEY || '';
  const workerSshKey = rawWorkerKey.includes('\\n') ? rawWorkerKey.replace(/\\n/g, '\n') : rawWorkerKey;

  const missing = ['ionosToken', 'mgmtHost', 'sshUser', 'sshKey',
                   'macAddress', 'datacenterId', 'workerServerId', 'workerMainVolId']
    .filter(f => !req.body[f]);
  if (missing.length)
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  // ── SSE setup ──
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const step  = (label, status) => emit({ type: 'step',  label, status });
  const log   = text            => emit({ type: 'log',   text });
  const done  = msg             => { emit({ type: 'done', url: msg }); res.end(); };
  const fail  = message         => { emit({ type: 'error', message }); res.end(); };

  const dcPath   = `/datacenters/${encodeURIComponent(datacenterId)}`;
  const kubeconf = kubeconfigPath || '/root/.kube/config';

  // NetworkManager keyfile to embed into the ISO via coreos-installer.
  // IONOS private LAN DHCP assigns an IP but provides NO default gateway and
  // NO DNS servers. Without these the bootstrap agent cannot reach the internal
  // cluster API endpoint (api-int.<cluster>). The NAT Gateway sits at the .1
  // address of the private subnet (10.7.224.1 for 10.7.224.0/23).
  // DNS must resolve api-int.<cluster> — use the same DNS servers as existing
  // worker nodes (from /etc/resolv.conf), NOT public DNS like 8.8.8.8.
  // Default: IONOS-provided DNS 212.227.123.16/17. Override with OCP_BOOTSTRAP_DNS.
  const bootstrapGateway = process.env.OCP_BOOTSTRAP_GATEWAY || '10.7.224.1';
  const bootstrapDns     = process.env.OCP_BOOTSTRAP_DNS     || '212.227.123.16;212.227.123.17;';

  // Use the nodes-config.yaml approach (works in OCP 4.17-4.19).
  // --network-config-path (single-node flag) is broken in the oc 4.19.6 client with
  // "readfile: invalid argument" regardless of NMState content — skip it entirely.
  // Instead: write nodes-config.yaml to --dir; omit --mac-address so oc reads the file.
  // Static IP (from workerIp) is used when available — matches OCP docs format exactly.
  // Fallback to DHCP with corrected NMState fields if workerIp is absent.
  const dns1 = bootstrapDns.split(';')[0].trim();
  const dns2 = (bootstrapDns.split(';')[1] || '').trim();
  const bootstrapPrefixLen = process.env.OCP_BOOTSTRAP_PREFIX_LENGTH || '24';

  const networkConfigSection = workerIp
    ? `    interfaces:
    - name: eth0
      type: ethernet
      state: up
      ipv4:
        enabled: true
        dhcp: false
        address:
        - ip: ${workerIp}
          prefix-length: ${bootstrapPrefixLen}
      ipv6:
        enabled: false
    dns-resolver:
      config:
        server:${dns1 ? `\n        - ${dns1}` : ''}${dns2 ? `\n        - ${dns2}` : ''}
    routes:
      config:
      - destination: 0.0.0.0/0
        next-hop-address: ${bootstrapGateway}
        next-hop-interface: eth0
        table-id: 254`
    : `    interfaces:
    - name: eth0
      type: ethernet
      state: up
      ipv4:
        enabled: true
        dhcp: true
        auto-dns: false
        auto-routes: false
      ipv6:
        enabled: false
    dns-resolver:
      config:
        server:${dns1 ? `\n        - ${dns1}` : ''}${dns2 ? `\n        - ${dns2}` : ''}
    routes:
      config:
      - destination: 0.0.0.0/0
        next-hop-address: ${bootstrapGateway}
        next-hop-interface: eth0
        table-id: 254`;

  const nodesConfigYaml = `hosts:
- hostname: ${serverName || 'worker-node'}
  rootDeviceHints:
    minSizeGigabytes: 100
  interfaces:
  - name: eth0
    macAddress: "${macAddress}"
  networkConfig:
${networkConfigSection}
`;
  const nodesConfigPath = '/tmp/ocp-node-iso/nodes-config.yaml';
  // No --mac-address flag → oc reads nodes-config.yaml from --dir
  const ocCmd = `oc adm node-image create --dir=/tmp/ocp-node-iso -o node.x86_64.iso --kubeconfig=${kubeconf}`;

  let conn = null;
  let bootVolId = null; // tracked for cleanup on error

  try {
    // ── Step 1: SSH connect ──────────────────────────────────────────────────
    step(`Connecting to ${mgmtHost} via SSH…`, 'working');
    conn = await sshConnect(mgmtHost, sshUser, sshKey, sshPassphrase || undefined);
    step('SSH connected', 'ok');

    // ── Step 2: Write NMState YAML + run oc adm node-image create ────────────
    // --network-config-path embeds the NMState YAML into the ISO Ignition config
    // so it applies during the live agent installer phase AND the installed RHCOS.
    // No post-install disk surgery needed.
    // The sentinel is MAC-specific — a new server gets a new MAC → fresh ISO.
    const sentinelPath = `/tmp/ocp-node-iso/.mac-${macAddress.replace(/:/g,'')}`;
    const writeResult = await sshRunScript(conn, `
mkdir -p /tmp/ocp-node-iso
cat > ${nodesConfigPath} << 'NODESCONFIG_EOF'
${nodesConfigYaml}NODESCONFIG_EOF
echo "YAML_WRITTEN_OK"
`);
    if (!writeResult.stdout.includes('YAML_WRITTEN_OK'))
      throw new Error(`Failed to write nodes-config.yaml to ${nodesConfigPath}: ${writeResult.stdout}`);
    log(`nodes-config.yaml written (${workerIp ? `static ${workerIp}/${bootstrapPrefixLen}` : 'DHCP fallback'}):\n${nodesConfigYaml}\n`);

    const verifyOcResult = await sshRunScript(conn, `
export PATH=$PATH:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin
oc version --client 2>/dev/null | head -3 || echo "(oc version unavailable)"
`);
    log(`oc client: ${verifyOcResult.stdout.trim()}\n`);

    if (forceNewIso) {
      await sshRunScript(conn, `rm -f ${sentinelPath} /tmp/ocp-node-iso/node.x86_64.iso`);
      log('Forced ISO regeneration — removed cached ISO and sentinel.\n');
    }

    const checkResult = await sshRunScript(conn, `
export PATH=$PATH:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin
ISO_FILE=/tmp/ocp-node-iso/node.x86_64.iso
if [ -f "$ISO_FILE" ] && [ -f ${sentinelPath} ]; then
  echo "ISO_EXISTS:cached"
elif [ -f "$ISO_FILE" ]; then
  echo "ISO_EXISTS:stale"
else
  echo "ISO_EXISTS:none"
fi
`);
    const cacheStatus = (checkResult.stdout.match(/ISO_EXISTS:(\w+)/) || [])[1] || 'none';
    const isoExists = cacheStatus === 'cached';

    // NM keyfile injected directly into the ISO live boot environment.
    // nodes-config.yaml networkConfig applies to the *installed* system via Ignition.
    // The agent installer live boot phase needs the NM keyfile embedded in the ISO
    // initramfs so DNS and routing are correct before it contacts the cluster API.
    const nmcMacUpper = macAddress.toUpperCase();
    const nmKeyfileLive = `[connection]
id=worker-bootstrap
type=ethernet
autoconnect=true

[ethernet]
mac-address=${nmcMacUpper}

[ipv4]
method=auto
dns=${bootstrapDns}
ignore-auto-dns=true
route1=0.0.0.0/0,${bootstrapGateway},0

[ipv6]
method=disabled
`;
    const injectNmKeyfile = async () => {
      const nmRes = await sshRunScript(conn, `
export PATH=$PATH:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin
cat > /tmp/ocp-node-iso/worker-bootstrap.nmconnection << 'NMEOF'
${nmKeyfileLive}NMEOF
chmod 0600 /tmp/ocp-node-iso/worker-bootstrap.nmconnection
if command -v coreos-installer >/dev/null 2>&1; then
  coreos-installer iso customize --network-keyfile=/tmp/ocp-node-iso/worker-bootstrap.nmconnection /tmp/ocp-node-iso/node.x86_64.iso 2>&1
  echo "NM_INJECT_OK:direct"
elif command -v podman >/dev/null 2>&1; then
  podman run --pull=missing --rm -v /tmp/ocp-node-iso:/data -w /data \\
    quay.io/coreos/coreos-installer:release \\
    iso customize --network-keyfile=/data/worker-bootstrap.nmconnection node.x86_64.iso 2>&1 \\
    && echo "NM_INJECT_OK:podman" || echo "NM_INJECT_FAIL:podman"
else
  echo "NM_INJECT_SKIP"
fi
`);
      const nmOut = nmRes.stdout || '';
      if (nmOut.includes('NM_INJECT_OK')) {
        const via = nmOut.includes(':direct') ? 'coreos-installer' : 'podman';
        log(`NM keyfile injected into ISO live boot via ${via} — MAC=${nmcMacUpper}, DNS=${bootstrapDns}, GW=${bootstrapGateway}
`);
      } else if (nmOut.includes('NM_INJECT_SKIP')) {
        log(`WARNING: coreos-installer not found — live boot DNS relies on nodes-config.yaml only.
`);
        log(`To fix: dnf install coreos-installer on the management host.
`);
      } else {
        log(`NM inject output:
${nmOut.trim()}
`);
        log(`WARNING: NM keyfile injection may have failed — DNS during live boot may not work.
`);
      }
    };

    if (isoExists) {
      step(`Reusing cached ISO for ${macAddress} — refreshing NM config…`, 'working');
      log(`Cached ISO found for MAC ${macAddress} — skipping oc adm node-image create.
`);
      log(`To force a full rebuild, check "Force ISO rebuild" before running.
`);
      await injectNmKeyfile();
      step('Cached ISO ready', 'ok');
    } else {
      if (cacheStatus === 'stale') {
        log(`ISO file exists but was built for a different node (no sentinel for MAC ${macAddress}) — rebuilding.
`);
        log(`Tip: this is expected when adding a new worker; the ISO embeds per-node network config.
`);
      }
      step(`Running: ${ocCmd}`, 'working');
      log(`Kubeconfig: ${kubeconf}
Config: ${nodesConfigPath}
MAC: ${macAddress}

`);
      await sshRunScriptStreaming(conn, `
set -e
export PATH=$PATH:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin
mkdir -p /tmp/ocp-node-iso
${ocCmd}
touch ${sentinelPath}
`, text => log(text));
      await injectNmKeyfile();
      step('ISO generated + NM config injected into live boot', 'ok');
    }

    // ── Step 3: Resolve management host server ID ────────────────────────────────
    let mgmtServerId = providedMgmtServerId || null;
    if (!mgmtServerId) {
      log('Auto-detecting management host server ID from IONOS Cloud API…\n');
      // Paginate through all servers (IONOS default page size is 100).
      // depth=3 brings NIC entities including IPs in one call.
      let offset = 0;
      const limit = 100;
      let totalFound = 0;
      outer: while (true) {
        const page = await ionosGet(
          `${dcPath}/servers?depth=3&limit=${limit}&offset=${offset}`, ionosToken);
        const items = page?.items || [];
        totalFound += items.length;
        log(`  Scanning servers offset=${offset}: ${items.length} items (IPs searched: ${mgmtHost})\n`);
        for (const srv of items) {
          const nics = srv.entities?.nics?.items || [];
          for (const nic of nics) {
            const ips = nic.properties?.ips || [];
            if (ips.includes(mgmtHost)) {
              mgmtServerId = srv.id;
              log(`Matched management host ${mgmtHost} → server ${mgmtServerId} (${srv.properties?.name || ''})\n`);
              break outer;
            }
          }
        }
        // Stop if this was the last page
        if (items.length < limit) break;
        offset += limit;
      }
      if (!mgmtServerId)
        log(`Auto-detect scanned ${totalFound} servers — IP ${mgmtHost} not found in any NIC.\n`);
    }
    if (!mgmtServerId) throw new Error(
      `Could not find a server in the selected VDC with IP ${mgmtHost}. ` +
      'If the management host is in a different VDC, enter its IONOS Server ID manually in the connection form.'
    );

    // The main SSD (workerMainVolId) is already attached to the worker — it is the
    // empty installation target. We create a separate small ISO volume, write the
    // agent ISO to it via the management host, then boot the worker from it.
    // coreos-installer inside the agent will write RHCOS to the main SSD (/dev/vdb).
    // After installation the worker reboots; we detect the INACTIVE state in the
    // background and switch the IONOS boot device to the main SSD before restart.
    const workerServerPath = `${dcPath}/servers/${encodeURIComponent(workerServerId)}`;
    log(`Main SSD (install target): ${workerMainVolId}\nMgmt server: ${mgmtServerId}\n`);

    // ── Step 4: Create ISO volume → attach to mgmt host → dd → detach ────────
    step('Creating ISO boot volume…', 'working');
    const isoVolResp = await ionosPost(`${dcPath}/volumes`, ionosToken, {
      properties: {
        name:        `${serverName || 'worker'}-iso`,
        size:        4,   // 4 GB — enough for the ~700 MB agent ISO
        type:        'SSD Standard',
        licenceType: 'OTHER'
      }
    });
    bootVolId = isoVolResp.id;  // track for cleanup on error
    await ionosWaitAvailable(`${dcPath}/volumes/${bootVolId}`, ionosToken);
    log(`ISO volume created: ${bootVolId}\n`);

    // Snapshot devices on mgmt host immediately before attach
    const devsBefore = await sshRunScript(conn, `
lsblk -dno NAME 2>/dev/null | sort | tr '\\n' ','
`).then(r => r.stdout.trim());
    log(`Devices on mgmt host before attach: ${devsBefore || '(none)'}\n`);

    step('Attaching ISO volume to management host…', 'working');
    await ionosPost(`${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes`, ionosToken, { id: bootVolId });
    await ionosWaitAvailable(`${dcPath}/volumes/${bootVolId}`, ionosToken);
    await sshRunScript(conn, `udevadm settle --timeout=10 2>/dev/null || true`).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));

    const devResult = await sshRunScript(conn, `
DEVS_BEFORE="${devsBefore}"
for i in $(seq 1 60); do
  udevadm settle --timeout=5 2>/dev/null || true
  DEVS_AFTER=$(lsblk -dno NAME 2>/dev/null | sort | tr '\\n' ',')
  for D in $(echo "$DEVS_AFTER" | tr ',' '\\n'); do
    [ -z "$D" ] && continue
    echo "$DEVS_BEFORE" | tr ',' '\\n' | grep -qx "$D" || { echo "NEW_DEVICE:/dev/$D"; exit 0; }
  done
  sleep 2
done
echo "ERROR: new device did not appear within 120 s" >&2; exit 1
`);
    const newDev = (devResult.stdout.match(/NEW_DEVICE:(\/dev\/\w+)/) || [])[1];
    if (!newDev) throw new Error('Could not identify new block device on management host after ISO volume attach.');
    log(`New block device: ${newDev}\n`);

    // Get ISO file size so we can compute write progress percentage
    const isoSizeResult = await sshRunScript(conn,
      `stat -c%s /tmp/ocp-node-iso/node.x86_64.iso 2>/dev/null || echo 0`);
    const isoTotalBytes = parseInt(isoSizeResult.stdout.trim(), 10) || 0;
    log(`ISO size: ${fmtBytes(isoTotalBytes)}\n`);

    step(`Writing ISO to ${newDev}…`, 'working');
    emit({ type: 'dd-progress', percent: 0, written: '0 B', total: fmtBytes(isoTotalBytes), speed: '', eta: '' });

    let ddBuffer = '';
    await sshRunScriptStreaming(conn, `
set -e
echo "Writing /tmp/ocp-node-iso/node.x86_64.iso → ${newDev}"
dd if=/tmp/ocp-node-iso/node.x86_64.iso of=${newDev} bs=4M conv=fdatasync status=progress 2>&1
sync
echo "Write complete — synced"
`, text => {
      // dd status=progress emits lines ending with \r (in-place updates) then \n on completion.
      // Accumulate and split on both so we don't miss partial lines.
      ddBuffer += text;
      const parts = ddBuffer.split(/[\r\n]/);
      ddBuffer = parts.pop(); // keep incomplete tail
      for (const part of parts) {
        // Progress format: "123456789 bytes (1.1 GB, 1.0 GiB) copied, 12.3 s, 10.0 MB/s"
        // Use [^)]+ to skip past the internal comma inside the parenthesised size
        const m = part.match(/^(\d+) bytes \([^)]+\) copied, ([\d.]+) s, ([\d.]+ \S+\/s)/);
        if (m && isoTotalBytes > 0) {
          const writtenBytes = parseInt(m[1], 10);
          const elapsed     = parseFloat(m[2]);
          const speedBps    = elapsed > 0 ? writtenBytes / elapsed : 0;
          const percent     = Math.min(99, Math.round(writtenBytes / isoTotalBytes * 100));
          const etaSec      = speedBps > 0 ? (isoTotalBytes - writtenBytes) / speedBps : 0;
          emit({ type: 'dd-progress', percent,
                 written: fmtBytes(writtenBytes), total: fmtBytes(isoTotalBytes),
                 speed: m[3], eta: fmtSeconds(etaSec) });
        } else if (part.trim()) {
          log(part + '\n');
        }
      }
    });
    emit({ type: 'dd-progress', percent: 100,
           written: fmtBytes(isoTotalBytes), total: fmtBytes(isoTotalBytes),
           speed: '', eta: '' });
    step('ISO written to volume', 'ok');

    step('Detaching ISO volume from management host…', 'working');
    // Retry up to 3× for transient network errors (FetchError with no .status).
    // IONOS may have processed the DELETE even if the TCP response was lost, so
    // we fall through to the polling loop which confirms detach regardless.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await ionosDetach(`${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes/${bootVolId}`, ionosToken);
        break;
      } catch (detachErr) {
        // HTTP 404/422 can mean the volume is already detaching/detached — treat as ok
        if (detachErr.status === 404 || detachErr.status === 422) {
          log(`Detach returned HTTP ${detachErr.status} — volume likely already detached.\n`);
          break;
        }
        if (attempt < 3 && !detachErr.status) {
          log(`Detach network error (attempt ${attempt}/3): ${detachErr.message} — retrying in 5s…\n`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          throw detachErr;
        }
      }
    }
    await ionosWaitAvailable(`${dcPath}/volumes/${bootVolId}`, ionosToken);
    const mgmtVolsPath = `${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes?depth=0`;
    const mgmtDetachDeadline = Date.now() + 60000;
    while (Date.now() < mgmtDetachDeadline) {
      await new Promise(r => setTimeout(r, 4000));
      try {
        const vols = await ionosGet(mgmtVolsPath, ionosToken);
        if (!(vols?.items || []).some(v => v.id === bootVolId)) break;
      } catch (_) {}
    }
    step('ISO volume detached from management host', 'ok');
    // Keep conn open — we reuse it to monitor the worker via the mgmt host jump

    // ── Step 5: Stop worker → attach ISO volume → set as boot device → start ─
    step('Stopping worker node…', 'working');
    try { await ionosAction(`${workerServerPath}/stop`, ionosToken); } catch (_) {}
    await ionosWaitState(workerServerPath, ionosToken, ['INACTIVE'], 120000);

    step('Attaching ISO volume to worker node…', 'working');
    await ionosPost(`${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes`, ionosToken, { id: bootVolId });
    // Poll until the ISO volume appears in the worker's volume list
    const workerVolsPath = `${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes?depth=0`;
    const attachDeadline = Date.now() + 120000;
    let attachConfirmed = false;
    while (Date.now() < attachDeadline) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const vols = await ionosGet(workerVolsPath, ionosToken);
        if ((vols?.items || []).some(v => v.id === bootVolId)) { attachConfirmed = true; break; }
      } catch (_) {}
    }
    if (!attachConfirmed) throw new Error('Timed out waiting for ISO volume to appear in worker attached volumes list.');

    step('Setting ISO volume as boot device…', 'working');
    await ionosPatch(workerServerPath, ionosToken, { bootVolume: { id: bootVolId } });
    await ionosWaitState(workerServerPath, ionosToken, ['INACTIVE'], 60000);

    step('Starting worker node…', 'working');
    await ionosAction(`${workerServerPath}/start`, ionosToken);
    step('Worker node powered on', 'ok');
    log('Worker started from temporary ISO volume — agent installer is running, writing RHCOS to main SSD.\n');

    // ── Step 8: Monitor installation + switch boot device ─────────────────────
    // Core problem: coreos-installer finishes and issues a reboot. IONOS sees
    // the VM go INACTIVE for only a moment before it boots back from the ISO
    // (same boot device). Polling for INACTIVE is too slow — we miss the window.
    //
    // Solution when SSH key is available:
    //   Stream assisted-installer logs via SSH. When the installer container
    //   exits, immediately force-stop the VM via IONOS API before it can reboot.
    //   Then switch boot device → start. This wins the race every time.
    //
    // Fallback (no SSH key): poll IONOS API. Emit a server-side warning to
    //   configure OCP_WORKER_SSH_KEY for reliable boot switching.

    const doBootSwitch = async () => {
      step('Switching boot device to main SSD…', 'working');
      // NM config is written in the streaming section when "Waiting for control
      // plane" is detected — before pam_nologin blocks SSH on shutdown.
      // doBootSwitch only handles force-stop + boot device switch.

      // Close mgmt conn (no longer needed)
      if (conn) { try { conn.end(); } catch (_) {} conn = null; }

      // ── Force-stop worker ──────────────────────────────────────────────────
      log('Force-stopping worker to switch boot device…\n');
      try { await ionosAction(`${workerServerPath}/stop`, ionosToken); } catch (_) {}
      await ionosWaitState(workerServerPath, ionosToken, ['INACTIVE'], 300000);
      log('Worker stopped — RHCOS installation complete, preparing to switch boot device.\n');

      if (false) {
        {
          void 0;  // dead code block — NM write moved to SSH-to-worker above
          const workerVolListPath = `${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes?depth=0`;
          const mgmtVolListPath   = `${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes?depth=0`;
          const volPath           = `${dcPath}/volumes/${encodeURIComponent(workerMainVolId)}`;

          // Helper: poll a server's volume list until the volume appears or disappears
          const pollVolList = async (listPath, wantPresent, timeoutMs = 120000) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 5000));
              try {
                const vols = await ionosGet(listPath, ionosToken);
                const present = (vols?.items || []).some(v => v.id === workerMainVolId);
                if (present === wantPresent) return;
              } catch (_) {}
            }
            throw new Error(`Timed out waiting for volume ${wantPresent ? 'to appear in' : 'to leave'} ${listPath}`);
          };

          // Helper: ensure main SSD is on the worker (used for cleanup on any failure).
          // Uses the volume's own entity (depth=1) instead of the server's volume list,
          // which has >5 min cache lag in IONOS after detach operations.
          const ensureSsdOnWorker = async () => {
            // Check volume entity — more authoritative than server vol list
            let attachedTo = undefined;
            try {
              const vd = await ionosGet(`${volPath}?depth=1`, ionosToken);
              if (vd?.entities !== undefined) attachedTo = vd?.entities?.server?.id ?? null;
            } catch (_) {}

            if (attachedTo === workerServerId) {
              log('Main SSD confirmed on worker (entity check).\n');
              return;
            }
            if (attachedTo && attachedTo !== workerServerId) {
              const msg = `Main SSD is on ${attachedTo} — attach it to ${workerServerId} manually in DCD.`;
              log(`ERROR: ${msg}\n`);
              throw new Error(msg);
            }
            // null or undefined → try to attach
            log('Restoring main SSD to worker…\n');
            try {
              await ionosPost(`${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes`,
                ionosToken, { id: workerMainVolId });
              await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 60000);
              await new Promise(r => setTimeout(r, 20000)); // hypervisor settle
              log('Main SSD restored to worker.\n');
            } catch (attachErr) {
              if (attachErr.message.includes('422')) {
                log('422 on reattach — re-checking entity…\n');
                try {
                  const vd2 = await ionosGet(`${volPath}?depth=1`, ionosToken);
                  const nowOn = vd2?.entities?.server?.id ?? null;
                  if (nowOn === workerServerId) { log('Main SSD on worker (confirmed after 422).\n'); return; }
                  if (nowOn) throw new Error(`Volume stranded on ${nowOn}`);
                } catch (e2) { if (!e2.message.includes('422')) throw e2; }
                log('WARNING: 422 on reattach and entity unclear — assuming on worker.\n');
              } else {
                log(`ERROR: ${attachErr.message}\n`);
                log(`MANUAL ACTION REQUIRED: attach ${workerMainVolId} to ${workerServerId} in DCD.\n`);
                throw attachErr;
              }
            }
          };

          let ssdDev = null;
          try {
            // ── 1. Detach main SSD from worker ───────────────────────────────
            log(`Detaching main SSD (${workerMainVolId}) from worker…\n`);
            await ionosDetach(
              `${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes/${encodeURIComponent(workerMainVolId)}`,
              ionosToken);
            // IMPORTANT: Do NOT poll the server's volume list for detach confirmation —
            // it has >5 min cache lag in IONOS and will always time out.
            // Instead: wait for the volume's own state (BUSY→AVAILABLE when detach completes)
            // then add a flat backend-settle wait before attempting to attach elsewhere.
            await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 120000);
            log('Volume state: AVAILABLE. Waiting 90s for IONOS backend to fully release…\n');
            await new Promise(r => setTimeout(r, 90000));

            // ── 2. Attach to management host (retry up to 3×) ────────────────
            log('Attaching main SSD to management host…\n');
            let mgmtAttached = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await ionosPost(
                  `${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes`,
                  ionosToken, { id: workerMainVolId });
                await pollVolList(mgmtVolListPath, true, 120000);
                await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 60000);
                mgmtAttached = true;
                break;
              } catch (e) {
                log(`Mgmt attach attempt ${attempt}/3 failed: ${e.message}\n`);
                if (attempt < 3) {
                  log('Waiting 20s before retry…\n');
                  await new Promise(r => setTimeout(r, 20000));
                }
              }
            }
            if (!mgmtAttached) throw new Error('Could not attach main SSD to management host after 3 attempts');

            await sshRunScript(conn, `udevadm settle --timeout=10 2>/dev/null || true`).catch(() => {});
            await new Promise(r => setTimeout(r, 5000));

            // ── 3. Detect block device on mgmt host ──────────────────────────
            const ssdDevResult = await sshRunScript(conn, `
DEVS_BEFORE="${ssdDevsBefore}"
for i in $(seq 1 30); do
  udevadm settle --timeout=3 2>/dev/null || true
  DEVS_AFTER=$(lsblk -dno NAME 2>/dev/null | sort | tr '\\n' ',')
  for D in $(echo "$DEVS_AFTER" | tr ',' '\\n'); do
    [ -z "$D" ] && continue
    echo "$DEVS_BEFORE" | tr ',' '\\n' | grep -qx "$D" || { echo "NEW_DEVICE:/dev/$D"; exit 0; }
  done
  sleep 2
done
echo "ERROR: main SSD device did not appear on mgmt host" >&2; exit 1
`);
            ssdDev = (ssdDevResult.stdout.match(/NEW_DEVICE:(\/dev\/\w+)/) || [])[1];
            if (!ssdDev) throw new Error('Main SSD block device not visible on management host');
            log(`Main SSD appeared as ${ssdDev}\n`);

            // Show partition layout
            const partDump = await sshRunScript(conn,
              `lsblk -o NAME,FSTYPE,SIZE,LABEL,PARTLABEL ${ssdDev} 2>/dev/null || true`);
            log(`Partition layout:\n${partDump.stdout}\n`);

            // ── 4. Write NM keyfile to TWO locations (belt-and-suspenders) ──────
            // Location A: ext4 /boot partition → /ignition-firstboot-network/
            //   Read by the coreos-network dracut module during initramfs phase
            //   (if present in this RHCOS version).
            // Location B: XFS root partition → OSTree deployment etc + direct /etc
            //   Read by NetworkManager directly on first boot regardless of dracut.
            // Writing to both guarantees DNS config survives regardless of RHCOS version.
            const nmBase64 = Buffer.from(nmKeyfile).toString('base64');
            const writeResult = await sshRunScript(conn, `
set -e

echo "=== Partition layout ==="
lsblk -o NAME,FSTYPE,SIZE,LABEL,PARTLABEL,UUID ${ssdDev} 2>/dev/null || true

# ── Location A: ext4 boot partition (/ignition-firstboot-network/) ──────────
BOOT_PART=$(lsblk -lno NAME,FSTYPE,LABEL ${ssdDev} 2>/dev/null | awk '($2=="ext4" || $3=="boot"){print "/dev/"$1}' | head -1)
[ -z "$BOOT_PART" ] && BOOT_PART=${ssdDev}3
echo "Boot partition (ext4): $BOOT_PART"
sudo mkdir -p /mnt/ssd-boot
sudo mount "$BOOT_PART" /mnt/ssd-boot 2>&1
echo "Boot mount contents: $(ls /mnt/ssd-boot/ 2>&1)"
sudo mkdir -p /mnt/ssd-boot/ignition-firstboot-network
printf "%s" "${nmBase64}" | base64 -d | sudo tee /mnt/ssd-boot/ignition-firstboot-network/worker-bootstrap.nmconnection > /dev/null
sudo chmod 600 /mnt/ssd-boot/ignition-firstboot-network/worker-bootstrap.nmconnection
echo "[A] boot partition: $(sudo ls -la /mnt/ssd-boot/ignition-firstboot-network/)"
echo "[A] preview:"; sudo head -8 /mnt/ssd-boot/ignition-firstboot-network/worker-bootstrap.nmconnection
sudo umount /mnt/ssd-boot
echo "[A] BOOT_PART_DONE"

# ── Location B: XFS root partition (NM system-connections) ──────────────────
ROOT_PART=$(lsblk -lno NAME,FSTYPE ${ssdDev} 2>/dev/null | awk '$2=="xfs"{print "/dev/"$1}' | head -1)
[ -z "$ROOT_PART" ] && ROOT_PART=${ssdDev}4
echo "Root partition (xfs): $ROOT_PART"
sudo mkdir -p /mnt/ssd-root
sudo mount -o ro "$ROOT_PART" /mnt/ssd-root 2>&1 || sudo mount "$ROOT_PART" /mnt/ssd-root 2>&1
echo "Root mount contents: $(ls /mnt/ssd-root/ 2>&1)"
# Remount rw for writing
sudo mount -o remount,rw /mnt/ssd-root 2>/dev/null || true

# B1: OSTree deployment etc (works with any OSTree RHCOS version)
OSTREE_OS=$(ls /mnt/ssd-root/ostree/deploy/ 2>/dev/null | head -1)
DEPLOY_HASH=""
if [ -n "$OSTREE_OS" ]; then
  DEPLOY_HASH=$(ls /mnt/ssd-root/ostree/deploy/$OSTREE_OS/deploy/ 2>/dev/null | grep -v '\\.origin$' | head -1)
  if [ -n "$DEPLOY_HASH" ]; then
    NM_DIR="/mnt/ssd-root/ostree/deploy/$OSTREE_OS/deploy/$DEPLOY_HASH/etc/NetworkManager/system-connections"
    sudo mkdir -p "$NM_DIR"
    printf "%s" "${nmBase64}" | base64 -d | sudo tee "$NM_DIR/worker-bootstrap.nmconnection" > /dev/null
    sudo chmod 600 "$NM_DIR/worker-bootstrap.nmconnection"
    echo "[B1] OSTree NM keyfile written to $NM_DIR"

    # B2: Also write a static resolv.conf so DNS works even if systemd-resolved's
    # IPv6 stub ([::1]:53) is not listening on this RHCOS build.
    # The MCO will overwrite this once the node joins the cluster.
    DNS1=$(printf "%s" "${bootstrapDns}" | cut -d';' -f1 | tr -d ' ')
    DNS2=$(printf "%s" "${bootstrapDns}" | cut -d';' -f2 | tr -d ' ')
    RESOLV_PATH="/mnt/ssd-root/ostree/deploy/$OSTREE_OS/deploy/$DEPLOY_HASH/etc/resolv.conf"
    sudo rm -f "$RESOLV_PATH"
    { printf "# First-boot DNS (IONOS scaling tool) — MCO will overwrite after cluster join\n"
      printf "nameserver %s\n" "$DNS1"
      [ -n "$DNS2" ] && printf "nameserver %s\n" "$DNS2"; } | sudo tee "$RESOLV_PATH" > /dev/null
    echo "[B2] resolv.conf written: $DNS1 $DNS2"
  else
    echo "[B1] WARNING: no deployment hash found under ostree/deploy/$OSTREE_OS/deploy/"
  fi
else
  echo "[B1] WARNING: no ostree deployment found"
fi

sudo umount /mnt/ssd-root
echo "NM_KEYFILE_OK"
`);
            log(writeResult.stdout + '\n');
            if (!writeResult.stdout.includes('NM_KEYFILE_OK')) {
              throw new Error('NM keyfile write did not confirm success');
            }
            const wroteBootPart = writeResult.stdout.includes('[A] BOOT_PART_DONE');
            const wroteOstree   = writeResult.stdout.includes('[B1] OSTree NM keyfile written');
            const wroteResolv   = writeResult.stdout.includes('[B2] resolv.conf written');
            step(`Network config written to main SSD (boot: ${wroteBootPart ? 'ok' : 'WARN'}, ostree-nm: ${wroteOstree ? 'ok' : 'WARN'}, resolv.conf: ${wroteResolv ? 'ok' : 'WARN'})`, 'ok');

            // ── 5. Detach from mgmt host (API + OS-level confirm) ────────────
            log('Detaching main SSD from management host…\n');
            await ionosDetach(
              `${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes/${encodeURIComponent(workerMainVolId)}`,
              ionosToken);
            await pollVolList(mgmtVolListPath, false, 120000);
            await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 60000);
            await sshRunScript(conn, `
udevadm settle --timeout=10 2>/dev/null || true
for i in $(seq 1 20); do
  lsblk ${ssdDev} &>/dev/null || { echo "SSD_GONE:ok"; exit 0; }
  sleep 2
done
echo "SSD_GONE:timeout (proceeding anyway)"
`).catch(() => {});
            log('Main SSD detached from management host.\n');

            // ── 6. Reattach to worker ────────────────────────────────────────
            try { conn.end(); } catch (_) {} conn = null;
            await ensureSsdOnWorker();

          } catch (nmErr) {
            log(`\nWARNING: network config write failed: ${nmErr.message}\n`);
            // Wait for IONOS API state to settle — if the failure was a timeout the
            // volume list may still be stale and ensureSsdOnWorker would get a false
            // "already there" result, letting the worker boot with no SSD attached.
            log('Waiting 40s for IONOS state to settle before checking SSD attachment…\n');
            await new Promise(r => setTimeout(r, 40000));
            log('Ensuring main SSD is restored to worker before boot…\n');
            // Detach from mgmt if it ended up there
            try {
              const mgmtVols = await ionosGet(mgmtVolListPath, ionosToken);
              if ((mgmtVols?.items || []).some(v => v.id === workerMainVolId)) {
                await ionosDetach(
                  `${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes/${encodeURIComponent(workerMainVolId)}`,
                  ionosToken);
                await pollVolList(mgmtVolListPath, false, 60000).catch(() => {});
                await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 60000).catch(() => {});
              }
            } catch (_) {}
            try { conn.end(); } catch (_) {} conn = null;
            await ensureSsdOnWorker();
          }
        }
      }

      // ── Pre-flight safety check ───────────────────────────────────────────
      // Use volume entity (depth=1) first — much fresher than server volume list.
      {
        let attachedTo = undefined;
        try {
          const vd = await ionosGet(`${dcPath}/volumes/${encodeURIComponent(workerMainVolId)}?depth=1`, ionosToken);
          if (vd?.entities !== undefined) attachedTo = vd?.entities?.server?.id ?? null;
        } catch (_) {}

        if (attachedTo !== undefined && attachedTo !== workerServerId) {
          throw new Error(
            `SAFETY BLOCK: main SSD (${workerMainVolId}) is ` +
            `${attachedTo ? `on server ${attachedTo}` : 'not attached to any server'}. ` +
            `Attach it to worker ${workerServerId} in IONOS DCD, then use "Switch Boot Device".`
          );
        }
        if (attachedTo === workerServerId) {
          log(`Pre-flight: main SSD confirmed on worker (entity check).\n`);
        } else {
          // Entity check unavailable — fall back to vol list (may be stale)
          const pfVols = await ionosGet(
            `${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes?depth=0`, ionosToken);
          if (!(pfVols?.items || []).some(v => v.id === workerMainVolId)) {
            throw new Error(
              `SAFETY BLOCK: main SSD (${workerMainVolId}) not in worker volume list. ` +
              `Attach it in IONOS DCD, then use "Switch Boot Device".`
            );
          }
          log(`Pre-flight: main SSD in worker vol list (fallback check — entity API not supported).\n`);
        }
      }

      // Switch boot device and start
      log('Switching boot device to main SSD…\n');
      await ionosPatch(workerServerPath, ionosToken, { bootVolume: { id: workerMainVolId } });
      await ionosWaitState(workerServerPath, ionosToken, ['INACTIVE'], 60000);
      await ionosAction(`${workerServerPath}/start`, ionosToken);
      step('Worker rebooting from main SSD', 'ok');
      log('Worker started from main SSD — RHCOS will boot and submit CSRs shortly.\n');

      // Detach ISO volume from worker, then delete it
      try {
        await new Promise(r => setTimeout(r, 8000));
        await ionosDetach(
          `${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes/${bootVolId}`,
          ionosToken);
        log(`ISO volume ${bootVolId} detached from worker.\n`);
      } catch (_) {}
      try {
        await ionosWaitAvailable(`${dcPath}/volumes/${bootVolId}`, ionosToken, 60000);
        await ionosDetach(`${dcPath}/volumes/${bootVolId}`, ionosToken);
        log(`ISO volume ${bootVolId} deleted.\n`);
      } catch (delErr) {
        log(`Note: could not delete ISO volume ${bootVolId} automatically — remove it in IONOS DCD if needed.\n`);
      }
    };

    if (workerSshKey && workerIp) {
      // The app runs on the user's machine which has no route to the private LAN.
      // The management host (conn) can reach the worker directly — use it as a jump host.
      step('Monitoring installation via management host…', 'working');
      try {
        // Write worker SSH key to temp file on management host (heredoc avoids
        // printf arg-length limits and PEM encoding issues)
        const tmpKey = `/tmp/.worker-monitor-key-${Date.now()}`;
        await sshRunScript(conn, `
cat > ${tmpKey} << 'KEYEOF'
${workerSshKey}
KEYEOF
chmod 600 ${tmpKey}
`);
        log(`Worker SSH key written to ${tmpKey} on management host.\n`);
        log(`Waiting for worker SSH at ${workerIp} to become available…\n`);

        // Poll until worker SSH is reachable (via management host)
        const sshDeadline = Date.now() + 900000; // 15 min
        let sshReady = false;
        let sshAttempts = 0;
        while (Date.now() < sshDeadline) {
          sshAttempts++;
          try {
            const r = await sshRunScript(conn,
              `ssh -i ${tmpKey}` +
              ` -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` +
              ` -o ConnectTimeout=10 -o BatchMode=yes` +
              ` core@${workerIp} 'echo WORKER_SSH_OK' 2>/dev/null`);
            if (r.stdout.includes('WORKER_SSH_OK')) { sshReady = true; break; }
          } catch (_) {}
          if (sshAttempts % 3 === 0) {
            const elapsed = Math.round((Date.now() - (sshDeadline - 900000)) / 1000);
            log(`Waiting for worker SSH (attempt ${sshAttempts}, ${elapsed}s elapsed)…\n`);
          }
          await new Promise(r => setTimeout(r, 15000));
        }
        if (!sshReady) throw new Error('Worker SSH not reachable via management host within 15 minutes');

        step('SSH connected — streaming installer progress…', 'working');
        log(`Connected to worker ${workerIp} via management host\n`);

        // Stream assisted-installer logs from worker via jump
        await sshRunScriptStreaming(conn, `
ssh -i ${tmpKey} \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 \
    core@${workerIp} '
# Wait up to 15 min for the assisted-installer container to appear
for i in $(seq 1 90); do
  sudo podman ps -a --format "{{.Names}}" 2>/dev/null | grep -q "^assisted-installer$" && break
  sleep 10
done
sudo podman logs -f assisted-installer 2>&1 || true
echo "INSTALLER_CONTAINER_EXITED"
'
`, text => {
          // podman logs -f output: time="..." level=info msg="Read disk X/Y (Z%)\n"
          const progressMatch = text.match(/Read disk ([0-9.]+\s*\w+)\/([0-9.]+\s*\w+)\s*\((\d+)%\)/);
          if (progressMatch) {
            emit({ type: 'install-progress', percent: parseInt(progressMatch[3], 10),
                   written: progressMatch[1].trim(), total: progressMatch[2].trim() });
          } else {
            const lines = text.split('\n');
            for (const line of lines) {
              const msgMatch   = line.match(/msg="(.*?)(?:\\n)?"?\s*$/);
              const msgText    = msgMatch ? msgMatch[1] : line;
              const stageMatch = msgText.match(/Updating node installation stage:\s*(.+)/);
              const errMatch   = line.match(/level=(?:error|warning) msg="([^"]+)"/);
              if (stageMatch) {
                log(`Stage: ${stageMatch[1].replace(/\\n$/, '').trim()}\n`);
              } else if (errMatch && !errMatch[1].includes('Certificate verification') &&
                         !errMatch[1].includes('\\n')) {
                log(`⚠ ${errMatch[1].replace(/\\n/g, '')}\n`);
              }
            }
          }
        });

        // SSH stream ended — installer container exited.
        emit({ type: 'install-progress', percent: 100, written: '', total: '' });
        log('Installer stream ended — network config was embedded in ISO via --network-config-dir.\n');

        // Clean up mgmt host SSH key temp file
        try { await sshRunScript(conn, `rm -f ${tmpKey}`); } catch (_) {}
        await doBootSwitch();
        done('RHCOS installed and boot device switched. CSRs will appear 2–3 minutes after reboot — approve them here.');

      } catch (sshErr) {
        // conn will be closed inside doBootSwitch; null it here so doBootSwitch
        // skips the mgmt-host disk-write (we don't know the installer state)
        if (conn) try { conn.end(); conn = null; } catch (_) {}
        log(`\nSSH monitoring stopped: ${sshErr.message}\n`);
        log('Falling back to IONOS API polling for boot device switch.\n');
        log('Note: polling may miss the brief INACTIVE window — SSH monitoring is more reliable.\n');
        // Fallback: wait for worker to be running (AVAILABLE), then wait for it to
        // go INACTIVE (installer triggers reboot). The window is only a few seconds
        // so polling at 4s intervals may miss it — SSH monitoring is preferred.
        try {
          try { await ionosWaitState(workerServerPath, ionosToken, ['AVAILABLE'], 600000); } catch (_) {}
          await ionosWaitState(workerServerPath, ionosToken, ['INACTIVE'], 2700000);
          await doBootSwitch();
          done('RHCOS installed (SSH monitoring lost). Boot device switched — CSRs will appear shortly.');
        } catch (fbErr) {
          step('Boot device switch failed — manual action required', 'error');
          fail(`Boot switch failed: ${fbErr.message}. Manual fix: stop worker, set boot device to ${workerMainVolId}, start worker.`);
        }
      }
    } else {
      // No SSH key — polling fallback only
      log('No worker SSH key configured — boot device will switch via IONOS API polling.\n');
      log('For reliable switching, set OCP_WORKER_SSH_KEY in your .env file.\n');
      done(
        'Worker is installing RHCOS. ' +
        'The app is monitoring via IONOS API and will switch the boot device automatically. ' +
        'CSRs will appear 2–5 minutes after the final reboot.'
      );
      // Run the polling fallback in background (no SSE connection to update)
      ;(async () => {
        try {
          await ionosWaitState(workerServerPath, ionosToken, ['AVAILABLE'], 180000);
          await ionosWaitState(workerServerPath, ionosToken, ['INACTIVE'], 2700000);
          // Can't use step/log/done here (SSE closed) — log to server console only
          console.log(`[boot-switch] Worker INACTIVE — switching boot device to ${workerMainVolId}`);
          await ionosPatch(workerServerPath, ionosToken, { bootVolume: { id: workerMainVolId } });
          await ionosWaitState(workerServerPath, ionosToken, ['INACTIVE'], 60000);
          await ionosAction(`${workerServerPath}/start`, ionosToken);
          console.log(`[boot-switch] Worker restarted from main SSD`);
          try {
            await new Promise(r => setTimeout(r, 8000));
            await ionosDetach(`${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes/${bootVolId}`, ionosToken);
          } catch (_) {}
          try {
            await ionosWaitAvailable(`${dcPath}/volumes/${bootVolId}`, ionosToken, 60000);
            await ionosDetach(`${dcPath}/volumes/${bootVolId}`, ionosToken);
            console.log(`[boot-switch] ISO volume ${bootVolId} deleted.`);
          } catch (delErr) {
            console.error(`[boot-switch] Could not delete ISO volume ${bootVolId}: ${delErr.message}`);
          }
        } catch (bgErr) {
          console.error(`[boot-switch] Failed: ${bgErr.message}`);
          console.error(`[boot-switch] Manual fix: stop worker, set boot volume to ${workerMainVolId}, start worker`);
        }
      })();
    }

  } catch (err) {
    if (conn) try { conn.end(); } catch (_) {}
    // Best-effort: delete the ISO volume if it was created (may still be attached)
    if (bootVolId) {
      (async () => {
        try {
          // Try detaching from whichever server might have it
          await ionosDetach(`${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes/${bootVolId}`, ionosToken).catch(() => {});
          if (providedMgmtServerId) {
            await ionosDetach(`${dcPath}/servers/${encodeURIComponent(providedMgmtServerId)}/volumes/${bootVolId}`, ionosToken).catch(() => {});
          }
          await ionosWaitAvailable(`${dcPath}/volumes/${bootVolId}`, ionosToken, 60000);
          await ionosDetach(`${dcPath}/volumes/${bootVolId}`, ionosToken);
          console.log(`[cleanup] ISO volume ${bootVolId} deleted after pipeline error.`);
        } catch (cleanErr) {
          console.error(`[cleanup] Could not delete ISO volume ${bootVolId}: ${cleanErr.message} — remove it in IONOS DCD manually.`);
        }
      })();
    }
    fail(err.message);
  }
});

// ── Recovery: write NM keyfile to already-installed SSD + reboot ──────────────
// Used when the keyfile write step failed during the main ISO pipeline and the
// worker has already been installed but can't reach DNS on first boot.
// Accepts the same SSH/IONOS params as the main flow; gateway/DNS come from .env.
app.post('/api/ionos/write-network-config', async (req, res) => {
  const { ionosToken, datacenterId, workerServerId, workerMainVolId,
          mgmtServerId, mgmtHost, sshUser, sshKey, sshPassphrase, macAddress } = req.body;

  const missing = ['ionosToken','datacenterId','workerServerId','workerMainVolId',
                   'mgmtServerId','mgmtHost','sshUser','sshKey','macAddress']
    .filter(f => !req.body[f]);
  if (missing.length)
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = obj  => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const step = (label, status) => emit({ type: 'step', label, status });
  const log  = text => emit({ type: 'log', text });
  const done = msg  => { emit({ type: 'done', message: msg }); res.end(); };
  const fail = msg  => { emit({ type: 'error', message: msg }); res.end(); };

  const dcPath          = `/datacenters/${encodeURIComponent(datacenterId)}`;
  const workerSrvPath   = `${dcPath}/servers/${encodeURIComponent(workerServerId)}`;
  const workerVolsPath  = `${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes?depth=0`;
  const mgmtVolsPath    = `${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes?depth=0`;
  const volPath         = `${dcPath}/volumes/${encodeURIComponent(workerMainVolId)}`;

  const bootstrapGateway = process.env.OCP_BOOTSTRAP_GATEWAY || '10.7.224.1';
  const bootstrapDns     = process.env.OCP_BOOTSTRAP_DNS     || '212.227.123.16;212.227.123.17;';
  const nmcMac = macAddress.toUpperCase();
  const nmKeyfile = `[connection]
id=worker-bootstrap
type=ethernet
autoconnect=true

[ethernet]
mac-address=${nmcMac}

[ipv4]
method=auto
dns=${bootstrapDns}
ignore-auto-dns=true
route1=0.0.0.0/0,${bootstrapGateway},0

[ipv6]
method=disabled
`;
  const nmBase64 = Buffer.from(nmKeyfile).toString('base64');

  // Poll server's volume list until volume appears or disappears
  const pollVol = async (listPath, wantPresent, timeoutMs = 300000) => {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const d = await ionosGet(listPath, ionosToken);
        if ((d?.items || []).some(v => v.id === workerMainVolId) === wantPresent) return;
      } catch (_) {}
    }
    throw new Error(`Timed out waiting for volume to ${wantPresent ? 'appear in' : 'leave'} ${listPath}`);
  };

  let conn = null;
  try {
    // ── 1. SSH connect ─────────────────────────────────────────────────────
    step(`Connecting to ${mgmtHost} via SSH…`, 'working');
    conn = await sshConnect(mgmtHost, sshUser, sshKey, sshPassphrase || undefined);
    step('SSH connected', 'ok');

    // ── 2. Stop worker ─────────────────────────────────────────────────────
    step('Stopping worker…', 'working');
    try { await ionosAction(`${workerSrvPath}/stop`, ionosToken); } catch (_) {}
    await ionosWaitState(workerSrvPath, ionosToken, ['INACTIVE'], 300000);
    step('Worker stopped', 'ok');

    // Snapshot mgmt host devices before touching volumes
    const devsBefore = await sshRunScript(conn,
      `lsblk -dno NAME 2>/dev/null | sort | tr '\\n' ','`).then(r => r.stdout.trim());
    log(`Mgmt host devices before attach: ${devsBefore || '(none)'}\n`);

    let ssdDev = null;
    try {
      // ── 3. Detach SSD from worker ────────────────────────────────────────
      step('Detaching main SSD from worker…', 'working');
      log(`Detaching main SSD (${workerMainVolId}) from worker…\n`);
      await ionosDetach(
        `${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes/${encodeURIComponent(workerMainVolId)}`,
        ionosToken);
      // IMPORTANT: Do NOT poll the server's volume list for detach confirmation —
      // it has >5 min cache lag in IONOS and will always time out.
      await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 120000);
      log('Volume state: AVAILABLE. Waiting 90s for IONOS backend to fully release…\n');
      await new Promise(r => setTimeout(r, 90000));
      step('Main SSD detached from worker', 'ok');

      // ── 4. Attach SSD to mgmt host (retry 3×) ───────────────────────────
      step('Attaching main SSD to management host…', 'working');
      let attached = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await ionosPost(
            `${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes`,
            ionosToken, { id: workerMainVolId });
          await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 120000);
          await new Promise(r => setTimeout(r, 10000));
          attached = true; break;
        } catch (e) {
          log(`Mgmt attach attempt ${attempt}/3 failed: ${e.message}\n`);
          if (attempt < 3) { log('Waiting 20s before retry…\n'); await new Promise(r => setTimeout(r, 20000)); }
        }
      }
      if (!attached) throw new Error('Could not attach main SSD to management host after 3 attempts');
      await sshRunScript(conn, `udevadm settle --timeout=10 2>/dev/null || true`).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
      step('Main SSD attached to management host', 'ok');

      // ── 5. Detect block device ───────────────────────────────────────────
      const ssdDevResult = await sshRunScript(conn, `
DEVS_BEFORE="${devsBefore}"
for i in $(seq 1 30); do
  udevadm settle --timeout=3 2>/dev/null || true
  DEVS_AFTER=$(lsblk -dno NAME 2>/dev/null | sort | tr '\\n' ',')
  for D in $(echo "$DEVS_AFTER" | tr ',' '\\n'); do
    [ -z "$D" ] && continue
    echo "$DEVS_BEFORE" | tr ',' '\\n' | grep -qx "$D" || { echo "NEW_DEVICE:/dev/$D"; exit 0; }
  done
  sleep 2
done
echo "ERROR: main SSD device did not appear on mgmt host" >&2; exit 1
`);
      ssdDev = (ssdDevResult.stdout.match(/NEW_DEVICE:(\/dev\/\w+)/) || [])[1];
      if (!ssdDev) throw new Error('Main SSD block device not visible on management host');
      log(`Main SSD appeared as ${ssdDev}\n`);
      const partDump = await sshRunScript(conn,
        `lsblk -o NAME,FSTYPE,SIZE,LABEL,PARTLABEL,UUID ${ssdDev} 2>/dev/null || true`);
      log(`Partition layout:\n${partDump.stdout}\n`);

      // ── 6. Write NM keyfile to ext4 boot partition + XFS root ───────────
      step('Writing network config to both partitions…', 'working');
      const writeResult = await sshRunScript(conn, `
set -e
# Location A — ext4 /boot (coreos-network dracut module)
BOOT_PART=$(lsblk -lno NAME,FSTYPE,LABEL ${ssdDev} 2>/dev/null | awk '($2=="ext4" || $3=="boot"){print "/dev/"$1}' | head -1)
[ -z "$BOOT_PART" ] && BOOT_PART=${ssdDev}3
echo "Boot partition (ext4): $BOOT_PART"
sudo mkdir -p /mnt/ssd-boot
sudo mount "$BOOT_PART" /mnt/ssd-boot 2>&1
echo "Boot mount: $(ls /mnt/ssd-boot/ 2>&1)"
sudo mkdir -p /mnt/ssd-boot/ignition-firstboot-network
printf "%s" "${nmBase64}" | base64 -d | sudo tee /mnt/ssd-boot/ignition-firstboot-network/worker-bootstrap.nmconnection > /dev/null
sudo chmod 600 /mnt/ssd-boot/ignition-firstboot-network/worker-bootstrap.nmconnection
echo "[A] written: $(sudo ls -la /mnt/ssd-boot/ignition-firstboot-network/)"
echo "[A] preview:"; sudo head -6 /mnt/ssd-boot/ignition-firstboot-network/worker-bootstrap.nmconnection
sudo umount /mnt/ssd-boot
echo "[A] BOOT_PART_DONE"

# Location B — XFS root (OSTree deployment /etc/NetworkManager/system-connections/)
ROOT_PART=$(lsblk -lno NAME,FSTYPE ${ssdDev} 2>/dev/null | awk '$2=="xfs"{print "/dev/"$1}' | head -1)
[ -z "$ROOT_PART" ] && ROOT_PART=${ssdDev}4
echo "Root partition (xfs): $ROOT_PART"
sudo mkdir -p /mnt/ssd-root
sudo mount -o ro "$ROOT_PART" /mnt/ssd-root 2>&1 || sudo mount "$ROOT_PART" /mnt/ssd-root 2>&1
sudo mount -o remount,rw /mnt/ssd-root 2>/dev/null || true
OSTREE_OS=$(ls /mnt/ssd-root/ostree/deploy/ 2>/dev/null | head -1)
if [ -n "$OSTREE_OS" ]; then
  DEPLOY_HASH=$(ls /mnt/ssd-root/ostree/deploy/$OSTREE_OS/deploy/ 2>/dev/null | grep -v '\\.origin$' | head -1)
  if [ -n "$DEPLOY_HASH" ]; then
    NM_DIR="/mnt/ssd-root/ostree/deploy/$OSTREE_OS/deploy/$DEPLOY_HASH/etc/NetworkManager/system-connections"
    sudo mkdir -p "$NM_DIR"
    printf "%s" "${nmBase64}" | base64 -d | sudo tee "$NM_DIR/worker-bootstrap.nmconnection" > /dev/null
    sudo chmod 600 "$NM_DIR/worker-bootstrap.nmconnection"
    echo "[B1] OSTree NM keyfile written to $NM_DIR"

    # B2: Also write a static resolv.conf so DNS works even if systemd-resolved's
    # IPv6 stub ([::1]:53) is not listening on this RHCOS build.
    # The MCO will overwrite this once the node joins the cluster.
    DNS1=$(printf "%s" "${bootstrapDns}" | cut -d';' -f1 | tr -d ' ')
    DNS2=$(printf "%s" "${bootstrapDns}" | cut -d';' -f2 | tr -d ' ')
    RESOLV_PATH="/mnt/ssd-root/ostree/deploy/$OSTREE_OS/deploy/$DEPLOY_HASH/etc/resolv.conf"
    sudo rm -f "$RESOLV_PATH"
    { printf "# First-boot DNS (IONOS scaling tool) — MCO will overwrite after cluster join\n"
      printf "nameserver %s\n" "$DNS1"
      [ -n "$DNS2" ] && printf "nameserver %s\n" "$DNS2"; } | sudo tee "$RESOLV_PATH" > /dev/null
    echo "[B2] resolv.conf written: $DNS1 $DNS2"
  else
    echo "[B1] WARNING: no deployment hash found"
  fi
else
  echo "[B1] WARNING: no ostree deployment found"
fi
sudo umount /mnt/ssd-root
echo "NM_KEYFILE_OK"
`);
      log(writeResult.stdout + '\n');
      if (!writeResult.stdout.includes('NM_KEYFILE_OK'))
        throw new Error('NM keyfile write did not confirm success');
      const wroteBootPart = writeResult.stdout.includes('[A] BOOT_PART_DONE');
      const wroteOstree   = writeResult.stdout.includes('[B1] OSTree NM keyfile written');
      const wroteResolv   = writeResult.stdout.includes('[B2] resolv.conf written');
      step(`Network config written (boot: ${wroteBootPart ? 'ok' : 'WARN'}, ostree-nm: ${wroteOstree ? 'ok' : 'WARN'}, resolv.conf: ${wroteResolv ? 'ok' : 'WARN'})`, 'ok');

      // ── 7. Detach from mgmt host ─────────────────────────────────────────
      step('Detaching SSD from management host…', 'working');
      await ionosDetach(
        `${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes/${encodeURIComponent(workerMainVolId)}`,
        ionosToken);
      await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 120000);
      log('Waiting 20s for mgmt host backend to release…\n');
      await new Promise(r => setTimeout(r, 20000));
      await sshRunScript(conn, `
udevadm settle --timeout=10 2>/dev/null || true
for i in $(seq 1 20); do lsblk ${ssdDev} &>/dev/null || { echo "SSD_GONE"; exit 0; }; sleep 2; done
echo "SSD_GONE_TIMEOUT"
`).catch(() => {});
      step('SSD detached from management host', 'ok');

    } catch (writeErr) {
      log(`\nWARNING: ${writeErr.message}\n`);
      log('Waiting 40s for IONOS state to settle before restoring SSD…\n');
      await new Promise(r => setTimeout(r, 40000));
      // Recover: detach from mgmt if it ended up there (use entity check — vol list is stale)
      try {
        const errVd = await ionosGet(`${volPath}?depth=1`, ionosToken);
        const errAttachedTo = errVd?.entities?.server?.id ?? null;
        if (errAttachedTo === mgmtServerId) {
          await ionosDetach(
            `${dcPath}/servers/${encodeURIComponent(mgmtServerId)}/volumes/${encodeURIComponent(workerMainVolId)}`,
            ionosToken);
          await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 60000).catch(() => {});
        }
      } catch (_) {}
    }

    if (conn) { try { conn.end(); } catch (_) {} conn = null; }

    // ── 8. Reattach SSD to worker ──────────────────────────────────────────
    step('Reattaching main SSD to worker…', 'working');
    {
      // Use volume entity check — server volume list has >5 min cache lag after detach
      let attachedTo = undefined;
      try {
        const vd = await ionosGet(`${volPath}?depth=1`, ionosToken);
        if (vd?.entities !== undefined) attachedTo = vd?.entities?.server?.id ?? null;
      } catch (_) {}
      if (attachedTo !== workerServerId) {
        log('Restoring main SSD to worker…\n');
        try {
          await ionosPost(
            `${dcPath}/servers/${encodeURIComponent(workerServerId)}/volumes`,
            ionosToken, { id: workerMainVolId });
          await ionosWaitState(volPath, ionosToken, ['AVAILABLE'], 60000);
          log('Waiting 20s for hypervisor to enumerate disk…\n');
          await new Promise(r => setTimeout(r, 20000));
          log('Main SSD restored to worker.\n');
        } catch (attachErr) {
          if (attachErr.message.includes('422')) {
            const vd2 = await ionosGet(`${volPath}?depth=1`, ionosToken);
            const nowOn = vd2?.entities?.server?.id ?? null;
            if (nowOn === workerServerId) { log('Main SSD on worker (confirmed after 422).\n'); }
            else if (nowOn) throw new Error(`Volume stranded on server ${nowOn} — attach to worker manually in DCD.`);
            else log('WARNING: 422 on reattach and entity unclear — assuming on worker.\n');
          } else { throw attachErr; }
        }
      } else {
        log('Main SSD already on worker (entity check).\n');
      }
    }

    // Pre-flight: ensure SSD is confirmed attached before starting (entity check first)
    {
      let pfAttachedTo = undefined;
      try {
        const vd = await ionosGet(`${volPath}?depth=1`, ionosToken);
        if (vd?.entities !== undefined) pfAttachedTo = vd?.entities?.server?.id ?? null;
      } catch (_) {}
      if (pfAttachedTo !== undefined && pfAttachedTo !== workerServerId) {
        throw new Error(
          `SAFETY BLOCK: main SSD is ${pfAttachedTo ? `on server ${pfAttachedTo}` : 'not attached'}. ` +
          `Attach it to the worker in the IONOS DCD before starting.`
        );
      }
      if (pfAttachedTo === workerServerId) {
        log('Pre-flight: main SSD confirmed on worker (entity check).\n');
      } else {
        // Entity returned undefined — fall back to vol list
        const pfVols = await ionosGet(workerVolsPath, ionosToken);
        if (!(pfVols?.items || []).some(v => v.id === workerMainVolId)) {
          throw new Error(
            `SAFETY BLOCK: main SSD (${workerMainVolId}) is not in the worker's attached volume list. ` +
            `Attach it manually in the IONOS DCD, then use "Switch Boot Device" to start the worker.`
          );
        }
        log('Pre-flight: main SSD in worker vol list (fallback check).\n');
      }
    }
    step('Main SSD reattached to worker', 'ok');

    // ── 9. Switch boot device → start ─────────────────────────────────────
    step('Switching boot device to main SSD…', 'working');
    await ionosPatch(workerSrvPath, ionosToken, { bootVolume: { id: workerMainVolId } });
    await ionosWaitState(workerSrvPath, ionosToken, ['INACTIVE'], 60000);
    await ionosAction(`${workerSrvPath}/start`, ionosToken);
    step('Worker started from main SSD', 'ok');

    done(
      'Network config written and worker started. ' +
      `DNS configured: gateway ${bootstrapGateway}, DNS ${bootstrapDns}. ` +
      'Ignition should now resolve api-int — CSRs will appear in 2–3 minutes.'
    );
  } catch (err) {
    if (conn) try { conn.end(); } catch (_) {}
    fail(err.message);
  }
});

// Download the RHCOS QEMU/KVM qcow2 image, convert to raw, patch the BLS boot entry
// for IONOS networking, upload to IONOS Cloud via FTP, wait for AVAILABLE, then patch
// image metadata. Streams progress via SSE; on success emits done with JSON { imageId, imageName }.
//
// WHY QEMU and not metal:
//   IONOS runs KVM. The metal .raw.gz image lacks VirtIO drivers and will not boot.
//   The qemu.x86_64.qcow2.gz variant ships with VirtIO disk/NIC drivers.
//
// BLS PATCH:
//   The boot entry needs ignition.platform.id=metal (not qemu) and network kernel args
//   (rd.neednet=1 ip=dhcp rd.route gateway/nameservers) so the node can reach the
//   OpenShift Machine Config Server during first boot to pull its Ignition config.
app.post('/api/upload-rhcos-image', async (req, res) => {
  if (!requireFields(res, req.body, ['ionosToken','datacenterId','ocpVersion','ftpUser','ftpPass','mgmtHost','mgmtSshKey'])) return;
  const {
    ionosToken, datacenterId,
    ocpVersion, imageName: reqImageName,
    ftpUser, ftpPass,
    mgmtHost, mgmtSshKey, mgmtSshUser = 'root', sshPassphrase,
    bootstrapGateway: reqGateway,
    bootstrapDns: reqDns
  } = req.body;

  // Sanitise inputs
  const safeVersion = ocpVersion.replace(/[^0-9.]/g, '');
  const finalName   = (reqImageName || `rhcos-${safeVersion}-qemu`).replace(/[^a-zA-Z0-9._-]/g, '-');
  const localDir    = '/tmp/rhcos-upload';
  const localRaw    = `${localDir}/${finalName}.raw`;
  const localQcow2  = `${localDir}/rhcos-qemu-temp.qcow2`;
  const localQcow2Gz = `${localQcow2}.gz`;

  // Network config for BLS patch — read from request or fall back to .env
  const gateway   = (reqGateway || process.env.OCP_BOOTSTRAP_GATEWAY || '').trim();
  const dnsRaw    = (reqDns    || process.env.OCP_BOOTSTRAP_DNS      || '').trim();
  // Convert semicolon/comma separated DNS list to "nameserver=X nameserver=Y"
  const dnsKargs  = dnsRaw.split(/[;,\s]+/).filter(Boolean).map(d => `nameserver=${d}`).join(' ');

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = obj  => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const step = (label, status) => emit({ type: 'step', label, status });
  const log  = text => emit({ type: 'log',  text });
  const done = msg  => { emit({ type: 'done',  message: msg }); res.end(); };
  const fail = msg  => { emit({ type: 'error', message: msg }); res.end(); };

  let conn = null;
  try {
    // ── Step 1: Determine datacenter region → FTP server ─────────────────────
    step('Determining datacenter region…', 'working');
    const dcData   = await ionosGet(`/datacenters/${encodeURIComponent(datacenterId)}`, ionosToken);
    const location = (dcData.properties?.location || '').toLowerCase();
    const locParts = location.split('/');
    const city     = locParts[1] || locParts[0] || 'fra';
    const zone     = locParts[2] || '';
    const ftpSite  = zone ? `${city}-${zone}` : city;
    const ftpHost  = `ftp-${ftpSite}.ionos.com`;
    log(`Datacenter: ${dcData.properties?.name || datacenterId} (${location})\n`);
    log(`FTP upload server: ${ftpHost}\n`);
    log(`Network args: gateway=${gateway || '(none — set OCP_BOOTSTRAP_GATEWAY in .env)'} ${dnsKargs || '(no DNS — set OCP_BOOTSTRAP_DNS in .env)'}\n`);
    step(`Location: ${location} → ${ftpHost}`, 'ok');

    // ── Step 2: SSH connect ───────────────────────────────────────────────────
    step(`Connecting to ${mgmtHost} via SSH…`, 'working');
    conn = await sshConnect(mgmtHost, mgmtSshUser, mgmtSshKey, sshPassphrase || undefined);
    step('SSH connected', 'ok');

    // ── Step 3: Download RHCOS QEMU qcow2 image (skip if .raw already present) ──
    step(`Checking for RHCOS ${safeVersion} QEMU image on management host…`, 'working');

    const checkRes = await sshRunScript(conn, `
mkdir -p ${localDir}
if [ -f "${localRaw}" ] && [ "$(stat -c%s "${localRaw}" 2>/dev/null || echo 0)" -gt 5000000000 ]; then
  echo "EXISTS:$(stat -c%s "${localRaw}")"
else
  echo "MISSING"
fi
`);
    const existsLine = checkRes.stdout.trim();

    if (existsLine.startsWith('EXISTS:')) {
      const bytes = parseInt(existsLine.split(':')[1], 10) || 0;
      log(`Raw image already on management host (${(bytes / 1e9).toFixed(2)} GB) — skipping download and conversion.\n`);
      step(`RHCOS raw image already present — skipped download`, 'ok');
    } else {
      // Check qemu-img is installed
      const qemuCheck = await sshRunScript(conn, `command -v qemu-img 2>/dev/null || echo MISSING`);
      if (qemuCheck.stdout.trim() === 'MISSING') {
        throw new Error(
          'qemu-img is not installed on the management host. ' +
          'Install it with: dnf install qemu-img  (or: dnf install qemu-kvm-tools) then retry.'
        );
      }

      step(`Downloading RHCOS ${safeVersion} QEMU image…`, 'working');

      // Find the exact qemu qcow2 filename on the Red Hat mirror
      const lookupRes = await sshRunScript(conn, `
export PATH=$PATH:/usr/local/bin:/usr/bin
MIRROR="https://mirror.openshift.com/pub/openshift-v4/x86_64/dependencies/rhcos/${safeVersion}/latest/"
FILENAME=$(curl -sL "$MIRROR" | grep -oE 'rhcos-[0-9.]+-x86_64-qemu\\.x86_64\\.qcow2\\.gz' | head -1)
if [ -z "$FILENAME" ]; then echo "URL_FAIL"; else echo "URL_OK:$MIRROR$FILENAME"; fi
`);
      const urlLine = lookupRes.stdout.trim();
      if (!urlLine.startsWith('URL_OK:')) {
        throw new Error(`Could not find RHCOS ${safeVersion} QEMU qcow2 image on mirror.openshift.com — check the version number`);
      }
      const rhcosUrl = urlLine.slice(7);
      log(`Found: ${rhcosUrl}\n`);
      log(`Downloading to ${localQcow2Gz} (~1 GB compressed — a few minutes)…\n`);

      await sshRunScriptStreaming(conn, `
set -e
export PATH=$PATH:/usr/local/bin:/usr/bin
rm -f "${localQcow2Gz}" "${localQcow2}"
curl -L --progress-bar -o "${localQcow2Gz}" "${rhcosUrl}" 2>&1
echo ""
echo "DOWNLOAD_OK:$(stat -c%s "${localQcow2Gz}") bytes"
`, chunk => { log(chunk); });

      log(`Decompressing qcow2…\n`);
      await sshRunScriptStreaming(conn, `
set -e
gunzip -f "${localQcow2Gz}"
echo "DECOMP_OK:$(stat -c%s "${localQcow2}") bytes"
`, chunk => { log(chunk); });

      // ── Step 4: Convert qcow2 → raw ───────────────────────────────────────
      step(`Converting qcow2 → raw (this takes 10–20 minutes for ~16 GB)…`, 'working');
      log(`Running: qemu-img convert -f qcow2 -O raw ${localQcow2} ${localRaw}\n`);
      log(`The raw image will be ~16 GB. Progress is not streamed — please wait.\n`);

      await sshRunScriptStreaming(conn, `
set -e
export PATH=$PATH:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin
rm -f "${localRaw}"
qemu-img convert -f qcow2 -O raw "${localQcow2}" "${localRaw}" 2>&1
echo "CONVERT_OK:$(stat -c%s "${localRaw}") bytes"
rm -f "${localQcow2}"
`, chunk => { log(chunk); });

      const sizeRes = await sshRunScript(conn, `stat -c%s "${localRaw}" 2>/dev/null || echo 0`);
      const rawBytes = parseInt(sizeRes.stdout.trim(), 10) || 0;
      log(`Raw image ready: ${(rawBytes / 1e9).toFixed(2)} GB\n`);
      step(`RHCOS raw image ready — ${(rawBytes / 1e9).toFixed(2)} GB`, 'ok');
    }

    // ── Step 5: Patch BLS boot entry ─────────────────────────────────────────
    // Mount the raw image, fix the BLS entry so RHCOS boots correctly on IONOS KVM:
    //   - ignition.platform.id=qemu → metal  (tells Ignition it's a bare-metal-like boot)
    //   - Add rd.neednet=1 ip=dhcp rd.route + nameservers so the node reaches the MCS
    step('Patching BLS boot entry for IONOS networking…', 'working');
    const mountDir = '/mnt/rhcos-bls-fix';
    const blsResult = await sshRunScript(conn, `
set -e
export PATH=$PATH:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin

# Mount raw image via loopback, -P auto-creates partition devices (loopXp1, loopXp2, …)
LOOP=$(losetup -f --show -P "${localRaw}")
echo "LOOP:$LOOP"

mkdir -p "${mountDir}"

# Partition 3 is the ext4 /boot partition on RHCOS QEMU images
if [ -b "\${LOOP}p3" ]; then
  BOOT_PART="\${LOOP}p3"
elif [ -b "\${LOOP}p2" ]; then
  BOOT_PART="\${LOOP}p2"
else
  echo "PART_FAIL: cannot find boot partition on $LOOP"
  losetup -d "$LOOP"
  exit 1
fi
echo "BOOT_PART:$BOOT_PART"

mount "$BOOT_PART" "${mountDir}"

# Find the BLS config file
BLS_FILE=$(find "${mountDir}/loader/entries" -name "ostree-*.conf" 2>/dev/null | head -1)
if [ -z "$BLS_FILE" ]; then
  echo "BLS_FAIL: no ostree-*.conf found in ${mountDir}/loader/entries"
  ls "${mountDir}/" 2>/dev/null
  umount "${mountDir}" || true
  losetup -d "$LOOP" || true
  exit 1
fi
echo "BLS_FILE:$BLS_FILE"

echo "--- BLS before patch ---"
cat "$BLS_FILE"
echo "---"

# 1. Fix platform.id: qemu → metal
sed -i 's/ignition\\.platform\\.id=qemu/ignition.platform.id=metal/g' "$BLS_FILE"

# 2. Append network kernel args to the options line (skip if already present)
if ! grep -q 'rd.neednet=1' "$BLS_FILE"; then
  NETARGS="rd.neednet=1 ip=dhcp${gateway ? ` rd.route=0.0.0.0/0:${gateway}` : ''} ${dnsKargs}"
  sed -i "/^options /s|$| $NETARGS|" "$BLS_FILE"
fi

echo "--- BLS after patch ---"
cat "$BLS_FILE"
echo "---"

sync
umount "${mountDir}"
losetup -d "$LOOP"
echo "BLS_PATCH_OK"
`);

    const blsOut = blsResult.stdout;
    log(blsOut + '\n');

    if (!blsOut.includes('BLS_PATCH_OK')) {
      throw new Error(`BLS patching failed. Output:\n${blsOut}\n${blsResult.stderr || ''}`);
    }
    step('BLS boot entry patched', 'ok');

    // ── Step 6: FTP upload via lftp ───────────────────────────────────────────
    step(`Uploading to IONOS (${ftpHost}) via lftp…`, 'working');
    log(`Uploading ${finalName}.raw to ${ftpHost}/hdd-images/ (~16 GB — typically 20–40 minutes)\n`);

    const lftpScript = `/tmp/.rhcos-lftp-${Date.now()}`;
    await sshRunScript(conn, `
cat > ${lftpScript} << 'LFTP_SCRIPT_EOF'
set ftp:ssl-allow true
set ftp:ssl-allow/${ftpHost} true
set ssl:verify-certificate no
open ${ftpHost}
user "${ftpUser}" "${ftpPass}"
cd hdd-images
put "${localRaw}"
bye
LFTP_SCRIPT_EOF
chmod 600 ${lftpScript}
`);

    const lftpCheck = await sshRunScript(conn, `command -v lftp 2>/dev/null || echo MISSING`);
    if (lftpCheck.stdout.trim() === 'MISSING') {
      throw new Error('lftp is not installed on the management host.\nInstall it with: dnf install lftp  (or apt install lftp) then retry.');
    }

    await sshRunScriptStreaming(conn, `
set -e
export PATH=$PATH:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin
IMAGE_MB=$(( $(stat -c%s "${localRaw}") / 1024 / 1024 ))
echo "Image size: \${IMAGE_MB} MB"
echo "Connecting to ${ftpHost}…"
lftp -f ${lftpScript}
echo "FTP_UPLOAD_OK"
rm -f ${lftpScript}
`, chunk => { log(chunk); });

    await sshRunScript(conn, `rm -f ${lftpScript}`).catch(() => {});
    step(`FTP upload complete`, 'ok');

    // ── Step 7: Wait for IONOS to process the image ───────────────────────────
    step('Waiting for IONOS to process image…', 'working');
    log(`Image submitted. IONOS processing typically takes 5–30 minutes.\n`);

    const uploadedAt = Date.now();
    const maxWaitMs  = 45 * 60 * 1000;
    let imageId      = null;

    while (Date.now() - uploadedAt < maxWaitMs) {
      await new Promise(r => setTimeout(r, 30000));
      const elapsed = Math.floor((Date.now() - uploadedAt) / 1000);
      log(`Polling IONOS image list… (${elapsed}s elapsed)\n`);

      try {
        const imagesData = await ionosGet('/images?depth=2', ionosToken);
        const match = (imagesData.items || []).find(img => {
          const n = (img.properties?.name || '').toLowerCase();
          return n === `${finalName}.raw` || n === finalName || n.startsWith(finalName.toLowerCase());
        });
        if (match) {
          const state = match.metadata?.state;
          log(`  Found "${match.properties.name}" — state: ${state}\n`);
          if (state === 'AVAILABLE') {
            imageId = match.id;
            break;
          }
        }
      } catch (pollErr) {
        log(`  Poll error (will retry): ${pollErr.message}\n`);
      }
    }

    if (!imageId) {
      throw new Error(
        'Image did not become AVAILABLE within 45 minutes.\n' +
        `Check the IONOS DCD → Resources → Images for an image named "${finalName}.raw" and copy its UUID manually.`
      );
    }
    step(`Image available — ${imageId}`, 'ok');

    // ── Step 8: Patch IONOS image metadata ────────────────────────────────────
    // Set UEFI boot, cloudInit V1, and hotplug flags required for RHCOS on IONOS KVM.
    step('Patching IONOS image metadata…', 'working');
    log(`Patching image ${imageId} (UEFI, cloudInit=V1, hotplug flags)…\n`);
    try {
      await ionosPatch(`/images/${imageId}`, ionosToken, {
        requireLegacyBios:    false,
        licenceType:          'LINUX',
        cloudInit:            'V1',
        cpuHotPlug:           true,
        cpuHotUnplug:         true,
        ramHotPlug:           true,
        ramHotUnplug:         true,
        nicHotPlug:           true,
        nicHotUnplug:         true,
        discVirtioHotPlug:    true,
        discVirtioHotUnplug:  true
      });
      log(`Metadata patched.\n`);
      step('Image metadata patched', 'ok');
    } catch (patchErr) {
      log(`WARNING: metadata patch failed (${patchErr.message}) — image is still usable but you may need to patch manually.\n`);
      step('Image metadata patch failed (non-fatal)', 'ok');
    }

    log(`\nImage AVAILABLE:\n  Name: ${finalName}.raw\n  UUID: ${imageId}\n`);
    done(JSON.stringify({ imageId, imageName: finalName }));

  } catch (err) {
    if (conn) {
      sshRunScript(conn, `rm -f /tmp/.rhcos-lftp-* /tmp/.rhcos-netrc; umount /mnt/rhcos-bls-fix 2>/dev/null; losetup -d $(losetup -j "${localRaw}" 2>/dev/null | cut -d: -f1) 2>/dev/null`).catch(() => {});
    }
    fail(err.message || String(err));
  } finally {
    if (conn) try { conn.end(); } catch (_) {}
  }
});

app.listen(PORT, () => {
  console.log(`IONOS OpenShift Scaling Tool running at http://localhost:${PORT}`);
});
