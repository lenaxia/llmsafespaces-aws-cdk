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
    this.installCertManager(nodeGroup);
    this.externalSecretsRole = this.installExternalSecretsOperator(nodeGroup);

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

  private installCertManager(nodeGroup: eks.Nodegroup): void {
    const chart = this.cluster.addHelmChart('CertManager', {
      chart: 'cert-manager',
      release: 'cert-manager',
      repository: 'https://charts.jetstack.io',
      namespace: 'cert-manager',
      version: 'v1.16.2',
      createNamespace: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        crds: { enabled: true },
        global: { leaderElection: { namespace: 'cert-manager' } },
      },
    });
    chart.node.addDependency(nodeGroup);
  }

  /**
   * external-secrets-operator + IRSA role used by ClusterSecretStore.
   *
   * The operator's controller pod assumes this role via IRSA; the role
   * has `secretsmanager:GetSecretValue` scoped to secrets tagged for
   * this deployment. PlatformStack creates ExternalSecret CRs that
   * reference SM secrets by ARN; the operator materializes them as
   * K8s Secrets.
   */
  private installExternalSecretsOperator(nodeGroup: eks.Nodegroup): iam.Role {
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

    // Scope read access via tag: SM secrets in PlatformStack get tagged
    // with `llmsafespaces:role=app-secret` so this role can read them
    // but not arbitrary other secrets in the account.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/llmsafespaces:role': 'app-secret',
        },
      },
    }));

    const chart = this.cluster.addHelmChart('ExternalSecrets', {
      chart: 'external-secrets',
      release: 'external-secrets',
      repository: 'https://charts.external-secrets.io',
      namespace: 'external-secrets',
      version: '0.10.5',
      createNamespace: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        installCRDs: true,
        serviceAccount: {
          annotations: {
            'eks.amazonaws.com/role-arn': role.roleArn,
          },
        },
        // Disable the bitwarden integration to shrink the install.
        bitwarden: { enabled: false },
        webhook: { create: true },
        certController: { create: true },
      },
    });
    chart.node.addDependency(nodeGroup);

    return role;
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
