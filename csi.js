// IONOS Block Storage CSI driver installation for the "Install New Cluster" wizard (final phase).
//
// The manifest below is the rendered Helm chart ionoscloud-blockstorage-csi-driver 0.6.1 (driver v1.10.0,
// values: init.selinux.enabled=true, tokenSecretName=csi-secret) taken from the working ocp1 cluster, so no Helm
// is needed on the management VM. Namespace kube-system (privileged pod-security there).
// What a node needs besides the DaemonSet: /etc/ie-csi/cfg.json = {"datacenter-id": "<VDC>"} (a MachineConfig for
// the worker pool, as on ocp1) and the API token in secret kube-system/csi-secret (key "token").
'use strict';

const CSI_MANIFEST = "---\n# Source: ionoscloud-blockstorage-csi-driver/templates/serviceaccount.yaml\napiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: ionoscloud-blockstorage-csi-driver\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\nautomountServiceAccountToken: true\n---\n# Source: ionoscloud-blockstorage-csi-driver/templates/storageclass.yaml\napiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: ionos-cloud-hdd\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\n  annotations:\n    storageclass.kubernetes.io/is-default-class: \"true\"\nparameters:\n  type: HDD\n  fstype: ext4\nprovisioner: cloud.ionos.com\nvolumeBindingMode: WaitForFirstConsumer\nallowVolumeExpansion: true\n---\n# Source: ionoscloud-blockstorage-csi-driver/templates/storageclass.yaml\napiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: ionos-cloud-ssd-standard\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\n  annotations:\n    storageclass.kubernetes.io/is-default-class: \"false\"\nprovisioner: cloud.ionos.com\nparameters:\n  type: SSD Standard\n  fstype: ext4\nvolumeBindingMode: WaitForFirstConsumer\nallowVolumeExpansion: true\n---\n# Source: ionoscloud-blockstorage-csi-driver/templates/storageclass.yaml\napiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: ionos-cloud-ssd-premium\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\n  annotations:\n    storageclass.kubernetes.io/is-default-class: \"false\"\nprovisioner: cloud.ionos.com\nparameters:\n  type: SSD Premium\n  fstype: ext4\nvolumeBindingMode: WaitForFirstConsumer\nallowVolumeExpansion: true\n---\n# Source: ionoscloud-blockstorage-csi-driver/templates/rbac/clusterrole.yaml\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: ionoscloud-blockstorage-csi-driver\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\nrules:\n  - apiGroups: [\"\"]\n    resources: [\"events\"]\n    verbs: [\"get\", \"list\", \"watch\", \"create\", \"update\", \"patch\"]\n  # provisioner\n  - apiGroups: [\"\"]\n    resources: [\"secrets\"]\n    verbs: [\"get\", \"list\"]\n  - apiGroups: [\"\"]\n    resources: [\"persistentvolumes\"]\n    verbs: [\"get\", \"list\", \"watch\", \"create\", \"delete\", \"update\", \"patch\"]\n  - apiGroups: [\"\"]\n    resources: [\"persistentvolumeclaims\"]\n    verbs: [\"get\", \"list\", \"watch\", \"update\"]\n  - apiGroups: [\"\"]\n    resources: [\"persistentvolumeclaims/status\"]\n    verbs: [\"patch\"]\n  - apiGroups: [\"storage.k8s.io\"]\n    resources: [\"storageclasses\"]\n    verbs: [\"get\", \"list\", \"watch\"]\n  # attacher\n  - apiGroups: [\"\"]\n    resources: [\"nodes\"]\n    verbs: [\"get\", \"list\", \"watch\"]\n  - apiGroups: [\"storage.k8s.io\"]\n    resources: [\"csinodes\"]\n    verbs: [\"get\", \"list\", \"watch\"]\n  - apiGroups: [\"storage.k8s.io\"]\n    resources: [\"volumeattachments\"]\n    verbs: [\"get\", \"list\", \"watch\", \"update\", \"patch\"]\n  - apiGroups: [\"storage.k8s.io\"]\n    resources: [\"volumeattachments/status\"]\n    verbs: [\"patch\"]\n  # resizer\n  - apiGroups: [\"\"]\n    resources: [\"pods\"]\n    verbs: [\"get\", \"list\", \"watch\"]\n  # snapshotter\n  - apiGroups: [\"snapshot.storage.k8s.io\"]\n    resources: [\"volumesnapshotclasses\"]\n    verbs: [\"get\", \"list\", \"watch\"]\n  - apiGroups: [\"snapshot.storage.k8s.io\"]\n    resources: [\"volumesnapshotcontents\"]\n    verbs: [\"create\", \"get\", \"list\", \"watch\", \"update\", \"delete\", \"patch\"]\n  - apiGroups: [\"snapshot.storage.k8s.io\"]\n    resources: [\"volumesnapshotcontents/status\"]\n    verbs: [\"update\", \"patch\"]\n  - apiGroups: [\"snapshot.storage.k8s.io\"]\n    resources: [\"volumesnapshots\"]\n    verbs: [\"get\", \"list\", \"watch\", \"update\", \"patch\"]\n  - apiGroups: [\"snapshot.storage.k8s.io\"]\n    resources: [\"volumesnapshots/status\"]\n    verbs: [\"update\", \"patch\"]\n---\n# Source: ionoscloud-blockstorage-csi-driver/templates/rbac/clusterrolebinding.yaml\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: ionoscloud-blockstorage-csi-driver\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\nsubjects:\n  - kind: ServiceAccount\n    name: ionoscloud-blockstorage-csi-driver\n    namespace: kube-system\nroleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: ionoscloud-blockstorage-csi-driver\n---\n# Source: ionoscloud-blockstorage-csi-driver/templates/daemonset.yaml\napiVersion: apps/v1\nkind: DaemonSet\nmetadata:\n  name: ionoscloud-blockstorage-csi-driver\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\nspec:\n  updateStrategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxUnavailable: 50%\n  selector:\n    matchLabels:\n      app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n      app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n      component: node\n  template:\n    metadata:\n      labels:\n        helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n        app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n        app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n        app.kubernetes.io/version: \"v1.10.0\"\n        app.kubernetes.io/managed-by: Helm\n        component: node\n    spec:\n      automountServiceAccountToken: false\n      priorityClassName: system-node-critical\n      initContainers:\n        - name: set-selinux-context\n          image: \"registry.access.redhat.com/ubi8/ubi-minimal:latest\"\n          command:\n            - sh\n            - -c\n            - chcon -Rt container_file_t /csi\n          securityContext:\n            privileged: true\n          volumeMounts:\n            - name: socket-dir\n              mountPath: /csi\n          resources:\n            limits:\n              cpu: 50m\n              memory: 64Mi\n            requests:\n              cpu: 10m\n              memory: 16Mi\n      containers:\n        - name: driver\n          securityContext:\n            privileged: true\n            capabilities:\n              add: [\"SYS_ADMIN\"]\n            allowPrivilegeEscalation: true\n          image: \"ghcr.io/ionos-cloud/ionoscloud-blockstorage-csi-driver:v1.10.0\"\n          imagePullPolicy: IfNotPresent\n          args:\n            - --endpoint=unix:///csi/csi.sock\n            - --driver-mode=NodeServer\n            - --driver-name=cloud.ionos.com\n            - --cluster-id=k8s\n            - --metrics-endpoint=0.0.0.0:8080\n          env:\n            - name: KUBE_NODE_NAME\n              valueFrom:\n                fieldRef:\n                  fieldPath: spec.nodeName\n            - name: IONOS_TOKEN\n              valueFrom:\n                secretKeyRef:\n                  key: token\n                  name: csi-secret\n          ports:\n            - name: driver-http\n              containerPort: 8080\n          resources:\n            limits:\n              memory: 50Mi\n            requests:\n              cpu: 10m\n              memory: 25Mi\n          volumeMounts:\n            - mountPath: /csi\n              name: socket-dir\n            - name: fs-mountpoint-dir\n              mountPath: /var/lib/kubelet/pods\n              mountPropagation: \"Bidirectional\"\n            - name: block-mountpoint-dir\n              mountPath: /var/lib/kubelet/plugins/kubernetes.io/csi\n              mountPropagation: \"Bidirectional\"\n            - name: device-dir\n              mountPath: /dev\n            - name: udev-data-dir\n              mountPath: /run/udev/data\n            - name: etc-dir\n              mountPath: /etc\n        - name: node-driver-registrar\n          securityContext:\n            capabilities:\n              drop: [\"ALL\"]\n            readOnlyRootFilesystem: true\n          image: \"registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.14.0\"\n          imagePullPolicy: IfNotPresent\n          args:\n            - --csi-address=/csi/csi.sock\n            - --kubelet-registration-path=/var/lib/csi/ionoscloud-blockstorage-csi-driver/csi.sock\n          lifecycle:\n            preStop:\n              exec:\n                command: [\"/bin/sh\", \"-c\", \"rm -f /var/lib/csi/csi-driver/csi.sock\"]\n          env:\n            - name: KUBE_NODE_NAME\n              valueFrom:\n                fieldRef:\n                  fieldPath: spec.nodeName\n          resources:\n            limits:\n              memory: 30Mi\n            requests:\n              cpu: 10m\n              memory: 15Mi\n          volumeMounts:\n            - name: socket-dir\n              mountPath: /csi\n            - name: registration-dir\n              mountPath: /registration/\n      volumes:\n        - name: registration-dir\n          hostPath:\n            path: /var/lib/kubelet/plugins_registry/\n            type: DirectoryOrCreate\n        - name: socket-dir\n          hostPath:\n            path: /var/lib/csi/ionoscloud-blockstorage-csi-driver\n            type: DirectoryOrCreate\n        - name: block-mountpoint-dir\n          hostPath:\n            path: /var/lib/kubelet/plugins/kubernetes.io/csi\n            type: DirectoryOrCreate\n        - name: fs-mountpoint-dir\n          hostPath:\n            path: /var/lib/kubelet/pods\n            type: Directory\n        - name: device-dir\n          hostPath:\n            path: /dev\n            type: Directory\n        - name: udev-data-dir\n          hostPath:\n            path: /run/udev/data\n            type: Directory\n        - name: etc-dir\n          hostPath:\n            path: /etc/\n            type: Directory\n---\n# Source: ionoscloud-blockstorage-csi-driver/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ionoscloud-blockstorage-csi-driver-controller\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n      app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n      component: controller\n  template:\n    metadata:\n      labels:\n        helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n        app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n        app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n        app.kubernetes.io/version: \"v1.10.0\"\n        app.kubernetes.io/managed-by: Helm\n        component: controller\n    spec:\n      serviceAccountName: ionoscloud-blockstorage-csi-driver\n      securityContext:\n        {}\n      containers:\n        - name: driver\n          securityContext:\n            capabilities:\n              drop:\n              - ALL\n            readOnlyRootFilesystem: true\n          image: \"ghcr.io/ionos-cloud/ionoscloud-blockstorage-csi-driver:v1.10.0\"\n          imagePullPolicy: IfNotPresent\n          args:\n            - --endpoint=unix:///csi/csi.sock\n            - --driver-mode=ControllerServer\n            - --driver-name=cloud.ionos.com\n            - --cluster-id=k8s\n            - --metrics-endpoint=0.0.0.0:8080\n          env:\n            - name: IONOS_TOKEN\n              valueFrom:\n                secretKeyRef:\n                  key: token\n                  name: csi-secret\n          ports:\n            - name: driver-http\n              containerPort: 8080\n          resources:\n            limits:\n              memory: 100Mi\n            requests:\n              cpu: 10m\n              memory: 25Mi\n          volumeMounts:\n            - name: socket-dir\n              mountPath: /csi\n            - name: override-autmount\n              mountPath: /var/run/secrets/kubernetes.io/serviceaccount\n        - name: provisioner\n          securityContext:\n            capabilities:\n              drop:\n              - ALL\n            readOnlyRootFilesystem: true\n          image: \"registry.k8s.io/sig-storage/csi-provisioner:v5.3.0\"\n          imagePullPolicy: IfNotPresent\n          args:\n            - --csi-address=/csi/csi.sock\n            - --strict-topology=false\n            - --immediate-topology=false\n            - --default-fstype=ext4\n            - --timeout=930s\n          env:\n            - name: KUBE_NODE_NAME\n              valueFrom:\n                fieldRef:\n                  fieldPath: spec.nodeName\n          resources:\n            limits:\n              memory: 100Mi\n            requests:\n              cpu: 10m\n              memory: 25Mi\n          volumeMounts:\n            - name: socket-dir\n              mountPath: /csi\n        - name: attacher\n          securityContext:\n            capabilities:\n              drop:\n              - ALL\n            readOnlyRootFilesystem: true\n          image: \"registry.k8s.io/sig-storage/csi-attacher:v4.9.0\"\n          imagePullPolicy: IfNotPresent\n          args:\n            - --csi-address=/csi/csi.sock\n            - --default-fstype=ext4\n            - --timeout=270s\n          env:\n            - name: KUBE_NODE_NAME\n              valueFrom:\n                fieldRef:\n                  fieldPath: spec.nodeName\n          resources:\n            limits:\n              memory: 100Mi\n            requests:\n              cpu: 10m\n              memory: 25Mi\n          volumeMounts:\n            - name: socket-dir\n              mountPath: /csi\n        - name: resizer\n          securityContext:\n            capabilities:\n              drop:\n              - ALL\n            readOnlyRootFilesystem: true\n          image: \"registry.k8s.io/sig-storage/csi-resizer:v1.14.0\"\n          imagePullPolicy: IfNotPresent\n          args:\n            - --csi-address=/csi/csi.sock\n            - --timeout=150s\n          resources:\n            limits:\n              memory: 100Mi\n            requests:\n              cpu: 10m\n              memory: 25Mi\n          volumeMounts:\n            - name: socket-dir\n              mountPath: /csi\n        - name: snapshotter\n          securityContext:\n            capabilities:\n              drop:\n              - ALL\n            readOnlyRootFilesystem: true\n          image: \"registry.k8s.io/sig-storage/csi-snapshotter:v8.3.0\"\n          imagePullPolicy: IfNotPresent\n          args:\n            - --csi-address=/csi/csi.sock\n            - --timeout=300s\n          resources:\n            limits:\n              memory: 100Mi\n            requests:\n              cpu: 10m\n              memory: 25Mi\n          volumeMounts:\n            - name: socket-dir\n              mountPath: /csi\n        - name: snapshot-controller\n          securityContext:\n            capabilities:\n              drop:\n              - ALL\n            readOnlyRootFilesystem: true\n          image: \"registry.k8s.io/sig-storage/snapshot-controller:v8.3.0\"\n          imagePullPolicy: IfNotPresent\n          args:\n          resources:\n            limits:\n              memory: 100Mi\n            requests:\n              cpu: 10m\n              memory: 25Mi\n      volumes:\n        - name: socket-dir\n          emptyDir: {}\n        - name: override-autmount\n          emptyDir: {}\n        - name: auth-token\n          secret:\n            secretName: csi-secret\n---\n# Source: ionoscloud-blockstorage-csi-driver/templates/csidriver.yaml\napiVersion: storage.k8s.io/v1\nkind: CSIDriver\nmetadata:\n  name: cloud.ionos.com\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\nspec:\n  attachRequired: true\n  podInfoOnMount: true\n---\n# Source: ionoscloud-blockstorage-csi-driver/templates/volumesnapshotclass.yaml\napiVersion: snapshot.storage.k8s.io/v1\nkind: VolumeSnapshotClass\nmetadata:\n  name: ionos-cloud\n  annotations:\n      snapshot.storage.kubernetes.io/is-default-class: \"true\"\n  labels:\n    helm.sh/chart: ionoscloud-blockstorage-csi-driver-0.6.1\n    app.kubernetes.io/name: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/instance: ionoscloud-blockstorage-csi-driver\n    app.kubernetes.io/version: \"v1.10.0\"\n    app.kubernetes.io/managed-by: Helm\ndriver: cloud.ionos.com\ndeletionPolicy: Delete\n";
const CSI_DEFAULT_CLASS = 'ionos-cloud-ssd-standard';

