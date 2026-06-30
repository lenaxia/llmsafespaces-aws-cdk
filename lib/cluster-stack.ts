import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
import { Construct } from 'constructs';

import { HaPosture } from './config';
import { buildGvisorInstaller } from './gvisor-installer';

export interface ClusterStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly ha: HaPosture;
  /** IAM role ARN granted cluster-admin via access entry. */
  readonly adminRoleArn: string;
  /** Instance types for the spot/on-demand node group. */
  readonly nodeInstanceTypes: readonly string[];
  /** Whether to use spot capacity for the node group. */
  readonly nodeSpot: boolean;
  /** Region for output messages. */
  readonly displayRegion: string;
  /** AWS CLI profile name (cosmetic, for the KubectlCmd output). */
  readonly awsProfile: string;
  /** Git URL of the ops-prod repo (Flux GitRepository source). */
  readonly opsRepoUrl: string;
  /** Branch / ref of the ops-prod repo. */
  readonly opsRepoBranch: string;
}

/**
 * EKS 1.32 cluster + add-ons.
 *
 * Pulls in:
 *   - Managed node group (AL2023, AMD64) with tier-driven sizing
 *   - EBS CSI driver addon (workspace PVCs) + gp3 default StorageClass
 *   - AWS Load Balancer Controller (ALB ingress)
 *   - cert-manager (chart's validating webhooks need it)
 *   - external-secrets-operator (materializes K8s Secrets from
 *     Secrets Manager — see lib/platform-stack.ts)
 *   - gVisor installer DaemonSet + RuntimeClass `gvisor`
 *
 * Why AL2023 and not Bottlerocket: gVisor install requires writes to
 * /etc/containerd/config.toml. Bottlerocket's containerd config is
 * partially immutable; AL2023's is editable. Both have cgroup v2.
 *
 * Why AMD64 and not Graviton: lenaxia/LLMSafeSpaces#462 — the chart's
 * arm64 image manifests contain x86-64 binaries. Pods on Graviton
 * CrashLoopBackOff with `exec format error`. Switch back when fixed.
 */
