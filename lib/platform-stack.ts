import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface PlatformStackProps extends cdk.StackProps {
  readonly cluster: eks.ICluster;
  /** RDS master Secret. */
  readonly postgresSecret: secretsmanager.ISecret;
  /** Valkey AUTH token Secret (present only when valkeyTls=true). */
  readonly valkeyAuthSecret?: secretsmanager.ISecret;
  /** PostgreSQL endpoint host. */
  readonly postgresEndpoint: string;
  /** Valkey primary endpoint host. */
  readonly valkeyEndpoint: string;
  /** Hostname for the ACM cert. */
  readonly hostname: string;
  /** ARN of the IRSA role for external-secrets-operator. */
  readonly externalSecretsRoleArn: string;
  /**
   * EKS API server endpoint (host only, no scheme). Consumed by
   * Cilium's kubeProxyReplacement=true mode which needs to know the
   * apiserver directly, not via the kubernetes.default.svc address
   * it's replacing.
   */
  readonly kubernetesApiHost: string;
  /** Per-image OCI refs from context. */
  readonly imageRefs: {
    readonly api: string;
    readonly controller: string;
    readonly frontend: string;
    readonly base: string;
  };
  /**
   * Optional pre-provisioned ACM cert ARN. When set, the cert is
   * imported (no lifecycle management). When unset, a new cert is
   * created covering hostname + `grafana.hostname`.
   *
   * Why this exists: `subjectAlternativeNames` mutations force ACM
   * cert replacement, and DNS-validated replacements stall `cdk deploy`
   * indefinitely on a manual DNS step. Managing the cert out-of-band
   * (Terraform / console) makes SAN additions a no-CDK-deploy operation.
   */
  readonly certificateArn?: string;
}

const NAMESPACE = 'llmsafespaces';
const APP_SECRET_TAG = { 'llmsafespaces:role': 'app-secret' };

/**
 * App-level platform resources that need cloud APIs:
 *   - ACM cert for `hostname` (DNS validation)
 *   - The `llmsafespaces` and `flux-system` namespaces
 *   - App-secret values in AWS Secrets Manager: jwt, master, internal-token,
 *     inference-relay-secret. Stable across synths (AWS owns the random
 *     generation); rotatable via SM in-place.
 *   - A `cluster-config` ConfigMap in `flux-system` exposing all the
 *     ARNs/endpoints that the ops-prod repo's Flux postBuild needs:
 *     `${POSTGRES_HOST}`, `${ACM_CERT_ARN}`, `${EXTERNAL_SECRETS_ROLE_ARN}`,
 *     etc. This is the only state CDK passes to Flux at runtime.
 *
 * Everything that previously lived here (ClusterSecretStore, ExternalSecret,
 * Helm install of the chart) has moved to lenaxia/llmsafespaces-ops-prod
 * where Flux owns continuous reconciliation.
 */
