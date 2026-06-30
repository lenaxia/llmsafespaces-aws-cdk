import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  clusterSecurityGroup: ec2.ISecurityGroup;
  tags?: Record<string, string>;
}

/**
 * RDS Postgres 16 (db.t4g.micro Graviton, single-AZ, 20 GiB gp3)
 * ElastiCache Valkey 8 (cache.t4g.micro Graviton, 1 node, single-AZ,
 *   in-transit TLS + AUTH token enabled — chart H3 requirement).
 *
 * Both reachable ONLY from the EKS cluster security group on their
 * respective ports.
 */
export class DataStack extends cdk.Stack {
  public readonly postgres: rds.DatabaseInstance;
  public readonly postgresSecret: secretsmanager.ISecret;
  public readonly valkey: elasticache.CfnReplicationGroup;
  public readonly valkeyAuthSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // RDS Postgres
    // ------------------------------------------------------------------
    const pgSg = new ec2.SecurityGroup(this, 'PostgresSg', {
      vpc: props.vpc,
      description: 'RDS Postgres - EKS pods only',
      allowAllOutbound: false,
    });
    pgSg.addIngressRule(
      ec2.Peer.securityGroupId(props.clusterSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'EKS pods to Postgres',
    );

    this.postgres = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        // 16.4 (CDK's PostgresEngineVersion.VER_16_4) was deprecated on
        // RDS by mid-2026. Construct the version manually to track what
        // RDS actually offers; this avoids needing a CDK upgrade every
        // time a minor version is retired.
        version: rds.PostgresEngineVersion.of('17.10', '17'),
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      credentials: rds.Credentials.fromGeneratedSecret('llmsafespaces_admin'),
      databaseName: 'llmsafespaces',
      securityGroups: [pgSg],
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });
    this.postgresSecret = this.postgres.secret!;

    // ------------------------------------------------------------------
    // ElastiCache Valkey 8 with TLS + AUTH token.
    //
    // The chart cache password comes from K8s Secret `llmsafespaces-credentials`
    // key `redis-password`. We'll surface this Secret via Secrets Manager and
    // wire it in PlatformStack.
    // ------------------------------------------------------------------
    const valkeySg = new ec2.SecurityGroup(this, 'ValkeySg', {
      vpc: props.vpc,
      description: 'ElastiCache Valkey - EKS pods only',
      allowAllOutbound: false,
    });
    valkeySg.addIngressRule(
      ec2.Peer.securityGroupId(props.clusterSecurityGroup.securityGroupId),
      ec2.Port.tcp(6379),
      'EKS pods to Valkey',
    );

    // AUTH token (>=16 chars, printable ASCII). Used only with TLS;
    // ElastiCache rejects authToken when transit encryption is off.
    this.valkeyAuthSecret = new secretsmanager.Secret(this, 'ValkeyAuthToken', {
      description: 'ElastiCache Valkey password placeholder (auth not enabled because TLS is off; chart redis config has no TLS support — see lenaxia/LLMSafeSpaces#465)',
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
        includeSpace: false,
      },
    });

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'ValkeySubnetGroup', {
      description: 'Valkey subnets (isolated)',
      subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
      cacheSubnetGroupName: 'llmsafespaces-valkey',
    });

    this.valkey = new elasticache.CfnReplicationGroup(this, 'Valkey', {
      replicationGroupDescription: 'llmsafespaces Valkey',
      engine: 'valkey',
      engineVersion: '8.0',
      cacheNodeType: 'cache.t4g.micro',
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      multiAzEnabled: false,
      cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName!,
      securityGroupIds: [valkeySg.securityGroupId],
      // TLS DISABLED:
      // The llmsafespaces API's Redis client config has no TLS field
      // (lenaxia/LLMSafeSpaces#465). Until that lands upstream, we must
      // run Valkey on plaintext. ElastiCache rejects AUTH tokens when
      // transit encryption is off, so password is also disabled.
      //
      // Security implication: the API caches workspace basic-auth
      // passwords in this cache. With this config, anyone with network
      // access to the cache SG could read them. The cache SG only
      // allows traffic from the cluster SG, so the practical exposure
      // is "EKS pods on this cluster can read passwords", which is the
      // same trust boundary as the API process itself. Acceptable for
      // MVP but flip TLS back on once #465 ships.
      transitEncryptionEnabled: false,
      atRestEncryptionEnabled: true,
      port: 6379,
    });
    this.valkey.addDependency(subnetGroup);

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'PostgresEndpoint', {
      value: this.postgres.dbInstanceEndpointAddress,
    });
    new cdk.CfnOutput(this, 'PostgresSecretArn', {
      value: this.postgresSecret.secretArn,
      description: 'JSON {username,password,host,port,dbname,engine}',
    });
    new cdk.CfnOutput(this, 'ValkeyPrimaryEndpoint', {
      value: this.valkey.attrPrimaryEndPointAddress,
    });
    new cdk.CfnOutput(this, 'ValkeyAuthTokenSecretArn', {
      value: this.valkeyAuthSecret.secretArn,
    });
  }
}
