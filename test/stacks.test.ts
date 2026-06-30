import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';

import { NetworkStack } from '../lib/network-stack';
import { ClusterStack } from '../lib/cluster-stack';
import { DataStack } from '../lib/data-stack';
import { PlatformStack } from '../lib/platform-stack';
import { haPostureFor } from '../lib/config';

function makeApp(tier: 'mvp' | 'prod') {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-west-2' };
  const ha = haPostureFor(tier);
  const tags = { project: 'llmsafespaces', tier };

  const network = new NetworkStack(app, `${tier}-Network`, { env, tags, ha });
  const cluster = new ClusterStack(app, `${tier}-Cluster`, {
    env, tags, vpc: network.vpc, ha,
    adminRoleArn: 'arn:aws:iam::123456789012:role/Admin',
    nodeInstanceTypes: ['m6a.large', 't3a.large'],
    nodeSpot: tier === 'mvp',
    displayRegion: 'us-west-2',
    awsProfile: 'test',
    opsRepoUrl: 'https://github.com/example/ops.git',
    opsRepoBranch: 'main',
  });
  const data = new DataStack(app, `${tier}-Data`, {
    env, tags, vpc: network.vpc,
    clusterSecurityGroup: cluster.clusterSecurityGroup,
    ha, valkeyTls: false,
  });
  const platform = new PlatformStack(app, `${tier}-Platform`, {
    env, tags,
    cluster: cluster.cluster,
    postgresSecret: data.postgresSecret,
    valkeyAuthSecret: data.valkeyAuthSecret,
    postgresEndpoint: data.postgres.dbInstanceEndpointAddress,
    valkeyEndpoint: data.valkey.attrPrimaryEndPointAddress,
    hostname: 'safespaces.example.com',
    externalSecretsRoleArn: cluster.externalSecretsRole.roleArn,
    imageRefs: {
      api: 'ghcr.io/example/api:1.0.0',
      controller: 'ghcr.io/example/controller:1.0.0',
      frontend: 'ghcr.io/example/frontend:1.0.0',
      base: 'ghcr.io/example/base:1.0.0',
    },
  });

  return { network, cluster, data, platform };
}

describe('NetworkStack', () => {
  test('MVP tier has 1 NAT gateway', () => {
    const { network } = makeApp('mvp');
    const t = Template.fromStack(network);
    t.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('Prod tier has 2 NAT gateways', () => {
    const { network } = makeApp('prod');
    const t = Template.fromStack(network);
    t.resourceCountIs('AWS::EC2::NatGateway', 2);
  });

  test('Subnets are tagged for ALB discovery', () => {
    const { network } = makeApp('mvp');
    const t = Template.fromStack(network);
    t.hasResourceProperties('AWS::EC2::Subnet', {
      Tags: Match.arrayWith([
        { Key: 'kubernetes.io/role/elb', Value: '1' },
      ]),
    } as object);
  });
});

describe('DataStack', () => {
  test('MVP tier: RDS single-AZ, no deletion protection', () => {
    const { data } = makeApp('mvp');
    const t = Template.fromStack(data);
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: false,
      DeletionProtection: false,
    } as object);
  });

  test('Prod tier: RDS Multi-AZ, deletion protection on', () => {
    const { data } = makeApp('prod');
    const t = Template.fromStack(data);
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: true,
      DeletionProtection: true,
    } as object);
  });

  test('MVP tier: Valkey single node, no failover', () => {
    const { data } = makeApp('mvp');
    const t = Template.fromStack(data);
    t.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      NumCacheClusters: 1,
      AutomaticFailoverEnabled: false,
    } as object);
  });

  test('Prod tier: Valkey 2 nodes with auto-failover', () => {
    const { data } = makeApp('prod');
    const t = Template.fromStack(data);
    t.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      NumCacheClusters: 2,
      AutomaticFailoverEnabled: true,
    } as object);
  });

  test('Valkey TLS off: no AUTH token Secret created', () => {
    const { data } = makeApp('mvp');
    const t = Template.fromStack(data);
    // Only the RDS-managed secret should exist; no ValkeyAuthToken
    t.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  // Regression: rds.DatabaseInstance.secret returns the
  // SecretTargetAttachment, NOT the underlying SM Secret. The actual
  // CfnSecret lives at <db>/Secret/Resource. Tagging via the L2
  // ISecret ref's defaultChild gets the attachment, not the secret;
  // tagAppSecret() walks up via .node.scope to find the real Secret.
  // Without this, external-secrets-operator's IRSA policy denies
  // GetSecretValue on the RDS Secret because the tag condition
  // (llmsafespaces:role=app-secret) never matches.
  test('RDS Postgres Secret is tagged for IRSA access', () => {
    const { data } = makeApp('mvp');
    const t = Template.fromStack(data);
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Tags: Match.arrayWith([
        { Key: 'llmsafespaces:role', Value: 'app-secret' },
      ]),
    } as object);
  });
});