export class PlatformStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    this.certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)
      : new acm.Certificate(this, 'Cert', {
          domainName: props.hostname,
          // Subject alt name for Grafana (and future admin/monitoring
          // subdomains). ACM covers up to 10 SANs free.
          //
          // NB: mutating this list on an existing cert forces
          // replacement + fresh DNS validation. Once the cert is
          // steady-state, promote it to out-of-band management by
          // setting `llmsafespaces:certificateArn` and CDK will import
          // instead of manage. See config.ts for the rationale.
          subjectAlternativeNames: [
            `grafana.${props.hostname}`,
          ],
          validation: acm.CertificateValidation.fromDns(),
        });

    const appSecrets = this.buildAppSecrets();
    const llmsafespacesNs = this.buildLlmsafespacesNamespace(props.cluster);
    const fluxSystemNs = this.buildFluxSystemNamespace(props.cluster);
    this.buildClusterConfig(props, appSecrets, fluxSystemNs);

    this.emitOutputs(props.hostname);
  }

  /**
   * Generate the four app-level secrets in Secrets Manager. AWS owns
   * the random generation; values are stable across synths because
   * SecretsManager itself is the source of truth (CDK only references
   * the ARN; the generated value lives in AWS forever unless the
   * Secret resource is replaced).
   *
   * Tagged with the IRSA-scoped tag so the external-secrets-operator
   * controller (in lenaxia/llmsafespaces-ops-prod) can read them.
   */
  private buildAppSecrets(): {
    jwt: secretsmanager.Secret;
    master: secretsmanager.Secret;
    internalToken: secretsmanager.Secret;
    inferenceRelay: secretsmanager.Secret;
  } {
    const make = (id: string, description: string, length: number): secretsmanager.Secret => {
      const s = new secretsmanager.Secret(this, id, {
        description,
        generateSecretString: {
          passwordLength: length,
          excludePunctuation: true,
          excludeCharacters: '/@" ',
          includeSpace: false,
          requireEachIncludedType: false,
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      for (const [k, v] of Object.entries(APP_SECRET_TAG)) {
        cdk.Tags.of(s).add(k, v);
      }
      return s;
    };

    return {
      jwt: make('JwtSecret', 'JWT signing key', 64),
      master: make('MasterSecret', 'Master encryption key', 64),
      internalToken: make('InternalToken', 'Internal API token', 32),
      inferenceRelay: make('InferenceRelaySecret', 'Inference relay secret', 32),
    };
  }

  private buildLlmsafespacesNamespace(cluster: eks.ICluster): eks.KubernetesManifest {
    return new eks.KubernetesManifest(this, 'LlmsafespacesNamespace', {
      cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: NAMESPACE,
          labels: {
            // PSA `baseline` not `restricted` until lenaxia/LLMSafeSpaces#468
            // (frontend copy-html initContainer missing capabilities.drop).
            'pod-security.kubernetes.io/enforce': 'baseline',
            'pod-security.kubernetes.io/audit': 'restricted',
            'pod-security.kubernetes.io/warn': 'restricted',
          },
        },
      }],
      overwrite: true,
      prune: false,
    });
  }

  private buildFluxSystemNamespace(cluster: eks.ICluster): eks.KubernetesManifest {
    return new eks.KubernetesManifest(this, 'FluxSystemNamespace', {
      cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: 'flux-system',
          labels: {
            'pod-security.kubernetes.io/enforce': 'baseline',
          },
        },
      }],
      overwrite: true,
      prune: false,
    });
  }

  /**
   * cluster-config ConfigMap — the contract between CDK and ops-prod.
   *
   * Every value here is consumed by a Flux postBuild substitution in
   * lenaxia/llmsafespaces-ops-prod. Adding a new key here is a public
   * API change requiring a corresponding consumer update in ops-prod.
   *
   * Lives in flux-system namespace alongside cluster-settings so a
   * single postBuild can reference both.
   */
  private buildClusterConfig(
    props: PlatformStackProps,
    appSecrets: ReturnType<PlatformStack['buildAppSecrets']>,
    namespaceDep: eks.KubernetesManifest,
  ): void {
    // Helper to split a "repo:tag" image ref into separate fields for
    // the chart's image template (which doesn't yet support digest pinning;
    // see lenaxia/LLMSafeSpaces#476).
    const splitImage = (ref: string): { repo: string; tag: string } => {
      const atIdx = ref.indexOf('@');
      if (atIdx >= 0) {
        // Digest form: repo@sha256:abc. Chart can't consume; we pass
        // repo + the digest with leading `@` stripped as a tag. (Chart
        // composes `repo:tag`, producing `repo:sha256:...` which won't
        // resolve. Operators using digest pinning need to wait for #476.)
        return { repo: ref.slice(0, atIdx), tag: ref.slice(atIdx + 1) };
      }
      const colonIdx = ref.lastIndexOf(':');
      return { repo: ref.slice(0, colonIdx), tag: ref.slice(colonIdx + 1) };
    };
    const api = splitImage(props.imageRefs.api);
    const controller = splitImage(props.imageRefs.controller);
    const frontend = splitImage(props.imageRefs.frontend);
    const base = splitImage(props.imageRefs.base);

    const cm = new eks.KubernetesManifest(this, 'ClusterConfig', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'cluster-config',
          namespace: 'flux-system',
        },
        data: {
          // Endpoints
          POSTGRES_HOST: props.postgresEndpoint,
          VALKEY_HOST: props.valkeyEndpoint,

          // Secret ARNs (referenced by ops-prod's ExternalSecret)
          POSTGRES_SECRET_ARN: props.postgresSecret.secretArn,
          JWT_SECRET_ARN: appSecrets.jwt.secretArn,
          MASTER_SECRET_ARN: appSecrets.master.secretArn,
          INTERNAL_TOKEN_ARN: appSecrets.internalToken.secretArn,
          INFERENCE_RELAY_SECRET_ARN: appSecrets.inferenceRelay.secretArn,

          // IAM
          EXTERNAL_SECRETS_ROLE_ARN: props.externalSecretsRoleArn,

          // ACM
          ACM_CERT_ARN: this.certificate.certificateArn,

          // Kubernetes API endpoint (host only) — Cilium's
          // kubeProxyReplacement=true mode needs it directly.
          KUBERNETES_API_HOST: props.kubernetesApiHost,

          // Image refs (split repo:tag for chart template compatibility)
          IMAGE_REPO_API: api.repo,
          IMAGE_TAG_API: api.tag,
          IMAGE_REPO_CONTROLLER: controller.repo,
          IMAGE_TAG_CONTROLLER: controller.tag,
          IMAGE_REPO_FRONTEND: frontend.repo,
          IMAGE_TAG_FRONTEND: frontend.tag,
          IMAGE_REPO_BASE: base.repo,
          IMAGE_TAG_BASE: base.tag,
        },
      }],
      overwrite: true,
      prune: false,
    });
    cm.node.addDependency(namespaceDep);
  }

  private emitOutputs(hostname: string): void {
    new cdk.CfnOutput(this, 'CertArn', { value: this.certificate.certificateArn });
    new cdk.CfnOutput(this, 'CertDomain', { value: hostname });
    new cdk.CfnOutput(this, 'CertValidationNote', {
      value: 'In ACM console -> the pending cert: copy the CNAME and add at your DNS provider.',
    });
    new cdk.CfnOutput(this, 'FluxBootstrapNote', {
      value: 'After cdk deploy --all completes, create the sops-age secret in flux-system. See README.',
    });
  }
}