import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { HaPosture } from './config';

/**
 * Tag a SecretsManager Secret with `llmsafespaces:role=app-secret` so the
 * IRSA role used by external-secrets-operator (whose policy is scoped via
 * a ResourceTag condition) can read it.
 *
 * Subtle: `rds.DatabaseInstance.secret` returns the SecretTargetAttachment,
 * not the underlying SM Secret. The actual `CfnSecret` is at
 * `<db>/Secret/Resource`. We walk up to find it; works for both the RDS
 * pattern and a standalone secretsmanager.Secret (where defaultChild
 * already is the CfnSecret).
 */
function tagAppSecret(secret: secretsmanager.ISecret): void {
  // Try defaultChild first — works for standalone Secret constructs.
  let target = secret.node.defaultChild as cdk.CfnResource | undefined;

  // For RDS-managed secrets, .secret returns the attachment; the real
  // CfnSecret is a sibling under .secret.node.scope (the DatabaseSecret).
  if (target && target.cfnResourceType === 'AWS::SecretsManager::SecretTargetAttachment') {
    const databaseSecret = secret.node.scope;
    target = databaseSecret?.node.defaultChild as cdk.CfnResource | undefined;
  }

  if (!target || target.cfnResourceType !== 'AWS::SecretsManager::Secret') {
    throw new Error(
      `tagAppSecret: couldn't resolve CfnSecret for ${secret.node.path} ` +
      `(found ${target?.cfnResourceType ?? 'nothing'})`,
    );
  }
  cdk.Tags.of(target).add('llmsafespaces:role', 'app-secret');
}

export interface DataStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly clusterSecurityGroup: ec2.ISecurityGroup;
  readonly ha: HaPosture;
  /**
   * Enable Valkey transit encryption + AUTH token. Defaults to false
   * because lenaxia/LLMSafeSpaces#465: the chart's Redis client has no
   * TLS support. Flip when that ships.
   */
  readonly valkeyTls: boolean;
}

/**
 * Persistence layer: RDS Postgres + ElastiCache Valkey.
 *
 * Both are reachable only from the EKS cluster security group on their
 * respective ports. Sizing and HA posture are driven by `ha` props.
 */
export class DataStack extends cdk.Stack {
  public readonly postgres: rds.DatabaseInstance;
  public readonly postgresSecret: secretsmanager.ISecret;
  public readonly valkey: elasticache.CfnReplicationGroup;
  /**
   * AUTH token Secret. Only populated when `valkeyTls` is true.
   * When TLS is off, ElastiCache rejects AUTH tokens, so we don't
   * create one — callers should treat redis-password as empty in
   * that case.
   */
  public readonly valkeyAuthSecret?: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.postgres = this.buildPostgres(props);
    this.postgresSecret = this.postgres.secret!;

    // Tag the RDS-managed Secret so the IRSA role for
    // external-secrets-operator (scoped via `llmsafespaces:role=app-secret`
    // tag condition) can read it. Doing this in DataStack rather than
    // PlatformStack — cross-stack tag mutation on imported ISecrets
    // doesn't propagate. Even within the same stack, `Tags.of(ISecret)`
    // doesn't reach the underlying CfnSecret because the secret is an
    // interface ref; we need the raw L1 resource.
    tagAppSecret(this.postgresSecret);

    const valkey = this.buildValkey(props);
    this.valkey = valkey.replicationGroup;
    this.valkeyAuthSecret = valkey.authSecret;
    if (this.valkeyAuthSecret) {
      tagAppSecret(this.valkeyAuthSecret);
    }