describe('ClusterStack', () => {
  test('Node group uses spot capacity at mvp tier', () => {
    const { cluster } = makeApp('mvp');
    const t = Template.fromStack(cluster);
    t.hasResourceProperties('AWS::EKS::Nodegroup', {
      CapacityType: 'SPOT',
    } as object);
  });

  test('Node group uses on-demand at prod tier', () => {
    const { cluster } = makeApp('prod');
    const t = Template.fromStack(cluster);
    t.hasResourceProperties('AWS::EKS::Nodegroup', {
      CapacityType: 'ON_DEMAND',
    } as object);
  });

  test('Node group uses AL2023 AMD64', () => {
    const { cluster } = makeApp('mvp');
    const t = Template.fromStack(cluster);
    t.hasResourceProperties('AWS::EKS::Nodegroup', {
      AmiType: 'AL2023_x86_64_STANDARD',
    } as object);
  });

  test('Admin access entry uses the configured role ARN', () => {
    const { cluster } = makeApp('mvp');
    const t = Template.fromStack(cluster);
    t.hasResourceProperties('AWS::EKS::AccessEntry', {
      PrincipalArn: 'arn:aws:iam::123456789012:role/Admin',
    } as object);
  });

  test('ExternalSecrets IRSA role has the right SA trust', () => {
    const { cluster } = makeApp('mvp');
    const t = Template.fromStack(cluster);
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: Match.anyValue(),
          }),
        ]),
      },
    } as object);
  });
});

describe('PlatformStack', () => {
  test('Generates 4 app-level secrets in Secrets Manager', () => {
    const { platform } = makeApp('mvp');
    const t = Template.fromStack(platform);
    t.resourceCountIs('AWS::SecretsManager::Secret', 4);
  });

  test('ACM cert configured for the hostname', () => {
    const { platform } = makeApp('mvp');
    const t = Template.fromStack(platform);
    t.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'safespaces.example.com',
      ValidationMethod: 'DNS',
    } as object);
  });

  test('App secrets tagged for IRSA access', () => {
    const { platform } = makeApp('mvp');
    const t = Template.fromStack(platform);
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Tags: Match.arrayWith([
        { Key: 'llmsafespaces:role', Value: 'app-secret' },
      ]),
    } as object);
  });
});

describe('Config validation', () => {
  // Quick smoke tests on resolveConfig — caught a class of bugs where
  // bad context produced no error until cdk deploy time.
  const { resolveConfig } = require('../lib/config');

  test('Rejects non-12-digit account', () => {
    const app = new cdk.App({
      context: {
        'llmsafespaces:account': '123',
        'llmsafespaces:hostname': 'x.com',
        'llmsafespaces:adminRoleArn': 'arn:aws:iam::123456789012:role/Admin',
      },
    });
    expect(() => resolveConfig(app)).toThrow(/12 digits/);
  });

  test('Rejects bad role ARN', () => {
    const app = new cdk.App({
      context: {
        'llmsafespaces:account': '123456789012',
        'llmsafespaces:hostname': 'x.com',
        'llmsafespaces:adminRoleArn': 'not-an-arn',
      },
    });
    expect(() => resolveConfig(app)).toThrow(/IAM role ARN/);
  });

  test('Rejects bad tier', () => {
    const app = new cdk.App({
      context: {
        'llmsafespaces:account': '123456789012',
        'llmsafespaces:hostname': 'x.com',
        'llmsafespaces:adminRoleArn': 'arn:aws:iam::123456789012:role/Admin',
        'llmsafespaces:tier': 'huge',
      },
    });
    expect(() => resolveConfig(app)).toThrow(/'mvp' or 'prod'/);
  });

  test('Requires hostname', () => {
    const app = new cdk.App({
      context: {
        'llmsafespaces:account': '123456789012',
        'llmsafespaces:adminRoleArn': 'arn:aws:iam::123456789012:role/Admin',
      },
    });
    expect(() => resolveConfig(app)).toThrow(/hostname/);
  });

  test('Defaults: region, profile, tier, etc.', () => {
    const app = new cdk.App({
      context: {
        'llmsafespaces:account': '123456789012',
        'llmsafespaces:hostname': 'x.com',
        'llmsafespaces:adminRoleArn': 'arn:aws:iam::123456789012:role/Admin',
      },
    });
    const c = resolveConfig(app);
    expect(c.region).toBe('us-west-2');
    expect(c.awsProfile).toBe('default');
    expect(c.tier).toBe('mvp');
    expect(c.nodeSpot).toBe(true);
    expect(c.valkeyTls).toBe(false);
  });
});
