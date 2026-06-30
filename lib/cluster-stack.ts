import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
import { Construct } from 'constructs';

export interface ClusterStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  tags?: Record<string, string>;
}

/**
 * EKS 1.32 cluster on Graviton (AL2023, cgroup v2 by default).
 *
 * Auth mode: API (access entries). The Admin role (current CLI principal)
 * is granted cluster-admin via an AccessEntry.
 *
 * gVisor (runsc) is installed on nodes via launch-template userData. AL2023
 * is used (instead of Bottlerocket) because Bottlerocket's containerd
 * config is partially immutable and runsc registration there requires a
 * privileged DaemonSet that fights the OS. AL2023's userData path is the
 * documented gVisor pattern for EKS.
 *
 * Add-ons installed here:
 *   - EBS CSI driver (workspace PVCs)
 *   - AWS Load Balancer Controller (ALB ingress)
 *   - cert-manager (chart's validating webhooks need it)
 *   - gVisor RuntimeClass `gvisor` (handler: runsc)
 */
export class ClusterStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;
  public readonly clusterSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);

    const mastersRole = new iam.Role(this, 'MastersRole', {
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Cluster-admin role for llmsafespaces EKS',
    });

    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: 'llmsafespaces',
      version: eks.KubernetesVersion.V1_32,
      kubectlLayer: new KubectlV32Layer(this, 'KubectlLayer'),
      vpc: props.vpc,
      vpcSubnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      defaultCapacity: 0,
      authenticationMode: eks.AuthenticationMode.API,
      mastersRole,
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
      ],
    });

    // ------------------------------------------------------------------
    // Node group: AMD64 spot (not Graviton).
    //
    // Switched away from Graviton (m7g.large) due to upstream image bug:
    // the chart's arm64 image variants contain x86-64 ELF binaries
    // (lenaxia/LLMSafeSpaces#462). Pods on arm64 nodes CrashLoopBackOff
    // with `exec format error`. Until that's fixed upstream, we run on
    // AMD64. Spot pricing for these AMD families is comparable to
    // Graviton.
    //
    // gVisor (runsc) is installed POST-BOOTSTRAP via the gVisorInstaller
    // DaemonSet. We download the x86_64 runsc binary now (was aarch64).
    //
    // Spot capacity diversity: 3 instance families so the scheduler can
    // satisfy capacity from whichever pool has availability.
    // ------------------------------------------------------------------
    const nodeRole = new iam.Role(this, 'NodeRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const nodeGroup = this.cluster.addNodegroupCapacity('AmdNodes', {
      instanceTypes: [
        // Multiple AMD64 families for spot capacity diversity.
        // Each spec is 2 vCPU / 8 GiB.
        new ec2.InstanceType('m6a.large'),
        new ec2.InstanceType('m5a.large'),
        new ec2.InstanceType('t3a.large'),
      ],
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      capacityType: eks.CapacityType.SPOT,
      nodeRole,
      minSize: 2,
      maxSize: 4,
      desiredSize: 2,
      diskSize: 50,
      labels: {
        workload: 'platform',
      },
    });

    this.clusterSecurityGroup = this.cluster.clusterSecurityGroup;

    // ------------------------------------------------------------------
    // gVisor installer DaemonSet + RuntimeClass.
    //
    // Strategy: the DaemonSet pod has hostPath mounts and hostPID, so it
    // can:
    //   1. Write runsc binaries into /host/usr/local/bin
    //   2. Edit /host/etc/containerd/config.toml to add the runsc handler
    //   3. nsenter into PID 1 and `systemctl restart containerd`
    //   4. sleep forever (DS pods must keep running)
    //
    // The actual install script is shipped as a ConfigMap so we don't
    // need to fight POSIX shell quoting from within a TypeScript string.
    // ------------------------------------------------------------------
    const gvisorRelease = '20260622';
    const gvisorInstallScript = [
      '#!/bin/sh',
      'set -eu',
      'if [ -f /host/usr/local/bin/runsc ] && grep -q "containerd.runtimes.runsc" /host/etc/containerd/config.toml; then',
      '  echo "[gvisor-installer] already installed; idling"',
      '  exec sleep infinity',
      'fi',
      'echo "[gvisor-installer] installing release ' + gvisorRelease + '"',
      'apk add --no-cache curl util-linux >/dev/null',
      'curl -fsSL -o /tmp/runsc https://storage.googleapis.com/gvisor/releases/release/' + gvisorRelease + '/x86_64/runsc',
      'curl -fsSL -o /tmp/containerd-shim-runsc-v1 https://storage.googleapis.com/gvisor/releases/release/' + gvisorRelease + '/x86_64/containerd-shim-runsc-v1',
      'install -m 755 /tmp/runsc /host/usr/local/bin/runsc',
      'install -m 755 /tmp/containerd-shim-runsc-v1 /host/usr/local/bin/containerd-shim-runsc-v1',
      'if ! grep -q "containerd.runtimes.runsc" /host/etc/containerd/config.toml; then',
      '  cat >> /host/etc/containerd/config.toml <<EOF',
      '',
      '[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runsc]',
      '  runtime_type = "io.containerd.runsc.v1"',
      'EOF',
      'fi',
      'echo "[gvisor-installer] restarting containerd"',
      'nsenter -t 1 -m -u -i -n -p systemctl restart containerd',
      'echo "[gvisor-installer] done; idling"',
      'exec sleep infinity',
    ].join('\n');

    const gvisorInstaller = this.cluster.addManifest('GvisorInstaller',
      // NOTE: the RuntimeClass `gvisor` is owned by the llmsafespaces
      // Helm chart (templates/runtime-class.yaml). We only ship the
      // installer DaemonSet + supporting resources here. If you deploy
      // this CDK stack WITHOUT the Helm chart, you'll also need a
      // RuntimeClass with handler `runsc` for pods to schedule on it.
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'gvisor-system' },
      },
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: 'gvisor-installer', namespace: 'gvisor-system' },
      },
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'gvisor-install-script', namespace: 'gvisor-system' },
        data: { 'install.sh': gvisorInstallScript },
      },
      {
        apiVersion: 'apps/v1',
        kind: 'DaemonSet',
        metadata: { name: 'gvisor-installer', namespace: 'gvisor-system' },
        spec: {
          selector: { matchLabels: { app: 'gvisor-installer' } },
          template: {
            metadata: { labels: { app: 'gvisor-installer' } },
            spec: {
              serviceAccountName: 'gvisor-installer',
              hostPID: true,
              tolerations: [{ operator: 'Exists' }],
              containers: [{
                name: 'installer',
                image: 'public.ecr.aws/docker/library/alpine:3.20',
                securityContext: { privileged: true },
                command: ['/bin/sh', '/scripts/install.sh'],
                volumeMounts: [
                  { name: 'host-root', mountPath: '/host' },
                  { name: 'script', mountPath: '/scripts' },
                ],
                resources: {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { cpu: '500m', memory: '256Mi' },
                },
              }],
              volumes: [
                { name: 'host-root', hostPath: { path: '/' } },
                { name: 'script', configMap: { name: 'gvisor-install-script', defaultMode: 0o755 } },
              ],
            },
          },
        },
      },
    );
    gvisorInstaller.node.addDependency(nodeGroup);

    // ------------------------------------------------------------------
    // Access entry for the Admin role (kubectl works without role-chain).
    // ------------------------------------------------------------------
    new eks.AccessEntry(this, 'MikekaoAdminAccess', {
      cluster: this.cluster,
      principal: `arn:aws:iam::${this.account}:role/Admin`,
      accessPolicies: [
        eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
          accessScopeType: eks.AccessScopeType.CLUSTER,
        }),
      ],
    });

    // ------------------------------------------------------------------
    // EBS CSI driver (managed addon).
    //
    // We create just the IAM role with the right trust + policy; the addon
    // itself creates and annotates the `ebs-csi-controller-sa` ServiceAccount
    // in kube-system. Using cluster.addServiceAccount() here collides with
    // the addon (same SA name) and fails on rollback with
    // "serviceaccounts ebs-csi-controller-sa already exists".
    // ------------------------------------------------------------------
    const ebsCsiRole = new iam.Role(this, 'EbsCsiRole', {
      assumedBy: new iam.FederatedPrincipal(
        this.cluster.openIdConnectProvider.openIdConnectProviderArn,
        {
          StringEquals: new cdk.CfnJson(this, 'EbsCsiRoleTrustCondition', {
            value: {
              [`${this.cluster.clusterOpenIdConnectIssuer}:sub`]: 'system:serviceaccount:kube-system:ebs-csi-controller-sa',
              [`${this.cluster.clusterOpenIdConnectIssuer}:aud`]: 'sts.amazonaws.com',
            },
          }),
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEBSCSIDriverPolicy'),
      ],
    });

    new eks.CfnAddon(this, 'EbsCsiAddon', {
      addonName: 'aws-ebs-csi-driver',
      clusterName: this.cluster.clusterName,
      serviceAccountRoleArn: ebsCsiRole.roleArn,
      resolveConflicts: 'OVERWRITE',
    });

    // gp3 as default StorageClass.
    this.cluster.addManifest('Gp3StorageClass', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: 'gp3',
        annotations: {
          'storageclass.kubernetes.io/is-default-class': 'true',
        },
      },
      provisioner: 'ebs.csi.aws.com',
      volumeBindingMode: 'WaitForFirstConsumer',
      reclaimPolicy: 'Delete',
      parameters: {
        type: 'gp3',
        encrypted: 'true',
      },
    });

    // Note: we used to add a manifest to flip the existing `gp2` StorageClass
    // off as default, but EKS 1.32 doesn't ship a gp2 StorageClass on
    // recent AMIs anymore, and even when it does the manifest creates a
    // CFN cycle with Gp3StorageClass (both attach to the same
    // KubectlProvider and the explicit ordering conflicts with internal
    // dependencies). The Gp3 StorageClass annotation alone is enough —
    // if a gp2 SC happens to exist post-install, run:
    //   kubectl patch storageclass gp2 -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'

    // ------------------------------------------------------------------
    // AWS Load Balancer Controller. Depends on the node group existing
    // because the controller pods need somewhere to schedule.
    // ------------------------------------------------------------------
    const albController = new eks.AlbController(this, 'AlbController', {
      cluster: this.cluster,
      version: eks.AlbControllerVersion.V2_8_2,
    });
    albController.node.addDependency(nodeGroup);

    // ------------------------------------------------------------------
    // cert-manager (required by chart's validating webhooks). Same
    // node-dependency story — install would time out on post-install
    // hooks if pods can't schedule.
    // ------------------------------------------------------------------
    const certManager = this.cluster.addHelmChart('CertManager', {
      chart: 'cert-manager',
      release: 'cert-manager',
      repository: 'https://charts.jetstack.io',
      namespace: 'cert-manager',
      version: 'v1.16.2',
      createNamespace: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        crds: { enabled: true },
        global: {
          leaderElection: { namespace: 'cert-manager' },
        },
      },
    });
    certManager.node.addDependency(nodeGroup);

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'KubectlCmd', {
      value: `aws eks update-kubeconfig --name ${this.cluster.clusterName} --region ${this.region} --profile mikekao-prod`,
      description: 'Run this to point kubectl at the cluster',
    });
  }
}
