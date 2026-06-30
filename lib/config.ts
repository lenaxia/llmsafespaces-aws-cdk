import { Construct } from 'constructs';

/**
 * Deployment tier — controls HA posture (NAT redundancy, RDS Multi-AZ,
 * Valkey replicas, node group sizing). Read from context as
 * `llmsafespaces:tier`.
 *
 * `mvp`     — single-AZ, smallest viable, spot capacity. ~$200/mo.
 * `prod`    — multi-AZ, multi-NAT, RDS Multi-AZ, Valkey replicated, mixed
 *             on-demand+spot capacity. ~$700/mo.
 */
export type Tier = 'mvp' | 'prod';

/**
 * Per-image OCI reference for the chart's four images. Each can be
 * either an immutable digest (`@sha256:...`) or a mutable tag.
 *
 * Digests are strongly recommended because lenaxia/LLMSafeSpaces#454
 * garbage-collects timestamp tags after some retention window.
 */
export interface ImageRefs {
  readonly api: string;
  readonly controller: string;
  readonly frontend: string;
  readonly base: string;
}

/**
 * Resolved, validated configuration for an environment.
 *
 * Construction reads CDK context (cdk.context.json or `cdk deploy -c key=val`)
 * with the prefix `llmsafespaces:*`. Defaults are MVP-tier values that
 * make sense for a personal/dev deploy.
 */
export interface ResolvedConfig {
  /** AWS account ID (12 digits). Required. */
  readonly account: string;
  /** AWS region. Defaults to us-west-2. */
  readonly region: string;
  /** Public hostname for the ALB. Required. */
  readonly hostname: string;
  /** IAM role ARN granted cluster-admin via access entry. Required. */
  readonly adminRoleArn: string;
  /** AWS CLI profile name to suggest in operator-facing output. */
  readonly awsProfile: string;
  /** Deployment tier — drives HA posture. */
  readonly tier: Tier;
  /** Image references. */
  readonly imageRefs: ImageRefs;
  /** EC2 instance type strings for the EKS node group. */
  readonly nodeInstanceTypes: readonly string[];
  /** Whether to use spot capacity for node group. */
  readonly nodeSpot: boolean;
  /**
   * Whether to enable ElastiCache Valkey transit encryption + AUTH.
   * Off by default because lenaxia/LLMSafeSpaces#465 means the chart's
   * Redis client doesn't support TLS yet. Flip when that ships upstream.
   */
  readonly valkeyTls: boolean;
}

const CTX = 'llmsafespaces:';

function required<T>(scope: Construct, key: string): T {
  const v = scope.node.tryGetContext(`${CTX}${key}`) as T | undefined;
  if (v === undefined || v === null || v === '') {
    throw new Error(
      `Missing required context value '${CTX}${key}'. ` +
      `Set it in cdk.context.json or pass --context ${CTX}${key}=<value>.`,
    );
  }
  return v;
}

function optional<T>(scope: Construct, key: string, fallback: T): T {
  const v = scope.node.tryGetContext(`${CTX}${key}`) as T | undefined;
  return v ?? fallback;
}

/**
 * Resolve configuration from CDK context for the current scope.
 *
 * Single source of truth for stack inputs. Stacks should call this
 * once and pass the result around as a prop.
 */
export function resolveConfig(scope: Construct): ResolvedConfig {
  const account = required<string>(scope, 'account');
  if (!/^\d{12}$/.test(account)) {
    throw new Error(`'${CTX}account' must be 12 digits, got '${account}'.`);
  }

  const tier = optional<Tier>(scope, 'tier', 'mvp');
  if (tier !== 'mvp' && tier !== 'prod') {
    throw new Error(`'${CTX}tier' must be 'mvp' or 'prod', got '${tier}'.`);
  }

  const adminRoleArn = required<string>(scope, 'adminRoleArn');
  if (!adminRoleArn.startsWith('arn:aws:iam::')) {
    throw new Error(`'${CTX}adminRoleArn' must be an IAM role ARN, got '${adminRoleArn}'.`);
  }

  return {
    account,
    region: optional<string>(scope, 'region', 'us-west-2'),
    hostname: required<string>(scope, 'hostname'),
    adminRoleArn,
    awsProfile: optional<string>(scope, 'awsProfile', 'default'),
    tier,
    imageRefs: optional<ImageRefs>(scope, 'imageRefs', {
      api: 'ghcr.io/lenaxia/llmsafespaces/api:ts-1782762331',
      controller: 'ghcr.io/lenaxia/llmsafespaces/controller:ts-1782762331',
      frontend: 'ghcr.io/lenaxia/llmsafespaces/frontend:ts-1782762331',
      base: 'ghcr.io/lenaxia/llmsafespaces/base:ts-1782762331',
    }),
    // 2 vCPU / 8 GiB AMD64 spot pool diversity. Used as launchTemplate
    // instance type list for spot capacity diversity (avoids
    // UnfulfillableCapacity on a single instance type).
    nodeInstanceTypes: optional<readonly string[]>(scope, 'nodeInstanceTypes', [
      'm6a.large',
      'm5a.large',
      't3a.large',
    ]),
    nodeSpot: optional<boolean>(scope, 'nodeSpot', tier === 'mvp'),
    valkeyTls: optional<boolean>(scope, 'valkeyTls', false),
  };
}

/**
 * Convenience: HA posture toggles derived from tier. Exposed as a
 * separate function so callers can override individual settings via
 * context if needed (e.g. set tier=prod but force single-AZ Valkey).
 */
export interface HaPosture {
  readonly natGatewayCount: number;
  readonly rdsMultiAz: boolean;
  readonly valkeyClusters: number;
  readonly valkeyAutoFailover: boolean;
  readonly nodeMinSize: number;
  readonly nodeMaxSize: number;
  readonly nodeDesiredSize: number;
  readonly rdsDeletionProtection: boolean;
  readonly rdsBackupRetentionDays: number;
}

export function haPostureFor(tier: Tier): HaPosture {
  if (tier === 'prod') {
    return {
      natGatewayCount: 2,
      rdsMultiAz: true,
      valkeyClusters: 2,
      valkeyAutoFailover: true,
      nodeMinSize: 3,
      nodeMaxSize: 10,
      nodeDesiredSize: 3,
      rdsDeletionProtection: true,
      rdsBackupRetentionDays: 30,
    };
  }
  return {
    natGatewayCount: 1,
    rdsMultiAz: false,
    valkeyClusters: 1,
    valkeyAutoFailover: false,
    nodeMinSize: 2,
    nodeMaxSize: 4,
    nodeDesiredSize: 2,
    rdsDeletionProtection: false,
    rdsBackupRetentionDays: 7,
  };
}
