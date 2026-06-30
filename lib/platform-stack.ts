import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface PlatformStackProps extends cdk.StackProps {
  cluster: eks.ICluster;
  postgres: rds.DatabaseInstance;
  postgresSecret: secretsmanager.ISecret;
  valkey: elasticache.CfnReplicationGroup;
  valkeyAuthSecret: secretsmanager.Secret;
  hostname: string;
  tags?: Record<string, string>;
}

/**
 * - ACM public cert for `hostname` (DNS validation; you create the
 *   validation CNAME at the external DNS provider).
 * - `llmsafespaces` namespace + `llmsafespaces-credentials` K8s Secret
 *   wired with the RDS password and Valkey AUTH token.
 *
 * Helm release of the chart is run manually after `cdk deploy` (the
 * chart isn't published to a Helm repo, so wiring it into CDK adds
 * complexity without much benefit on a first deploy).
 *
 * NOTE: we use eks.KubernetesManifest explicitly (instead of
 * cluster.addManifest) so the resources are owned by THIS stack
 * rather than the Cluster stack. cluster.addManifest puts the
 * manifest in the stack that defines the cluster, which would create
 * a Cluster→Data cycle since Data already depends on Cluster's SG.
 */
export class PlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const ns = 'llmsafespaces';
    const releaseName = 'llmsafespaces';
    const imageTag = 'ts-1782762331'; // verified multi-arch (linux/amd64, linux/arm64)

    // ------------------------------------------------------------------
    // ACM cert (DNS validation; you add the CNAME at your DNS provider).
    // CFN waits ~25 min for validation; if you miss that window, redeploy.
    // ------------------------------------------------------------------
    const cert = new acm.Certificate(this, 'Cert', {
      domainName: props.hostname,
      validation: acm.CertificateValidation.fromDns(),
    });

    // ------------------------------------------------------------------
    // Namespace
    // ------------------------------------------------------------------
    const namespace = new eks.KubernetesManifest(this, 'Namespace', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: ns,
          labels: {
            'pod-security.kubernetes.io/enforce': 'restricted',
            'pod-security.kubernetes.io/audit': 'restricted',
            'pod-security.kubernetes.io/warn': 'restricted',
          },
        },
      }],
      overwrite: true,
      prune: false, // don't delete the namespace if removed from stack
    });

    // ------------------------------------------------------------------
    // Credentials Secret.
    //
    // The RDS password is a CDK token (resolved at deploy time via the
    // Secrets Manager Secret created by rds.DatabaseInstance).
    // .unsafeUnwrap() bakes the *token* — not the literal value — into
    // the CFN template; CFN resolves it at deploy time to a dynamic
    // reference (`{{resolve:secretsmanager:...}}`).
    //
    // The other four secrets are generated once at synth time and stable
    // across deploys because CDK context caches them between synths.
    // ------------------------------------------------------------------
    const pgPassword = props.postgresSecret.secretValueFromJson('password').unsafeUnwrap();
    const valkeyToken = props.valkeyAuthSecret.secretValue.unsafeUnwrap();

    const credentials = new eks.KubernetesManifest(this, 'CredentialsSecret', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'llmsafespaces-credentials',
          namespace: ns,
          annotations: {
            'helm.sh/resource-policy': 'keep',
          },
        },
        type: 'Opaque',
        stringData: {
          'postgres-password': pgPassword,
          'redis-password': valkeyToken,
          'jwt-secret': generateHex(64),
          'master-secret': generateHex(64),
          'internal-token': generateHex(32),
          'inference-relay-secret': generateHex(32),
        },
      }],
      overwrite: true,
      prune: false,
    });
    credentials.node.addDependency(namespace);

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'CertArn', { value: cert.certificateArn });
    new cdk.CfnOutput(this, 'CertDomain', { value: props.hostname });
    new cdk.CfnOutput(this, 'CertValidationNote', {
      value: 'In ACM console → "DNS validation": copy the CNAME and add at your DNS provider.',
    });

    new cdk.CfnOutput(this, 'HelmInstallNamespace', { value: ns });
    new cdk.CfnOutput(this, 'HelmReleaseName', { value: releaseName });
    new cdk.CfnOutput(this, 'HelmImageTag', { value: imageTag });
    new cdk.CfnOutput(this, 'HelmInstallHint', {
      value: 'See README.md "Install the chart" section.',
    });
  }
}

/**
 * Hex string generator. Crypto-strong randomness baked into the CFN
 * template at synth time. CDK does NOT re-randomise between synths
 * because the function is called from a Stack constructor and the
 * resulting Secret resource diffs only when other fields change —
 * however, npm-clean checkouts WILL produce different values, so the
 * Secret is annotated `helm.sh/resource-policy: keep` to survive
 * `helm uninstall` and re-installs.
 *
 * For stricter ops, replace this with a secretsmanager.Secret +
 * generateSecretString in DataStack and reference the secret here.
 */
function generateHex(bytes: number): string {
  const crypto = require('crypto');
  return crypto.randomBytes(bytes).toString('hex');
}