export class ClusterStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;
  public readonly clusterSecurityGroup: ec2.ISecurityGroup;
  /** IAM role with permission to read Secrets Manager via IRSA. */
  public readonly externalSecretsRole: iam.Role;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);

    this.cluster = this.buildCluster(props);
    this.clusterSecurityGroup = this.cluster.clusterSecurityGroup;

    const nodeGroup = this.buildNodeGroup(props);
    this.grantClusterAdmin(props.adminRoleArn);
    this.installEbsCsiDriver();
    this.installAlbController(nodeGroup);
    this.externalSecretsRole = this.buildExternalSecretsRole();
    this.installFlux(nodeGroup, props);

    const gvisorInstaller = buildGvisorInstaller(this.cluster);
    gvisorInstaller.node.addDependency(nodeGroup);

    this.emitOutputs(props);
  }

  private buildCluster(props: ClusterStackProps): eks.Cluster {
    const mastersRole = new iam.Role(this, 'MastersRole', {
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Cluster-admin role (paired with EKS API auth mode)',
    });

    return new eks.Cluster(this, 'Cluster', {
      clusterName: 'llmsafespaces',
      version: eks.KubernetesVersion.V1_32,
      kubectlLayer: new KubectlV32Layer(this, 'KubectlLayer'),
      vpc: props.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
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
  }

  private buildNodeGroup(props: ClusterStackProps): eks.Nodegroup {
    const nodeRole = new iam.Role(this, 'NodeRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    return this.cluster.addNodegroupCapacity('Nodes', {
      instanceTypes: props.nodeInstanceTypes.map((t) => new ec2.InstanceType(t)),
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      capacityType: props.nodeSpot ? eks.CapacityType.SPOT : eks.CapacityType.ON_DEMAND,
      nodeRole,
      minSize: props.ha.nodeMinSize,
      maxSize: props.ha.nodeMaxSize,
      desiredSize: props.ha.nodeDesiredSize,
      diskSize: 50,
      labels: { workload: 'platform' },
    });
  }

  private grantClusterAdmin(adminRoleArn: string): void {
    new eks.AccessEntry(this, 'AdminAccess', {
      cluster: this.cluster,
      principal: adminRoleArn,
      accessPolicies: [
        eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
          accessScopeType: eks.AccessScopeType.CLUSTER,
        }),
      ],
    });
  }

  private installEbsCsiDriver(): void {
    // The EKS managed addon creates and annotates `ebs-csi-controller-sa`
    // itself, so we just create the IAM role and hand the ARN to the
    // addon. Using cluster.addServiceAccount() would race the addon.
    const role = new iam.Role(this, 'EbsCsiRole', {
      assumedBy: new iam.FederatedPrincipal(
        this.cluster.openIdConnectProvider.openIdConnectProviderArn,
        {
          StringEquals: new cdk.CfnJson(this, 'EbsCsiRoleTrustCondition', {
            value: {
              [`${this.cluster.clusterOpenIdConnectIssuer}:sub`]:
                'system:serviceaccount:kube-system:ebs-csi-controller-sa',
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
      serviceAccountRoleArn: role.roleArn,
      resolveConflicts: 'OVERWRITE',
    });

    this.cluster.addManifest('Gp3StorageClass', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: 'gp3',
        annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
      },
      provisioner: 'ebs.csi.aws.com',
      volumeBindingMode: 'WaitForFirstConsumer',
      reclaimPolicy: 'Delete',
      parameters: { type: 'gp3', encrypted: 'true' },
    });
  }

  private installAlbController(nodeGroup: eks.Nodegroup): void {
    const controller = new eks.AlbController(this, 'AlbController', {
      cluster: this.cluster,
      version: eks.AlbControllerVersion.V2_8_2,
    });
    // The controller pods need somewhere to schedule before they can
    // accept the post-install webhook. Without this dep, CFN times out.
    controller.node.addDependency(nodeGroup);
  }

  /**
   * IRSA role for external-secrets-operator. The operator itself is
   * installed by Flux (lenaxia/llmsafespaces-ops-prod) — CDK only
   * creates the IAM role because IAM is a cloud-API resource.
   *
   * Read scope is constrained via ResourceTag: `llmsafespaces:role=app-secret`.
   * PlatformStack tags every SM secret it creates with that key/value,
   * so the operator can read them but not arbitrary other secrets in
   * the account.
   */
  private buildExternalSecretsRole(): iam.Role {
    const role = new iam.Role(this, 'ExternalSecretsRole', {
      assumedBy: new iam.FederatedPrincipal(
        this.cluster.openIdConnectProvider.openIdConnectProviderArn,
        {
          StringEquals: new cdk.CfnJson(this, 'ExternalSecretsRoleTrust', {
            value: {
              [`${this.cluster.clusterOpenIdConnectIssuer}:sub`]:
                'system:serviceaccount:external-secrets:external-secrets',
              [`${this.cluster.clusterOpenIdConnectIssuer}:aud`]: 'sts.amazonaws.com',
            },
          }),
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'IRSA role for external-secrets-operator to read Secrets Manager',
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/llmsafespaces:role': 'app-secret',
        },
      },
    }));

    return role;
  }

  /**
   * Install FluxCD pointing at lenaxia/llmsafespaces-ops-prod.
   *
   * After this lands:
   *   1. Flux is running in flux-system namespace
   *   2. GitRepository `llmsafespaces-ops` is fetching the ops repo
   *   3. Top-level `cluster` Kustomization is applied
   *   4. Flux reconciles everything under kubernetes/ continuously
   *
   * Out-of-band manual step (one time): operator must create the
   * `sops-age` Secret in flux-system from the team's age private key.
   * Without it, encrypted secrets in the ops repo can't be decrypted
   * (Flux Kustomizations stuck waiting). Documented in README.
   */
  private installFlux(nodeGroup: eks.Nodegroup, props: ClusterStackProps): void {
    // Install Flux from the published OCI manifests.
    const fluxInstall = this.cluster.addManifest('FluxNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'flux-system',
        labels: {
          'pod-security.kubernetes.io/enforce': 'baseline',
          'app.kubernetes.io/instance': 'flux-system',
          'app.kubernetes.io/part-of': 'flux',
        },
      },
    });
    fluxInstall.node.addDependency(nodeGroup);

    // Flux's own install via Helm — `fluxcd-community/flux2` chart.
    // Alternative: apply the upstream manifest from
    // github.com/fluxcd/flux2/releases/.../install.yaml, but the chart
    // handles CRD + version pinning cleaner.
    const fluxChart = this.cluster.addHelmChart('Flux', {
      chart: 'flux2',
      release: 'flux2',
      repository: 'https://fluxcd-community.github.io/helm-charts',
      namespace: 'flux-system',
      version: '2.14.1',
      createNamespace: false,
      timeout: cdk.Duration.minutes(10),
      values: {
        // Increase reconcile parallelism + API throttling. Defaults are
        // tuned for very small clusters; we expect dozens of
        // HelmReleases at steady state.
        kustomizeController: {
          extraArgs: ['--concurrent=8', '--kube-api-qps=500', '--kube-api-burst=1000'],
        },
        helmController: {
          extraArgs: ['--concurrent=8', '--kube-api-qps=500', '--kube-api-burst=1000'],
        },
        sourceController: {
          extraArgs: ['--concurrent=8', '--kube-api-qps=500', '--kube-api-burst=1000'],
        },
      },
    });
    fluxChart.node.addDependency(fluxInstall);

    // Bootstrap manifest: a GitRepository pointing at ops-prod and a
    // root Kustomization that points at kubernetes/flux/config.
    //
    // After Flux applies this, ops-prod's own kubernetes/flux/config/cluster.yaml
    // takes over as the source of truth (self-managing).
    const bootstrap = this.cluster.addManifest('FluxBootstrap',
      {
        apiVersion: 'source.toolkit.fluxcd.io/v1',
        kind: 'GitRepository',
        metadata: { name: 'llmsafespaces-ops', namespace: 'flux-system' },
        spec: {
          interval: '2m',
          url: props.opsRepoUrl,
          ref: { branch: props.opsRepoBranch },
          ignore: '/*\n!/kubernetes\n',
        },
      },
      {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'flux-system', namespace: 'flux-system' },
        spec: {
          interval: '10m',
          path: './kubernetes/flux/config',
          prune: true,
          wait: true,
          sourceRef: { kind: 'GitRepository', name: 'llmsafespaces-ops' },
          decryption: {
            provider: 'sops',
            secretRef: { name: 'sops-age' },
          },
        },
      },
    );
    bootstrap.node.addDependency(fluxChart);
  }

  private emitOutputs(props: ClusterStackProps): void {
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'KubectlCmd', {
      value: `aws eks update-kubeconfig --name ${this.cluster.clusterName} ` +
             `--region ${props.displayRegion} --profile ${props.awsProfile}`,
      description: 'Run this to point kubectl at the cluster',
    });
    new cdk.CfnOutput(this, 'ExternalSecretsRoleArn', {
      value: this.externalSecretsRole.roleArn,
    });
  }
}