    this.emitOutputs(props.valkeyTls);
  }

  private buildPostgres(props: DataStackProps): rds.DatabaseInstance {
    const sg = new ec2.SecurityGroup(this, 'PostgresSg', {
      vpc: props.vpc,
      description: 'RDS Postgres - EKS pods only',
      allowAllOutbound: false,
    });
    sg.addIngressRule(
      ec2.Peer.securityGroupId(props.clusterSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'EKS pods to Postgres',
    );

    return new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        // PostgresEngineVersion.of(version, majorVersion) bypasses CDK's
        // hardcoded version enum, which lags RDS by months. RDS retires
        // minor versions on a rolling schedule; pinning to a CDK enum
        // breaks new deploys when the retired version is removed.
        version: rds.PostgresEngineVersion.of('17.10', '17'),
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: props.ha.rdsMultiAz,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      credentials: rds.Credentials.fromGeneratedSecret('llmsafespaces_admin'),
      databaseName: 'llmsafespaces',
      securityGroups: [sg],
      backupRetention: cdk.Duration.days(props.ha.rdsBackupRetentionDays),
      deletionProtection: props.ha.rdsDeletionProtection,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });
  }

  private buildValkey(props: DataStackProps): {
    replicationGroup: elasticache.CfnReplicationGroup;
    authSecret?: secretsmanager.ISecret;
  } {
    const sg = new ec2.SecurityGroup(this, 'ValkeySg', {
      vpc: props.vpc,
      description: 'ElastiCache Valkey - EKS pods only',
      allowAllOutbound: false,
    });
    sg.addIngressRule(
      ec2.Peer.securityGroupId(props.clusterSecurityGroup.securityGroupId),
      ec2.Port.tcp(6379),
      'EKS pods to Valkey',
    );

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'ValkeySubnetGroup', {
      description: 'Valkey subnets (isolated)',
      subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
      cacheSubnetGroupName: cdk.Names.uniqueResourceName(this, { maxLength: 50 }).toLowerCase(),
    });

    // AUTH token only when TLS is enabled. ElastiCache rejects authToken
    // without transitEncryption. See lenaxia/LLMSafeSpaces#465 — the
    // chart's Redis client can't speak TLS yet, so we default to off.
    let authSecret: secretsmanager.ISecret | undefined;
    let authToken: string | undefined;
    if (props.valkeyTls) {
      const s = new secretsmanager.Secret(this, 'ValkeyAuthToken', {
        description: 'ElastiCache Valkey AUTH token',
        generateSecretString: {
          passwordLength: 32,
          excludePunctuation: true,
          includeSpace: false,
        },
      });
      authSecret = s;
      // Resolve at synth via dynamic reference. CFN expands this in the
      // CFN-native AuthToken field; ElastiCache reads the plaintext on
      // replication group creation. NOT exposed to K8s.
      authToken = s.secretValue.unsafeUnwrap();
    }

    const replicationGroup = new elasticache.CfnReplicationGroup(this, 'Valkey', {
      replicationGroupDescription: 'llmsafespaces Valkey',
      engine: 'valkey',
      engineVersion: '8.0',
      cacheNodeType: 'cache.t4g.micro',
      numCacheClusters: props.ha.valkeyClusters,
      automaticFailoverEnabled: props.ha.valkeyAutoFailover,
      multiAzEnabled: props.ha.valkeyAutoFailover,
      cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName!,
      securityGroupIds: [sg.securityGroupId],
      transitEncryptionEnabled: props.valkeyTls,
      atRestEncryptionEnabled: true,
      authToken,
      port: 6379,
    });
    replicationGroup.addDependency(subnetGroup);

    return { replicationGroup, authSecret };
  }

  private emitOutputs(tls: boolean): void {
    new cdk.CfnOutput(this, 'PostgresEndpoint', { value: this.postgres.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'PostgresSecretArn', {
      value: this.postgresSecret.secretArn,
      description: 'Secrets Manager ARN; JSON contains {username,password,host,port,dbname,engine}',
    });
    new cdk.CfnOutput(this, 'ValkeyPrimaryEndpoint', { value: this.valkey.attrPrimaryEndPointAddress });
    new cdk.CfnOutput(this, 'ValkeyTls', { value: tls ? 'true' : 'false' });
    if (this.valkeyAuthSecret) {
      new cdk.CfnOutput(this, 'ValkeyAuthSecretArn', { value: this.valkeyAuthSecret.secretArn });
    }
  }
}