const KUBECONFIG_ON_MGMT = '/opt/ocp-install/auth/kubeconfig';

function csiSecretYaml(token) {
  return `apiVersion: v1
kind: Secret
metadata:
  name: csi-secret
  namespace: kube-system
type: Opaque
data:
  token: ${Buffer.from(token).toString('base64')}
`;
}

// MachineConfig placing the node-side config file; ignition 3.2.0 works on every OCP 4.x MCO.
function csiNodeConfigYaml(role, datacenterId) {
  const b64 = Buffer.from(JSON.stringify({ 'datacenter-id': datacenterId })).toString('base64');
  return `apiVersion: machineconfiguration.openshift.io/v1
kind: MachineConfig
metadata:
  name: 99-ionos-csi-config-${role}
  labels:
    machineconfiguration.openshift.io/role: ${role}
spec:
  config:
    ignition:
      version: 3.2.0
    storage:
      files:
      - path: /etc/ie-csi/cfg.json
        mode: 420
        overwrite: true
        contents:
          source: data:text/plain;charset=utf-8;base64,${b64}
`;
}

// deps: { app, makeSseHelpers, clusterInstallState, sshConnect, sshRunScript }
function register(deps) {
  const { app, makeSseHelpers, clusterInstallState, sshConnect, sshRunScript } = deps;

  // POST /api/new-cluster/install-csi  (SSE) — idempotent (oc apply + waits).
  app.post('/api/new-cluster/install-csi', async (req, res) => {
    const b = req.body || {};
    const { clusterName } = b;
    const saved = clusterInstallState.get(clusterName) || {};
    const { step, log, done, fail } = makeSseHelpers(res);

    const mgmtHost = saved.infra?.mgmtPubIp || b.mgmtHost;
    const privKey  = b.mgmtSshPrivKey || saved.mgmtSshPrivKey;
    const dcId     = b.datacenterId || saved.infra?.dcId;
    const token    = b.ionosToken || saved.ionosToken;
    const defClass = /^ionos-cloud-(hdd|ssd-standard|ssd-premium)$/.test(b.csiDefaultClass || '') ? b.csiDefaultClass : CSI_DEFAULT_CLASS;
    const kubeconfig = b.kubeconfigPath || KUBECONFIG_ON_MGMT;

    if (!clusterName) { fail('clusterName is required.'); return; }
    if (!mgmtHost || !privKey) { fail('Missing management host or SSH key.'); return; }
    if (!dcId)  { fail('Missing datacenter (VDC) id for the node-side CSI config.'); return; }
    if (!token) { fail('The IONOS API token is required (stored as kube-system/csi-secret).'); return; }

    let conn;
    let kc = kubeconfig;
    const oc = script => sshRunScript(conn, `export KUBECONFIG=${kc}\n${script}`);
    const apply = yaml => oc(`oc apply -f - <<'MANIFEST_EOF'\n${yaml}\nMANIFEST_EOF`);
    const waitFor = async (label, cmd, okRe, timeoutSec) => {
      const deadline = Date.now() + timeoutSec * 1000;
      let n = 0;
      while (Date.now() < deadline) {
        let out = '';
        try { out = (await oc(cmd)).stdout.trim(); } catch (_) { out = ''; }
        if (okRe.test(out)) return out;
        if (n++ % 3 === 0) log(`  waiting for ${label}...\n`);
        await new Promise(r => setTimeout(r, 10000));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };

    try {
      conn = await sshConnect(mgmtHost, 'root', privKey);
      // After the TLS phase the installer kubeconfig no longer verifies; reuse the skip-verify copy when present.
      const has = await sshRunScript(conn, `[ -f /tmp/kc-skip-verify ] && echo yes || echo no`);
      if (/yes/.test(has.stdout)) kc = '/tmp/kc-skip-verify';
      await oc('oc whoami >/dev/null 2>&1 || { echo "oc cannot reach the cluster"; exit 1; }');

      step('Create the IONOS API token secret (kube-system/csi-secret)', 'running');
      await apply(csiSecretYaml(token));
      step('Create the IONOS API token secret (kube-system/csi-secret)', 'done');

      step('Write the node-side CSI config (/etc/ie-csi/cfg.json via MachineConfig)', 'running');
      await apply(csiNodeConfigYaml('worker', dcId));
      log(`  datacenter-id ${dcId} for the worker pool (new Machine API workers get it at first boot).\n`);
      step('Write the node-side CSI config (/etc/ie-csi/cfg.json via MachineConfig)', 'done');

      step('Install the IONOS Block Storage CSI driver (v1.10.0)', 'running');
      await oc(`oc apply -n kube-system -f - <<'MANIFEST_EOF'\n${CSI_MANIFEST}\nMANIFEST_EOF`);
      await waitFor('the CSI controller', `oc -n kube-system get deploy ionoscloud-blockstorage-csi-driver-controller -o jsonpath='{.status.availableReplicas}' 2>/dev/null`, /^[1-9]/, 600);
      step('Install the IONOS Block Storage CSI driver (v1.10.0)', 'done');

      step(`Set the default StorageClass (${defClass})`, 'running');
      await oc(`for sc in ionos-cloud-hdd ionos-cloud-ssd-standard ionos-cloud-ssd-premium; do
  v=false; [ "$sc" = "${defClass}" ] && v=true
  oc annotate sc $sc storageclass.kubernetes.io/is-default-class=$v --overwrite >/dev/null
done`);
      step(`Set the default StorageClass (${defClass})`, 'done');

      step('Check the CSI node plugins', 'running');
      // WaitForFirstConsumer: a pod is needed to trigger provisioning. The CSI node plugin only runs on nodes that
      // have /etc/ie-csi/cfg.json; with no Machine API workers yet that is not the case, so this check is skipped.
      const nWorkers = parseInt((await oc(`oc get nodes -l 'node-role.kubernetes.io/worker,!node-role.kubernetes.io/master' --no-headers 2>/dev/null | wc -l`)).stdout.trim(), 10) || 0;
      if (nWorkers > 0) {
        log(`  ${nWorkers} worker node(s) present: the node config rolls out via the MachineConfig Operator (one reboot per worker).\n`);
        await waitFor('the CSI node plugin on the workers', `oc -n kube-system get ds ionoscloud-blockstorage-csi-driver -o jsonpath='{.status.numberReady}' 2>/dev/null`, new RegExp('^' + nWorkers + '$'), 2400);
      }
      const ready = (await oc(`oc -n kube-system get ds ionoscloud-blockstorage-csi-driver -o jsonpath='{.status.numberReady}' 2>/dev/null`)).stdout.trim();
      if (!/^[1-9]/.test(ready)) {
        log('  CSI node plugin is not running on any node yet (no worker nodes). Volumes can be used once workers join the cluster.\n');
      } else {
        log(`  CSI node plugin ready on ${ready} node(s).\n`);
      }
      const scs = (await oc(`oc get sc --no-headers | awk '{print $1" "$2" "$3}' | grep ionos`)).stdout.trim();
      log(scs.split('\n').map(l => '  ' + l).join('\n') + '\n');
      step('Check the CSI node plugins', 'done');

      clusterInstallState.set(clusterName, { ...(clusterInstallState.get(clusterName) || saved), csiInstalled: true });
      done('IONOS CSI driver installed', { defaultClass: defClass, nodePluginsReady: ready });
    } catch (e) {
      fail(`CSI installation failed: ${e.message}`);
    } finally {
      if (conn) try { conn.end(); } catch (_) {}
    }
  });
}

module.exports = { register, CSI_MANIFEST, csiNodeConfigYaml };
